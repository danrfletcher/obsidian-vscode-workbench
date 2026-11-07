#!/usr/bin/env python3
"""
Container-side checks for the terminal spike (ticket warkworth-37, PR-1): GP2, S2 and E7/S1 measured in the Obsidian desktop
container, with the answers read from the operating system and not from the page.

Why it exists. The host probe (terminal-spike-check.mjs) proved these on a Mac with headless Chrome. The Obsidian container run
could not repeat them because (1) the S2 extension (terminal-at-extension.cjs) acts only in a page whose own settings carry
`obsidianWorkbench.terminalPage = true`, and the container's panel-only page was built by hand without that setting, so every
request.json stayed where it was; and (2) the shell's working directory was read from the page's DOM, which does not give it.
This helper seeds the setting into the panel-only webview through that webview's own CDP target, installs the extension, writes the
request the way the plugin would (a temp file, then a rename), and reads what happened from the process table: the new shell's
cwd (readlink /proc/<pid>/cwd) and the `pwd` text, which the shell itself writes to a file.

It runs INSIDE the container (python3 and the `websockets` package are there, node is not). Nothing here is part of the plugin or of
`npm test`; the pure parts (parsing /proc, building the request, the tree print, the PASS/FAIL logic) are pinned by
tests/integration/container-terminal-check.test.ts.

  python3 container-terminal-check.py trust-plugins        --cdp http://127.0.0.1:9333
  python3 container-terminal-check.py open-page            --cdp http://127.0.0.1:9333 --vault <vault> [--pidfile <runtime>/pids.json] [--code-file <vault-relative file>] [--accept-licence]
  python3 container-terminal-check.py terminal-at          --cdp http://127.0.0.1:9333 --pidfile <runtime>/pids.json --vault <vault>
  python3 container-terminal-check.py force-quit prepare   --cdp http://127.0.0.1:9333 --pidfile <runtime>/pids.json --vault <vault>
  python3 container-terminal-check.py force-quit kill      --pidfile <runtime>/pids.json --obsidian-pid <pid>
  python3 container-terminal-check.py force-quit after     --pidfile <runtime>/pids.json

`trust-plugins`: run this first on a vault Obsidian has not been told to trust. Obsidian then opens "Do you trust the author of this
vault?" and loads NO plugin until "Trust author and enable plugins" is pressed; the plugin is listed as enabled but has no instance,
no command and no log line (the tester's T18). The mode presses the button through the Obsidian window's CDP target (falling back to
`app.plugins.setEnable(true)` and `enablePluginAndSave`) and checks the plugin's instance and commands are there.
`open-page`: opens the two pages the other modes work on. Nothing in the plugin opens a panel-only terminal page (this PR changes nothing the
user sees; the plugin's "Toggle terminal drawer" still opens the old drawer), so this mode builds the spike's page from the Obsidian
window's own CDP target: it asks the loaded plugin for its server (`ensureServer()`, which starts `code serve-web` the plugin's way, writes
the pidfile and shows the licence prompt on a first run; `--accept-licence` presses its "Accept and download"), opens a Code tab beside, and docks a `<webview>` in its own partition
(`persist:vscode-workbench-terminal-spike`, never `persist:vscode-workbench`) along the bottom of the window. Like a Code tab it loads the
server's origin first, writes the panel-only settings into that partition, then loads the workbench; the helper then opens the panel
and hides the side bar. The token is used only inside the Obsidian window; it is not printed, and not returned to this script.
`terminal-at`: leftover-server check, extension install, seed + reload of the panel-only webview, GP2 (one shell in the vault root,
terminal list on the right with two terminals), S2 (spaces, non-ASCII, missing folder: the shell's cwd and `pwd`), shot 3, and the
S1 check that a Code tab beside the page kept its layout.
`force-quit`: E7 / shot 4 in three runs: `prepare` starts an http.server and a nohup/disown process in two terminals and takes the
`ps -ef --forest` of the server tree; `kill` SIGKILLs the Obsidian process you name and takes the tree again; you start Obsidian
again (the plugin's startup runs the sweep) and `after` takes the tree a third time.

Output: PASS / FAIL / INFO lines on stdout and in <out-dir>/<mode>.txt (with a .json next to it), screenshots in <out-dir>.
Exit codes: 0 every check held, 1 a check failed, 2 it could not run (no websockets, no CDP target, no server).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

# ---------------------------------------------------------------------------------------------------------------------
# constants mirrored from the plugin and the probe (tests/integration/container-terminal-check.test.ts pins them)
# ---------------------------------------------------------------------------------------------------------------------
EXT_ID = "obsidian-vscode-workbench.terminal-at"
EXT_VERSION = "0.0.1"
EXT_DIR_NAME = f"{EXT_ID}-{EXT_VERSION}"
TERMINAL_PAGE_SETTING = "obsidianWorkbench.terminalPage"
PANEL_SETTINGS = {"workbench.panel.opensMaximized": "always", TERMINAL_PAGE_SETTING: True}
# src/workbench-db.ts
WORKBENCH_DB = {"name": "vscode-web-db", "version": 3, "store": "vscode-userdata-store", "settingsKey": "/User/settings.json"}
FOLDER_NAMES = {"spaces": "Notes folder with spaces", "unicode": "estimaté tïme 文件", "missing": "folder that does not exist"}
PARTS = [".part.titlebar", ".part.activitybar", ".part.sidebar", ".part.auxiliarybar", ".part.editor", ".part.panel", ".part.statusbar"]
# T50: the parts a press may land on to give the workbench the keyboard focus before the panel is opened: every part but the panel (the terminal)
NON_TERMINAL_PARTS = [".part.editor", ".part.sidebar", ".part.auxiliarybar", ".part.activitybar", ".part.statusbar", ".part.titlebar"]
LAYOUT_JS = (
    "(() => { const r = { win: [innerWidth, innerHeight] }; for (const sel of " + json.dumps(PARTS) + ") { const e = document.querySelector(sel); "
    "const b = e && e.getBoundingClientRect(); r[sel.slice(6)] = e ? [Math.round(b.width), Math.round(b.height)] : null; } return JSON.stringify(r); })()"
)
ENTRY_RECTS_JS = (
    "JSON.stringify([...document.querySelectorAll('.terminal-tabs-entry')].map(e => { const b = e.getBoundingClientRect(); "
    "return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; }).filter(r => r[2] > 0 && r[3] > 0))"
)
FOCUS_JS = (
    "(() => { const t = document.querySelector('.terminal-wrapper.active .xterm-helper-textarea') || document.querySelector('.xterm-helper-textarea'); "
    "if (!t) return 'no terminal'; t.focus(); return document.activeElement === t ? 'focused' : 'not focused'; })()"
)


def part_center_js(selector: str) -> str:
    """T50: where to press to give a workbench part the keyboard focus: [x, y] of the middle of that part, or null when it is absent or 0 px."""
    return (
        "(() => { const e = document.querySelector(" + json.dumps(selector) + "); if (!e) return null; const b = e.getBoundingClientRect(); "
        "if (!(b.width > 0 && b.height > 0)) return null; return JSON.stringify([Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)]); })()"
    )


PAINTED_JS = "[...document.querySelectorAll('.part.statusbar, .part.editor, .part.panel')].some((e) => e.offsetWidth > 0)"
# T38: what the page looks like to PAINTED_JS, for the report when it does not paint (the address has its token hidden here, in the page)
PAINTED_DETAIL_JS = (
    "(() => { const parts = {}; for (const sel of " + json.dumps(PARTS) + ") { const e = document.querySelector(sel); parts[sel.slice(6)] = e ? e.offsetWidth + 'x' + e.offsetHeight : null; } "
    "return JSON.stringify({ href: location.href.replace(/tkn=[^&#]*/, 'tkn=(hidden)'), title: document.title.slice(0, 60), readyState: document.readyState, "
    "painted: " + PAINTED_JS + ", parts, body: ((document.body && (document.body.innerText || document.body.textContent)) || '').replace(/\\s+/g, ' ').trim().slice(0, 160) }); })()"
)
# T44/T46: which webview is the terminal page. A target's partition is not in the CDP list, but it is in what the page can read: the panel-only
# settings are seeded into the page's own partition (IndexedDB), a Code tab's partition never has them. Read-only: a database that is not there
# is not created. Resolves to "page" | "other" | "unreadable".
PAGE_MARK_JS = """(async () => {
  try {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(__NAME__);
      r.onupgradeneeded = () => { r.transaction.abort(); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      if (!db.objectStoreNames.contains(__STORE__)) return "other";
      const raw = await new Promise((resolve, reject) => {
        const q = db.transaction(__STORE__).objectStore(__STORE__).get(__KEY__);
        q.onsuccess = () => resolve(q.result);
        q.onerror = () => reject(q.error);
      });
      if (raw === undefined) return "other";
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      return JSON.parse(text)[__SETTING__] === true ? "page" : "other";
    } finally {
      db.close();
    }
  } catch (e) {
    return (e && e.name) === "AbortError" ? "other" : "unreadable";
  }
})()"""
for _token, _value in (("__NAME__", WORKBENCH_DB["name"]), ("__STORE__", WORKBENCH_DB["store"]), ("__KEY__", WORKBENCH_DB["settingsKey"]), ("__SETTING__", TERMINAL_PAGE_SETTING)):
    PAGE_MARK_JS = PAGE_MARK_JS.replace(_token, json.dumps(_value))
PLUGIN_ID = "vscode-workbench"  # manifest.json
TRUST_BUTTON_TEXT = "Trust author and enable plugins"  # Obsidian's own wording on the trust prompt (seen in the tester's obs-state.png)
TRUST_PROMPT_RE = "trust the author"
CLICK_TRUST_JS = (
    "(() => { const b = [...document.querySelectorAll('.modal button')].find((x) => x.textContent.trim() === " + json.dumps(TRUST_BUTTON_TEXT) + "); "
    "if (!b) return 'no button'; b.click(); return 'clicked'; })()"
)
LICENCE_MODAL_TITLE = "VS Code server licence"  # src/modals.ts promptLicence: title
LICENCE_ACCEPT_TEXT = "Accept and download"  # src/modals.ts promptLicence: the Accept button
LICENCE_STATE_KEY = "__terminalSpikeAcceptLicence"  # window property holding the timer armed by accept_licence_js
# open-page: the spike's panel-only page, docked in the Obsidian window in a partition of its own (a Code tab uses persist:vscode-workbench)
PAGE_HOLDER_ID = "obsidian-workbench-terminal-spike-page"
PAGE_PARTITION = "persist:vscode-workbench-terminal-spike"
CODE_VIEW_TYPE = "vscode-workbench-code"  # src/code-view.ts VIEW_TYPE_CODE
DEFAULT_CODE_FILE = "terminal-spike-code-tab.py"  # T37: the file open-page makes in the vault for its Code tab when --code-file is not given
DEFAULT_CODE_FILE_TEXT = "# opened by tests/render/container-terminal-check.py open-page so a Code tab has a file to show\nprint('terminal spike')\n"
SHELL_NAMES = {"zsh", "bash", "sh", "dash", "fish"}
# CDP key bits: 1 alt, 2 ctrl, 4 meta, 8 shift. The container is Linux: Ctrl. (Only "toggle side bar" differs on a Mac, where the helper is tried on the host.)
CTRL, SHIFT, ALT = 2, 8, 1
SIDEBAR_MOD = 4 if sys.platform == "darwin" else CTRL


class CannotRun(Exception):
    """The helper could not run at all (exit 2): a missing package, no CDP target, no server."""


# ---------------------------------------------------------------------------------------------------------------------
# reporting
# ---------------------------------------------------------------------------------------------------------------------
class Reporter:
    """PASS / FAIL / INFO lines, kept so they can be written to the output file and counted."""

    def __init__(self, echo=True):
        self.lines: list[str] = []
        self.fails: list[str] = []
        self.passes = 0
        self.data: dict = {}
        self.echo = echo

    def _add(self, line: str) -> None:
        self.lines.append(line)
        if self.echo:
            print(line, flush=True)

    def check(self, ok: bool, what: str, detail=None) -> bool:
        self._add(f"{'PASS' if ok else 'FAIL'}  {what}" + (f"  ({detail})" if detail not in (None, "") else ""))
        if ok:
            self.passes += 1
        else:
            self.fails.append(what)
        return bool(ok)

    def info(self, text: str) -> None:
        for part in str(text).split("\n"):
            self._add(f"INFO  {part}" if part.strip() else "")

    def block(self, title: str, text: str) -> None:
        self._add(f"--- {title}")
        for part in text.rstrip("\n").split("\n"):
            self._add(part)
        self._add("---")

    def exit_code(self) -> int:
        return 1 if self.fails else 0

    def summary(self) -> str:
        return f"{self.passes} PASS, {len(self.fails)} FAIL" + ("" if not self.fails else ": " + "; ".join(self.fails))

    def write(self, out_txt: str) -> None:
        os.makedirs(os.path.dirname(os.path.abspath(out_txt)), exist_ok=True)
        with open(out_txt, "w", encoding="utf8") as f:
            f.write("\n".join(self.lines) + "\n")
        with open(out_txt + ".json", "w", encoding="utf8") as f:
            json.dump({"passes": self.passes, "fails": self.fails, "data": self.data}, f, indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------------------------------------------------
# the process table, from the operating system (the answers are read here, not from the page)
# ---------------------------------------------------------------------------------------------------------------------
def parse_stat(text: str):
    """One /proc/<pid>/stat line: `pid (comm) S ppid ...`. The command name may hold spaces and brackets, so split at the LAST ')'."""
    close = text.rfind(")")
    open_ = text.find("(")
    if close < 0 or open_ < 0:
        return None
    try:
        pid = int(text[:open_].strip())
        rest = text[close + 1:].split()
        return {"pid": pid, "comm": text[open_ + 1:close], "state": rest[0], "ppid": int(rest[1])}
    except (ValueError, IndexError):
        return None


def parse_cmdline(raw: bytes) -> list[str]:
    """/proc/<pid>/cmdline: arguments separated by NUL. Empty for a kernel thread."""
    return [a.decode("utf8", "replace") for a in raw.split(b"\0") if a != b""]


def read_proc_table(proc_root: str = "/proc") -> list[dict]:
    rows = []
    for name in os.listdir(proc_root):
        if not name.isdigit():
            continue
        try:
            with open(os.path.join(proc_root, name, "stat"), "rb") as f:
                st = parse_stat(f.read().decode("utf8", "replace"))
            with open(os.path.join(proc_root, name, "cmdline"), "rb") as f:
                args = parse_cmdline(f.read())
        except OSError:
            continue
        if st is None:
            continue
        args = args or [f"[{st['comm']}]"]
        rows.append({"pid": st["pid"], "ppid": st["ppid"], "state": st["state"], "args": args, "cmd": " ".join(args)})
    return rows


def read_ps_table() -> list[dict]:
    """Fallback where there is no /proc (a Mac, when the helper is tried on the host): the arguments arrive already joined."""
    out = subprocess.run(["ps", "-axww", "-o", "pid=,ppid=,stat=,command="], capture_output=True, text=True, check=True).stdout
    rows = []
    for line in out.split("\n"):
        m = re.match(r"^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$", line)
        if m:
            rows.append({"pid": int(m.group(1)), "ppid": int(m.group(2)), "state": m.group(3), "args": [m.group(4)], "cmd": m.group(4)})
    return rows


def read_process_table() -> list[dict]:
    return read_proc_table() if os.path.exists("/proc/self/stat") else read_ps_table()


def read_cwd(pid: int, proc_root: str = "/proc"):
    """The working directory of a process: readlink /proc/<pid>/cwd. None when it cannot be read (gone, or not your process)."""
    if os.path.isdir(proc_root):
        try:
            return os.readlink(os.path.join(proc_root, str(pid), "cwd"))
        except OSError:
            return None
    # no /proc (the host): lsof
    try:
        out = subprocess.run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"], capture_output=True, text=True).stdout
    except OSError:
        return None
    return next((ln[1:] for ln in out.split("\n") if ln.startswith("n")), None)


def same_folder(cwd, folder: str) -> bool:
    """True when the shell's cwd is the folder (symlinks resolved). A cwd that ends in ' (deleted)' is not the folder."""
    if not cwd or not os.path.exists(folder):
        return False
    if cwd.endswith(" (deleted)"):
        return False
    try:
        return os.path.realpath(cwd) == os.path.realpath(folder)
    except OSError:
        return False


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def running(rows: list[dict], pid: int) -> bool:
    """In the process table and not a zombie (a killed process nobody has reaped yet is gone for these checks)."""
    return any(r["pid"] == pid and not r["state"].startswith("Z") for r in rows)


def descendants(rows: list[dict], root: int) -> list[dict]:
    """The process and everything below it (children by ppid), parents before children."""
    by_parent: dict[int, list[dict]] = {}
    for r in rows:
        by_parent.setdefault(r["ppid"], []).append(r)
    out, seen = [], set()
    top = next((r for r in rows if r["pid"] == root), None)
    if top:
        out.append(top)
        seen.add(root)
    stack = [root]
    while stack:
        p = stack.pop(0)
        for c in sorted(by_parent.get(p, []), key=lambda r: r["pid"]):
            if c["pid"] not in seen:
                seen.add(c["pid"])
                out.append(c)
                stack.append(c["pid"])
    return out


def is_shell(row: dict) -> bool:
    return os.path.basename(row["args"][0].split(" ")[0]).lstrip("-") in SHELL_NAMES


def server_view(rows: list[dict], server_pid: int) -> dict:
    """The server's tree, its pty host, and the shells: the pty host's children that are a shell (S4: this is how a live shell is told)."""
    tree = descendants(rows, server_pid)
    pty = next((r for r in tree if "--type=ptyHost" in r["cmd"]), None)
    shells = [r for r in tree if pty and r["ppid"] == pty["pid"] and is_shell(r)]
    return {"tree": tree, "pty_host": pty, "shells": shells}


def has_server_data_dir(row: dict, data_dir: str) -> bool:
    args = row["args"]
    flag = "--server-data-dir"
    if any(args[i] == flag and i + 1 < len(args) and args[i + 1] == data_dir for i in range(len(args))):
        return True
    if f"{flag}={data_dir}" in args:
        return True
    return len(args) == 1 and f"{flag} {data_dir}" in args[0]  # the ps fallback joins the arguments


def serve_web_roots(rows: list[dict], data_dir: str) -> list[int]:
    """The top processes of every serve-web whose command line names this server data dir (a wrapper, its cli.js and the tunnel all carry it)."""
    mine = {r["pid"] for r in rows if has_server_data_dir(r, data_dir)}
    return sorted(r["pid"] for r in rows if r["pid"] in mine and r["ppid"] not in mine)


def leftover_roots(rows: list[dict], data_dir: str, server_pid: int) -> list[int]:
    """serve-web trees on the server data dir that are not the server under test: what makes request.json get taken by a host with no page."""
    own = {r["pid"] for r in descendants(rows, server_pid)}
    return [p for p in serve_web_roots(rows, data_dir) if p not in own]


def data_dir_of(row: dict):
    args = row["args"]
    for i, a in enumerate(args):
        if a == "--server-data-dir" and i + 1 < len(args):
            return args[i + 1]
        if a.startswith("--server-data-dir="):
            return a.split("=", 1)[1]
    m = re.search(r"--server-data-dir[ =](.+?)(?: --|$)", row["cmd"]) if len(args) == 1 else None
    return m.group(1) if m else None


def server_pid_from_pidfile(pidfile: str, alive=pid_alive):
    """The plugin's pidfile (<runtime>/pids.json): the live entry labelled vscode-server."""
    try:
        with open(pidfile, encoding="utf8") as f:
            entries = json.load(f)
    except (OSError, ValueError):
        return None
    for e in entries if isinstance(entries, list) else []:
        if isinstance(e, dict) and e.get("label") == "vscode-server" and isinstance(e.get("pid"), int) and alive(e["pid"]):
            return e["pid"]
    return None


# ---------------------------------------------------------------------------------------------------------------------
# the process-tree print
# ---------------------------------------------------------------------------------------------------------------------
def filter_ps_forest(text: str, pids) -> str:
    """Keep the header and the lines of `ps -ef --forest` whose PID column is in `pids`; the forest indentation in CMD stays as ps drew it."""
    keep = {int(p) for p in pids}
    out = []
    for i, line in enumerate(text.rstrip("\n").split("\n")):
        cols = line.split(None, 2)
        if i == 0 and cols[:2] == ["UID", "PID"]:
            out.append(line)
        elif len(cols) >= 2 and cols[1].isdigit() and int(cols[1]) in keep:
            out.append(line)
    return "\n".join(out) + "\n"


def render_forest(rows: list[dict], pids) -> str:
    """The same picture from the process table when `ps --forest` is not available: pid, ppid, state, indented command."""
    keep = {int(p) for p in pids}
    shown = [r for r in rows if r["pid"] in keep]
    by_pid = {r["pid"]: r for r in shown}
    kids: dict[int, list[dict]] = {}
    tops = []
    for r in sorted(shown, key=lambda r: r["pid"]):
        if r["ppid"] in by_pid:
            kids.setdefault(r["ppid"], []).append(r)
        else:
            tops.append(r)
    lines = ["   PID  PPID STAT CMD"]

    def walk(r, depth):
        branch = "\\_ " if depth else ""
        lines.append(f"{r['pid']:6d} {r['ppid']:5d} {r['state']:<4} {'  ' * depth}{branch}{r['cmd'][:150]}")
        for c in kids.get(r["pid"], []):
            walk(c, depth + 1)

    for t in tops:
        walk(t, 0)
    return "\n".join(lines) + "\n"


def ps_forest_text(rows: list[dict], pids) -> str:
    """`ps -ef --forest` restricted to the given pids, or the table rendering where ps cannot draw a forest."""
    try:
        out = subprocess.run(["ps", "-ef", "--forest"], capture_output=True, text=True)
        if out.returncode == 0 and out.stdout.strip():
            return filter_ps_forest(out.stdout, pids)
    except OSError:
        pass
    return render_forest(rows, pids)


# ---------------------------------------------------------------------------------------------------------------------
# the extension, the request, the seed
# ---------------------------------------------------------------------------------------------------------------------
def extension_manifest() -> dict:
    """The package.json the probe writes (installExtension in terminal-spike-check.mjs)."""
    return {
        "name": "terminal-at", "publisher": "obsidian-vscode-workbench", "version": EXT_VERSION, "engines": {"vscode": "^1.80.0"},
        "main": "./extension.js", "activationEvents": ["onStartupFinished"], "extensionKind": ["workspace"],
        "contributes": {"configuration": {"properties": {TERMINAL_PAGE_SETTING: {
            "type": "boolean", "default": False,
            "description": "The terminal page: the only page whose extension host opens terminals on the plugin's request.",
        }}}},
    }


def install_extension(server_data_dir: str, source_cjs: str) -> dict:
    """Write the extension into <server-data-dir>/extensions/<id>-<version>/ and register it in extensions.json (other entries are kept)."""
    ext_root = os.path.join(server_data_dir, "extensions")
    ext_dir = os.path.join(ext_root, EXT_DIR_NAME)
    os.makedirs(ext_dir, exist_ok=True)
    with open(source_cjs, encoding="utf8") as f:
        source = f.read()
    with open(os.path.join(ext_dir, "package.json"), "w", encoding="utf8") as f:
        json.dump(extension_manifest(), f)
    with open(os.path.join(ext_dir, "extension.js"), "w", encoding="utf8") as f:
        f.write(source)
    reg = os.path.join(ext_root, "extensions.json")
    try:
        with open(reg, encoding="utf8") as f:
            existing = json.load(f)
        if not isinstance(existing, list):
            existing = []
    except (OSError, ValueError):
        existing = []
    kept = [e for e in existing if not (isinstance(e, dict) and (e.get("identifier") or {}).get("id") == EXT_ID)]
    kept.append({
        "identifier": {"id": EXT_ID}, "version": EXT_VERSION, "location": {"$mid": 1, "path": ext_dir, "scheme": "file"},
        "relativeLocation": EXT_DIR_NAME, "metadata": {"installedTimestamp": 1, "pinned": True, "source": "resource"},
    })
    tmp = reg + ".tmp"
    with open(tmp, "w", encoding="utf8") as f:
        json.dump(kept, f)
    os.replace(tmp, reg)
    return {"ext_dir": ext_dir, "kept_other_entries": len(kept) - 1}


def build_request(req_id: str, cwd: str) -> dict:
    return {"id": req_id, "cwd": cwd}


def write_request(ext_dir: str, req: dict, tmp_dir: str) -> str:
    """The plugin's side of the file route: write the whole request to a temp file outside the extension's folder, then rename it in."""
    os.makedirs(tmp_dir, exist_ok=True)
    tmp = os.path.join(tmp_dir, f"request-{req['id']}.tmp")
    with open(tmp, "w", encoding="utf8") as f:
        json.dump(req, f, ensure_ascii=False)
    final = os.path.join(ext_dir, "request.json")
    os.replace(tmp, final)
    return final


def build_seed_script(settings: dict) -> str:
    """The browser-profile seed of src/settings.ts `buildBrowserSeedScript` (no user-data copy): merge `settings` into the workbench's
    /User/settings.json in IndexedDB, keeping every other key. Resolves to seeded | kept | version-mismatch | no-store | error:<name>."""
    db = WORKBENCH_DB
    script = """(async () => {
  const ours = __OURS__;
  const stores = ["vscode-userdata-store", "vscode-logs-store", "vscode-filehandles-store"];
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(__NAME__, __VERSION__);
      r.onupgradeneeded = () => { for (const s of stores) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } catch (e) {
    return e && e.name === "VersionError" ? "version-mismatch" : "error:" + ((e && e.name) || "open");
  }
  try {
    if (!db.objectStoreNames.contains(__STORE__)) return "no-store";
    const existing = await new Promise((resolve, reject) => {
      const q = db.transaction(__STORE__).objectStore(__STORE__).get(__KEY__);
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
    let merged = Object.assign({}, ours);
    if (existing !== undefined) {
      const text = typeof existing === "string" ? existing : new TextDecoder().decode(existing);
      if (text.trim() !== "") {
        let current;
        try { current = JSON.parse(text); } catch (e) { return "kept"; }
        if (current === null || typeof current !== "object" || Array.isArray(current)) return "kept";
        merged = Object.assign({}, current, ours);
      }
    }
    await new Promise((resolve, reject) => {
      const tx = db.transaction(__STORE__, "readwrite");
      const store = tx.objectStore(__STORE__);
      store.put(new TextEncoder().encode(JSON.stringify(merged, null, 2)), __KEY__);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return "seeded";
  } catch (e) {
    return "error:" + ((e && e.name) || "seed");
  } finally {
    db.close();
  }
})()"""
    for token, value in (("__OURS__", settings), ("__NAME__", db["name"]), ("__VERSION__", db["version"]), ("__STORE__", db["store"]), ("__KEY__", db["settingsKey"])):
        script = script.replace(token, json.dumps(value))
    return script


# src/trust/trust-seed.ts
TRUST_DB = {"name": "vscode-web-state-db-global-shared", "store": "ItemTable", "key": "content.trust.model.key"}
TRUST_SCHEME = "vscode-remote"


def trust_entry(authority: str, vault: str) -> dict:
    """The one entry src/trust/trust-seed.ts `trustEntryFor` writes for the vault folder: the decoded path, without a trailing slash."""
    return {"uri": {"$mid": 1, "path": re.sub(r"/+$", "", vault), "scheme": TRUST_SCHEME, "authority": authority}, "trusted": True}


TRUST_SEED_TEMPLATE = r"""(async () => {
  const entry = __ENTRY__;
  const keep = __KEEP__;
  const storeName = __STORE__;
  const key = __KEY__;
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(__DB__);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(storeName)) r.result.createObjectStore(storeName); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } catch (e) {
    return "error:" + ((e && e.name) || "open");
  }
  try {
    if (!db.objectStoreNames.contains(storeName)) return "no-store";
    const same = (a, b) => a.scheme === b.scheme && a.authority === b.authority && a.path === b.path;
    const stale = (e) => {
      const uri = e && e.uri;
      if (keep.length === 0 || !uri || uri.scheme !== entry.uri.scheme || typeof uri.authority !== "string") return false;
      const m = /^127\.0\.0\.1:(\d+)$/.exec(uri.authority);
      return m !== null && keep.indexOf(Number(m[1])) < 0;
    };
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      let outcome = "seeded";
      const q = store.get(key);
      q.onsuccess = () => {
        let model = { uriTrustInfo: [] };
        if (q.result !== undefined) {
          try { model = typeof q.result === "string" ? JSON.parse(q.result) : null; } catch (e) { model = null; }
          if (model === null || typeof model !== "object" || Array.isArray(model) || (model.uriTrustInfo !== undefined && !Array.isArray(model.uriTrustInfo))) {
            outcome = "version-mismatch";
            return;
          }
        }
        const kept = (model.uriTrustInfo || []).filter((e) => !(e && e.uri && same(e.uri, entry.uri)) && !stale(e));
        store.put(JSON.stringify(Object.assign({}, model, { uriTrustInfo: kept.concat([entry]) })), key);
      };
      q.onerror = () => reject(q.error);
      tx.oncomplete = () => resolve(outcome);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (e) {
    return "error:" + ((e && e.name) || "seed");
  } finally {
    db.close();
  }
})()"""


def trust_script_template() -> str:
    """`TRUST_SEED_TEMPLATE` with the database, store and key filled in; only the folder's entry and the ports to keep (`__ENTRY__`, `__KEEP__`)
    are left, because the server's origin is only known inside the Obsidian window."""
    script = TRUST_SEED_TEMPLATE
    for token, value in (("__STORE__", TRUST_DB["store"]), ("__KEY__", TRUST_DB["key"]), ("__DB__", TRUST_DB["name"])):
        script = script.replace(token, json.dumps(value))
    return script


def build_trust_script(entry: dict, keep=()) -> str:
    """The Workspace Trust seed of src/trust/trust-seed.ts `buildTrustSeedScript` for `entry` (a Code tab runs it before its workbench starts;
    without it the workbench asks 'Do you trust the authors?' in a modal that swallows the key presses). Same bytes as the plugin's."""
    return trust_script_template().replace("__KEEP__", json.dumps(list(keep), separators=(",", ":"))).replace("__ENTRY__", json.dumps(entry, separators=(",", ":"), ensure_ascii=False))


# ---------------------------------------------------------------------------------------------------------------------
# layout rules (the probe's)
# ---------------------------------------------------------------------------------------------------------------------
def hidden(v) -> bool:
    return v is None or v[0] == 0 or v[1] == 0


def panel_visible(layout: dict) -> bool:
    return not hidden(layout.get("panel"))


def panel_only(layout: dict) -> bool:
    """Every part but the panel measures 0 px (or is absent) and the panel fills the window (within 16 px)."""
    others = [p[6:] for p in PARTS if p != ".part.panel"]
    pan, win = layout.get("panel"), layout["win"]
    return all(hidden(layout.get(o)) for o in others) and pan is not None and pan[0] >= win[0] - 16 and pan[1] >= win[1] - 16


def layout_text(layout: dict) -> str:
    return ", ".join(f"{p[6:]} " + ("none" if layout.get(p[6:]) is None else "x".join(str(n) for n in layout[p[6:]])) for p in PARTS)


def list_on_right(rects: list, window_width: int) -> bool:
    """The terminal list (VS Code draws it from the second terminal on): at least two entries, all in the right half of the window."""
    return len(rects) >= 2 and all(r[0] > window_width / 2 for r in rects)


def redact_url(url: str) -> str:
    """A workbench URL carries the connection token (`tkn=`): it is never printed."""
    return re.sub(r"(tkn=)[^&#\s]*", r"\1(hidden)", url or "")


def pick_targets(targets: list[dict], layouts: dict, hint=None):
    """Which webview is the terminal page and which are Code tabs.
    `hint` is an index into `targets` or a substring of a target's url/title; without it the terminal page is the one webview whose layout
    is panel-only. Returns (terminal_target, code_targets) or raises CannotRun when it cannot tell."""
    if not targets:
        raise CannotRun("no workbench webview target in the CDP list (is Obsidian running with --remote-debugging-port and the page open?)")
    if hint is not None and str(hint) != "":
        if str(hint).isdigit() and int(hint) < len(targets):
            term = targets[int(hint)]
        else:
            found = [t for t in targets if str(hint) in t.get("url", "") or str(hint) in t.get("title", "")]
            if len(found) != 1:
                raise CannotRun(f"--terminal-target {hint!r} matches {len(found)} of {len(targets)} webview targets")
            term = found[0]
    else:
        only = [t for t in targets if t["id"] in layouts and panel_only(layouts[t["id"]])]
        if len(only) == 1:
            term = only[0]
        elif len(targets) == 1:
            term = targets[0]
        else:
            raise CannotRun(
                f"cannot tell which of the {len(targets)} webviews is the terminal page ({len(only)} are panel-only); pass --terminal-target <index|url part>: "
                + "; ".join(f"[{i}] {redact_url(t.get('url', ''))[:90]}" for i, t in enumerate(targets)))
    return term, [t for t in targets if t["id"] != term["id"]]


# ---------------------------------------------------------------------------------------------------------------------
# CDP
# ---------------------------------------------------------------------------------------------------------------------
def list_targets(cdp_url: str, target_type: str = "webview", opener=urllib.request.urlopen) -> list[dict]:
    """The workbench webviews of the CDP endpoint (Obsidian's --remote-debugging-port): type `webview`, served from the loopback server."""
    try:
        data = json.load(opener(cdp_url.rstrip("/") + "/json/list", timeout=10))
    except Exception as e:  # noqa: BLE001
        raise CannotRun(f"cannot read {cdp_url}/json/list: {e}")
    return [t for t in data if t.get("type") == target_type and re.match(r"^https?://(127\.0\.0\.1|localhost)[:/]", t.get("url", ""))
            and "vscode-webview" not in t.get("url", "")]


def obsidian_window_targets(cdp_url: str, opener=urllib.request.urlopen) -> list[dict]:
    """Obsidian's own windows (CDP type `page`, served from app://obsidian.md), as opposed to the workbench webviews."""
    try:
        data = json.load(opener(cdp_url.rstrip("/") + "/json/list", timeout=10))
    except Exception as e:  # noqa: BLE001
        raise CannotRun(f"cannot read {cdp_url}/json/list: {e}")
    return [t for t in data if t.get("type") == "page" and t.get("url", "").startswith("app://obsidian.md")]


def plugin_state_js(plugin_id: str) -> str:
    """Reads, from the Obsidian window: is the trust prompt up, is community-plugin loading switched off, is the plugin loaded, how many commands it registered."""
    pid = json.dumps(plugin_id)
    return (
        "(() => { const p = window.app && window.app.plugins; "
        "const modal = [...document.querySelectorAll('.modal')].some((m) => new RegExp(" + json.dumps(TRUST_PROMPT_RE) + ", 'i').test(m.innerText)); "
        "const cmds = window.app && window.app.commands ? Object.keys(window.app.commands.commands).filter((k) => k.startsWith(" + pid + " + ':')).length : 0; "
        "return JSON.stringify({ app: !!window.app, modal, "
        "restricted: p && typeof p.isEnabled === 'function' ? !p.isEnabled() : null, "
        "enabled: !!(p && p.enabledPlugins && p.enabledPlugins.has(" + pid + ")), "
        "loaded: !!(p && p.plugins && p.plugins[" + pid + "]), commands: cmds }); })()"
    )


def enable_plugin_js(plugin_id: str) -> str:
    return "(async () => { await window.app.plugins.setEnable(true); await window.app.plugins.enablePluginAndSave(" + json.dumps(plugin_id) + "); return 'enabled'; })()"


def plugin_loaded(state) -> bool:
    return bool(state) and state.get("loaded") is True and state.get("commands", 0) > 0 and not state.get("modal")


def accept_licence_js(deadline_ms: int, every_ms: int = 500) -> str:
    """T34: arm, inside the Obsidian window, a timer that presses "Accept and download" on the plugin's "VS Code server licence" modal
    (src/modals.ts promptLicence) when it shows up, and stops itself after `deadline_ms`. It is a timer in the window, not a loop in this
    script, because the modal opens while the Code tab command and `ensureServer()` are still waiting on it. Returns 'armed' (or
    'already armed'). Nothing else is clicked: the button is found inside the modal whose text names the licence."""
    return (
        "(() => { const K = " + json.dumps(LICENCE_STATE_KEY) + "; if (window[K]) return 'already armed'; "
        "const st = { pressed: 0, timer: null }; window[K] = st; "
        "st.timer = setInterval(() => { "
        "const modal = [...document.querySelectorAll('.modal')].find((m) => (m.textContent || '').includes(" + json.dumps(LICENCE_MODAL_TITLE) + ")); "
        "const b = modal && [...modal.querySelectorAll('button')].find((x) => x.textContent.trim() === " + json.dumps(LICENCE_ACCEPT_TEXT) + "); "
        "if (b) { b.click(); st.pressed += 1; } }, " + str(int(every_ms)) + "); "
        "setTimeout(() => clearInterval(st.timer), " + str(int(deadline_ms)) + "); return 'armed'; })()"
    )


def disarm_licence_js() -> str:
    """Stops the timer `accept_licence_js` armed and returns JSON: was it armed, and how many times it pressed the button."""
    return (
        "(() => { const K = " + json.dumps(LICENCE_STATE_KEY) + "; const st = window[K]; "
        "if (!st) return JSON.stringify({ armed: false, pressed: 0 }); clearInterval(st.timer); delete window[K]; "
        "return JSON.stringify({ armed: true, pressed: st.pressed }); })()"
    )


def open_code_tab_js(plugin_id: str, file=None) -> str:
    """Open a Code tab from the Obsidian window. With a vault-relative `file`: a new tab in the plugin's view type, the way Obsidian restores one.
    Without (T37): the helper's own file `DEFAULT_CODE_FILE`, made in the vault if it is not there and opened through the plugin's
    `openCodeFile` (the guard, the licence and the server start included). The plugin's `open-spike-file` command is not used: with no
    code file in the vault it only shows a notice and opens no tab, which is what a clean container vault is."""
    if file:
        return ("(async () => { const leaf = window.app.workspace.getLeaf('tab'); await leaf.setViewState({ type: " + json.dumps(CODE_VIEW_TYPE)
                + ", state: { file: " + json.dumps(file) + " }, active: true }); return 'opened'; })()")
    return (
        "(async () => { const app = window.app; const plugin = app && app.plugins && app.plugins.plugins && app.plugins.plugins[" + json.dumps(plugin_id) + "]; "
        "if (!plugin || typeof plugin.openCodeFile !== 'function') return 'no plugin'; "
        "const path = " + json.dumps(DEFAULT_CODE_FILE) + "; "
        "if (!app.vault.getAbstractFileByPath(path)) await app.vault.create(path, " + json.dumps(DEFAULT_CODE_FILE_TEXT) + "); "
        "await plugin.openCodeFile(path); return 'opened'; })()"
    )


def open_page_js(plugin_id: str, vault: str, seed_script: str, ready_ms: int = 30000, server_ms: int = 180000, trust_template: str | None = None) -> str:
    """Runs in the Obsidian window. Asks the loaded plugin for its server, docks a <webview> in a partition of its own along the bottom
    of the window and, the way a Code tab does (src/code-view.ts loadWorkbench), loads the server's origin, runs `seed_script` in it once
    `dom-ready` fires, then points it at the workbench (folder = the vault). Resolves to a JSON string: status, seed outcome, partition.
    With `trust_template` (`trust_script_template()`), the vault folder's Workspace Trust record is written in the same page right after the
    settings, as a Code tab does (T37); the result then carries `trust`. The token is used here, in the window, and is in no returned value."""
    return (
        """(async () => {
  const PLUGIN = __PLUGIN__, VAULT = __VAULT__, HOLDER = __HOLDER__, PARTITION = __PARTITION__, SEED = __SEED__, TRUST = __TRUST__;
  const out = (o) => JSON.stringify(o);
  const plugin = window.app && window.app.plugins && window.app.plugins.plugins && window.app.plugins.plugins[PLUGIN];
  if (!plugin || typeof plugin.ensureServer !== 'function') return out({ status: 'no-plugin' });
  if (document.getElementById(HOLDER)) return out({ status: 'already-open' });
  let server;
  try {
    server = await Promise.race([plugin.ensureServer(), new Promise((_, reject) => setTimeout(() => reject(new Error('the server did not start in time')), __SERVER_MS__))]);
  } catch (e) {
    return out({ status: 'no-server', error: String((e && e.message) || e).split(String.fromCharCode(10))[0].slice(0, 200) });
  }
  const url = server.baseUrl + '/?tkn=' + encodeURIComponent(server.token) + '&folder=' + encodeURIComponent(VAULT);
  const holder = document.createElement('div');
  holder.id = HOLDER;
  holder.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:45%;z-index:2147483000;background:#1e1e1e;border-top:2px solid #007acc';
  const el = document.createElement('webview');
  el.setAttribute('partition', PARTITION);
  el.setAttribute('allowpopups', '');
  el.style.cssText = 'width:100%;height:100%;border:0';
  el.setAttribute('src', server.baseUrl + '/');
  holder.appendChild(el);
  document.body.appendChild(holder);
  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), __READY_MS__);
    el.addEventListener('dom-ready', () => { clearTimeout(timer); resolve(true); }, { once: true });
  });
  let seed = 'timeout', trust = 'timeout';
  if (ready) {
    try { seed = await el.executeJavaScript(SEED); } catch (e) { seed = 'error:' + String((e && e.message) || e).slice(0, 80); }
    if (TRUST !== null) {
      try {
        const entry = { uri: { $mid: 1, path: VAULT.replace(new RegExp(String.fromCharCode(47) + '+$'), ''), scheme: 'vscode-remote', authority: new URL(server.baseUrl).host }, trusted: true };
        trust = await el.executeJavaScript(TRUST.split('__ENTRY__').join(JSON.stringify(entry)).split('__KEEP__').join('[]'));
      } catch (e) { trust = 'error:' + String((e && e.message) || e).slice(0, 80); }
    }
    el.setAttribute('src', url);
  }
  const res = { status: 'opened', ready, seed: String(seed), partition: el.getAttribute('partition') };
  if (TRUST !== null) res.trust = String(trust);
  return out(res);
})()"""
        .replace("__SERVER_MS__", str(int(server_ms)))
        .replace("__READY_MS__", str(int(ready_ms)))
        .replace("__PLUGIN__", json.dumps(plugin_id))
        .replace("__VAULT__", json.dumps(vault))
        .replace("__HOLDER__", json.dumps(PAGE_HOLDER_ID))
        .replace("__PARTITION__", json.dumps(PAGE_PARTITION))
        .replace("__SEED__", json.dumps(seed_script))
        .replace("__TRUST__", json.dumps(trust_template))
    )


class CdpError(Exception):
    pass


class Cdp:
    """A minimal CDP session on one target's webSocketDebuggerUrl. It answers a beforeunload dialog (a page with a running terminal asks on reload)."""

    def __init__(self, ws):
        self.ws = ws
        self.n = 0
        self.pending: dict = {}
        self.dialogs: list = []
        self._reader = asyncio.ensure_future(self._pump())

    @classmethod
    async def open(cls, url: str):
        try:
            import websockets  # noqa: PLC0415 (only when a page is really driven; the pure parts must import without it)
        except ImportError:
            raise CannotRun("python3 package `websockets` is not installed (it is in the Obsidian container)")
        try:
            ws = await websockets.connect(url, max_size=None, ping_interval=None)
        except Exception as e:  # noqa: BLE001
            raise CannotRun(f"cannot open {url}: {e}")
        c = cls(ws)
        return c

    async def _pump(self):
        try:
            async for raw in self.ws:
                msg = json.loads(raw)
                if "id" in msg and msg["id"] in self.pending:
                    fut = self.pending.pop(msg["id"])
                    if not fut.done():
                        fut.set_result(msg)
                elif msg.get("method") == "Page.javascriptDialogOpening":
                    self.dialogs.append(msg["params"].get("type"))
                    asyncio.ensure_future(self.send("Page.handleJavaScriptDialog", {"accept": True}))
        except Exception:  # noqa: BLE001
            pass
        finally:
            for fut in self.pending.values():
                if not fut.done():
                    fut.set_exception(CdpError("connection closed"))

    async def send(self, method: str, params=None, timeout: float = 30):
        self.n += 1
        i = self.n
        fut = asyncio.get_event_loop().create_future()
        self.pending[i] = fut
        await self.ws.send(json.dumps({"id": i, "method": method, "params": params or {}}))
        msg = await asyncio.wait_for(fut, timeout)
        if "error" in msg:
            raise CdpError(f"{method}: {msg['error'].get('message')}")
        return msg.get("result", {})

    async def close(self):
        self._reader.cancel()
        try:
            await self.ws.close()
        except Exception:  # noqa: BLE001
            pass


class Page:
    """The few things the checks do to a page. The checks only use this interface, so a fake page drives them in the unit tests."""

    def __init__(self, cdp: Cdp, name: str = "page"):
        self.cdp = cdp
        self.name = name

    async def prepare_for_typing(self):
        """Only for the terminal page: dialogs get answered (a page with a running terminal asks before it reloads) and the page counts as focused."""
        await self.cdp.send("Page.enable")
        try:
            await self.cdp.send("Emulation.setFocusEmulationEnabled", {"enabled": True})
        except CdpError:
            pass

    async def ev(self, expr: str, timeout: float = 30):
        r = await self.cdp.send("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True}, timeout)
        if r.get("exceptionDetails"):
            return "ERROR " + str((r["exceptionDetails"].get("exception") or {}).get("description"))
        return r.get("result", {}).get("value")

    async def key(self, key: str, code: str, vk: int, modifiers: int = 0):
        for kind in ("rawKeyDown", "keyUp"):
            await self.cdp.send("Input.dispatchKeyEvent", {"type": kind, "key": key, "code": code, "windowsVirtualKeyCode": vk, "modifiers": modifiers})

    async def _press(self, x: int, y: int):
        """A real mouse move, press and release at (x, y) through the browser's input (Input.dispatchMouseEvent)."""
        for kind, buttons in (("mouseMoved", 0), ("mousePressed", 1), ("mouseReleased", 0)):
            await self.cdp.send("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": "none" if kind == "mouseMoved" else "left", "buttons": buttons, "clickCount": 0 if kind == "mouseMoved" else 1})

    async def click_center(self):
        """T45: a real mouse press and release at the centre of the window. A DOM `document.body.click()` does not give the workbench
        keyboard focus, so Ctrl+backtick and Ctrl+B were swallowed; a press that goes through the browser's input does.
        T50: only for a window whose centre is not the terminal (or where the terminal is wanted): with the panel open the centre IS the
        terminal, which takes the focus and the shell gets Ctrl+B. make_panel_only uses click_part instead."""
        size = await self.ev("JSON.stringify([window.innerWidth, window.innerHeight])")
        try:
            width, height = json.loads(size)
        except (TypeError, ValueError):
            width, height = 800, 600
        await self._press(int(width) // 2, int(height) // 2)

    async def click_part(self, selector: str) -> bool:
        """T50: the same real press, at the centre of the named workbench part (one of PARTS). False, and nothing is pressed, when the part
        is not in the page or measures 0 px (a hidden bar has nothing to press)."""
        raw = await self.ev(part_center_js(selector))
        try:
            x, y = json.loads(raw)
        except (TypeError, ValueError):
            return False
        await self._press(int(x), int(y))
        return True

    async def page_mark(self) -> str:
        """\"page\" when this webview is in the terminal page's partition (T44/T46), \"other\" when it is not (a Code tab), \"unreadable\" when it cannot say."""
        try:
            v = await self.ev(PAGE_MARK_JS, 10)
        except Exception:  # noqa: BLE001 (a target that went away)
            return "unreadable"
        return v if v in ("page", "other") else "unreadable"

    async def insert_text(self, text: str):
        await self.cdp.send("Input.insertText", {"text": text})

    async def type_chars(self, text: str):
        """xterm.js reads key events: one keyDown (with its text) and keyUp per character."""
        for ch in text:
            await self.cdp.send("Input.dispatchKeyEvent", {"type": "keyDown", "key": ch, "text": ch, "unmodifiedText": ch})
            await self.cdp.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": ch})

    async def enter(self):
        await self.cdp.send("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "text": "\r"})
        await self.cdp.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13})

    async def shot(self, path: str):
        import base64  # noqa: PLC0415
        r = await self.cdp.send("Page.captureScreenshot", {"format": "png"})
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "wb") as f:
            f.write(base64.b64decode(r["data"]))

    # (T49: no reload() here. A CDP Page.reload on the panel-only webview's own target closes that target in the container; the page is
    # reloaded the way a webview is, from the Obsidian window: Env.reload_page, see reload_webview.)

    async def navigate(self, url: str):
        await self.cdp.send("Page.navigate", {"url": url})

    async def layout(self) -> dict:
        return json.loads(await self.ev(LAYOUT_JS))

    async def entry_rects(self) -> list:
        return json.loads(await self.ev(ENTRY_RECTS_JS) or "[]")

    async def focus_terminal(self) -> str:
        return await self.ev(FOCUS_JS)

    async def close(self):
        await self.cdp.close()


# ---------------------------------------------------------------------------------------------------------------------
# the checks
# ---------------------------------------------------------------------------------------------------------------------
class Env:
    """Everything the checks take from the machine, so the tests can put a pretend machine in its place."""

    def __init__(self):
        self.proc_table = read_process_table
        self.read_cwd = read_cwd
        self.sleep = asyncio.sleep
        self.alive = pid_alive
        self.http_status = http_status
        self.ps_text = ps_forest_text
        self.kill = os.kill
        self.free_port = free_port
        self.list_webviews = lambda: []  # the workbench webview targets now (open-page; amain points it at the CDP endpoint)
        self.connect = None  # async (target) -> Page
        self.extra_pages: list = []  # pages the checks opened themselves (T38: a replacement for a reloaded target); amain closes them
        self.reload_page = no_reloader  # T49: async (page) -> None | str (why not). Reloads the terminal page's <webview> from the Obsidian window
        self.webview_state = no_webview_state  # T55: async () -> dict | None. What the Obsidian window says about the page's <webview> element
        self.load_page = no_page_loader  # T55: async (href) -> None | str (why not). Points the page's <webview> at an address again, from the window


async def no_reloader(_page) -> str | None:
    return "no Obsidian window was connected to reload the webview from (a CDP Page.reload on the webview's own target closes it)"


async def no_webview_state() -> dict | None:
    return None


async def no_page_loader(href) -> str | None:
    return "no Obsidian window was connected to point the webview from"


def webview_reload_js() -> str:
    """T49: runs in the Obsidian window. Finds the terminal page's own <webview> element by its partition attribute and calls its reload(),
    the way a webview is reloaded. Exactly one such element must be there; resolves to a JSON string: status reloaded | count | error."""
    return (
        "(() => { const PARTITION = " + json.dumps(PAGE_PARTITION) + "; "
        "const list = [...document.querySelectorAll('webview')].filter((w) => w.getAttribute('partition') === PARTITION); "
        "if (list.length !== 1) return JSON.stringify({ status: 'count', n: list.length }); "
        "try { list[0].reload(); } catch (e) { return JSON.stringify({ status: 'error', error: String((e && e.message) || e).slice(0, 120) }); } "
        "return JSON.stringify({ status: 'reloaded' }); })()"
    )


def webview_reloader(obs):
    """T49: the Env.reload_page that goes through `obs`, a Page on the Obsidian window's own CDP target."""

    async def reload_page(_page):
        try:
            res = json.loads(await obs.ev(webview_reload_js(), 15))
        except Exception as e:  # noqa: BLE001
            return f"the Obsidian window did not answer the webview reload script ({str(e)[:100]})"
        if res.get("status") == "reloaded":
            return None
        if res.get("status") == "count":
            return f"{res.get('n')} <webview> element(s) with partition {PAGE_PARTITION} in the Obsidian window (exactly one is needed); open-page makes it"
        return f"webview.reload() raised: {res.get('error')}"

    return reload_page


def webview_state_js() -> str:
    """T55: runs in the Obsidian window. What the window says about the page's own <webview> element(s) (found by the partition attribute):
    how many there are, and for each its address (token hidden), whether it is loading, whether it crashed and whether it is still in the
    document. Resolves to a JSON string {n, views:[{url, loading, crashed, connected}]}. Read-only."""
    return (
        "(() => { const PARTITION = " + json.dumps(PAGE_PARTITION) + "; "
        "const list = [...document.querySelectorAll('webview')].filter((w) => w.getAttribute('partition') === PARTITION); "
        "const one = (w) => { const o = {}; for (const [k, f] of [['url', () => w.getURL()], ['loading', () => w.isLoading()], ['crashed', () => w.isCrashed()]]) { try { o[k] = f(); } catch (e) { o[k] = 'n/a'; } } "
        "if (typeof o.url === 'string') o.url = o.url.replace(/tkn=[^&#]*/, 'tkn=(hidden)'); o.connected = !!w.isConnected; return o; }; "
        "return JSON.stringify({ n: list.length, views: list.map(one) }); })()"
    )


def webview_load_js(href: str) -> str:
    """T55: runs in the Obsidian window. Points the page's own <webview> (exactly one, found by its partition) at `href` with loadURL, the
    way the window would load it. Resolves to a JSON string: status loaded | count | error (the address, token included, is never in it)."""
    return (
        "(async () => { const PARTITION = " + json.dumps(PAGE_PARTITION) + ", HREF = " + json.dumps(href) + "; "
        "const list = [...document.querySelectorAll('webview')].filter((w) => w.getAttribute('partition') === PARTITION); "
        "if (list.length !== 1) return JSON.stringify({ status: 'count', n: list.length }); "
        "try { await list[0].loadURL(HREF); } catch (e) { const m = String((e && e.message) || e); "
        "if (!/ERR_ABORTED/.test(m)) return JSON.stringify({ status: 'error', error: m.replace(/tkn=[^&#'\\s]*/g, 'tkn=(hidden)').slice(0, 120) }); } "
        "return JSON.stringify({ status: 'loaded' }); })()"
    )


def webview_state_reader(obs):
    """T55: the Env.webview_state that asks `obs`, a Page on the Obsidian window's own CDP target."""

    async def read():
        try:
            return json.loads(await obs.ev(webview_state_js(), 15))
        except Exception as e:  # noqa: BLE001
            return {"error": f"the Obsidian window did not answer ({str(e)[:100]})"}

    return read


def webview_loader(obs):
    """T55: the Env.load_page that goes through `obs`."""

    async def load(href):
        try:
            res = json.loads(await obs.ev(webview_load_js(href), 40))
        except Exception as e:  # noqa: BLE001
            return f"the Obsidian window did not answer the webview load script ({str(e)[:100]})"
        if res.get("status") == "loaded":
            return None
        if res.get("status") == "count":
            return f"{res.get('n')} <webview> element(s) with partition {PAGE_PARTITION} in the Obsidian window (exactly one is needed)"
        return f"webview.loadURL() raised: {res.get('error')}"

    return load


def webview_text(st) -> str:
    """The window's view of the page's <webview>, as one line."""
    if not st:
        return "not read (no Obsidian window was connected)"
    if "error" in st:
        return str(st["error"])
    views = st.get("views") or []
    if not views:
        return f"{st.get('n', 0)} <webview> element(s) with partition {PAGE_PARTITION}: the element is gone from the window"
    return f"{st.get('n')} <webview> element(s) with partition {PAGE_PARTITION}: " + " | ".join(
        f"address {v.get('url')}, loading={v.get('loading')}, crashed={v.get('crashed')}, in the document={v.get('connected')}" for v in views
    )


def http_status(port: int, timeout: float = 2.0) -> int:
    try:
        return urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=timeout).status
    except Exception:  # noqa: BLE001
        return 0


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


async def wait_until(env: Env, fn, seconds: float, step: float = 0.5):
    for _ in range(int(seconds / step) + 1):
        v = fn()
        if v:
            return v
        await env.sleep(step)
    return fn()


def shells_now(env: Env, server_pid: int) -> list[dict]:
    return server_view(env.proc_table(), server_pid)["shells"]


async def type_line(env: Env, page, text: str, delivered) -> str:
    """Type one line into the focused terminal and make sure it arrived, by asking the machine (`delivered()`), not the page.
    First the whole text with Input.insertText; if the machine shows nothing, clear the line and send key events one character at a time."""
    await page.focus_terminal()
    await page.insert_text(text)
    await page.enter()
    if await wait_until(env, delivered, 4):
        return "insertText"
    await page.key("u", "KeyU", 85, CTRL)  # clear whatever half-line the first try left at the prompt
    await page.focus_terminal()
    await page.type_chars(text)
    await page.enter()
    if await wait_until(env, delivered, 6):
        return "key events"
    return "not delivered"


async def live_new_shell(env: Env, server_pid: int, known: set, seconds: float, settle: float = 1.0):
    """T64: the first shell under the server that is not in `known` and is a real terminal: its working directory reads back, and it is
    still in the process table (not a zombie) with a readable folder `settle` seconds later. The pty host forks a child for every request;
    for a folder that does not exist the child fails its chdir and exits at once (pty_helper.py, `_exit(126)`), so it shows in the table
    for a moment and has no readable cwd. Returns (shell or None, [pids of children that were seen and did not live])."""
    seen_dead: list[int] = []
    for _ in range(int(seconds / 0.5) + 1):
        for s in shells_now(env, server_pid):
            if s["pid"] in known or s["pid"] in seen_dead:
                continue
            if env.read_cwd(s["pid"]):
                await env.sleep(settle)
                again = next((x for x in shells_now(env, server_pid) if x["pid"] == s["pid"]), None)
                if again and not again["state"].startswith("Z") and env.read_cwd(s["pid"]):
                    return s, seen_dead
            seen_dead.append(s["pid"])
        await env.sleep(0.5)
    return None, seen_dead


async def new_terminal(env: Env, page, server_pid: int, seconds: float = 15):
    """Ctrl+Shift+backtick; the new shell, read from the process table."""
    known = {s["pid"] for s in shells_now(env, server_pid)}
    await page.click_center()
    await page.key("`", "Backquote", 192, CTRL | SHIFT)
    return await wait_until(env, lambda: next((s for s in shells_now(env, server_pid) if s["pid"] not in known), None), seconds)


async def wait_painted(env: Env, page, seconds: float = 120, gone=None):
    """Wait for the workbench to paint. `gone` (T46) is asked after a failed read: when it says the page's target has left the CDP list,
    reading it again is pointless, so the wait ends at once instead of after `seconds`."""
    for _ in range(int(seconds / 0.5)):
        try:
            if await page.ev(PAINTED_JS) is True:
                await env.sleep(3)
                return True
        except Exception:  # noqa: BLE001
            try:
                if gone and gone():
                    return False
            except Exception:  # noqa: BLE001
                pass
        await env.sleep(0.5)
    return False


# T55: a mark on the document that is on screen before the reload. A document that still has it after the reload is the old one: a page
# that "painted" because the reload had not happened (or was held back) must not count as a page that painted again.
OLD_DOC_SET_JS = "(() => { window.__terminalSpikeBeforeReload = true; return 'marked'; })()"
OLD_DOC_JS = "window.__terminalSpikeBeforeReload === true"


async def mark_old_document(page) -> None:
    try:
        await page.ev(OLD_DOC_SET_JS, 10)
    except Exception:  # noqa: BLE001 (a page that cannot be marked is reloaded all the same; the wait then relies on the paint alone)
        pass


async def old_document(page) -> bool:
    try:
        return (await page.ev(OLD_DOC_JS, 10)) is True
    except Exception:  # noqa: BLE001
        return False


async def wait_reloaded(env: Env, page, seconds: float = 45, gone=None):
    """T55: wait_painted, but only a document that is not the one marked before the reload counts. `gone` as in wait_painted."""
    for _ in range(int(seconds / 0.5)):
        try:
            if await page.ev(PAINTED_JS) is True and not await old_document(page):
                await env.sleep(3)
                return True
        except Exception:  # noqa: BLE001
            try:
                if gone and gone():
                    return False
            except Exception:  # noqa: BLE001
                pass
        await env.sleep(0.5)
    return False


PAGE_STATE_JS = (
    "(() => { const text = (e) => ((e && (e.innerText || e.textContent)) || '').replace(/\\s+/g, ' ').trim().slice(0, 160); const a = document.activeElement; "
    "const dialog = document.querySelector('.monaco-dialog-box'); "
    "return JSON.stringify({ ready: document.readyState, title: document.title.slice(0, 60), "
    "blocked: !!document.querySelector('.monaco-dialog-modal-block'), dialog: text(dialog), "
    "buttons: dialog ? [...dialog.querySelectorAll('.dialog-buttons a, .dialog-buttons button')].map(text) : [], "
    "active: a ? (a.tagName.toLowerCase() + (a.className ? '.' + String(a.className).split(' ')[0] : '')) : null, "
    "body: text(document.body).slice(0, 120) }); })()"
)
# Only the answer that trusts the folder is ever pressed, and only in the page the helper itself opened on the tester's throwaway vault.
PRESS_TRUST_JS = (
    "(() => { const d = document.querySelector('.monaco-dialog-box'); if (!d) return 'no dialog'; "
    "const b = [...d.querySelectorAll('.dialog-buttons a, .dialog-buttons button')].find((x) => /^yes, i trust/i.test((x.innerText || x.textContent || '').trim())); "
    "if (!b) return 'no trust button'; b.click(); return 'pressed'; })()"
)


async def page_state(page) -> dict:
    """What the page shows right now: a modal dialog (its text and buttons), the focused element, the title. {} when it cannot be read."""
    try:
        raw = await page.ev(PAGE_STATE_JS)
        return json.loads(raw) if isinstance(raw, str) and raw.startswith("{") else {}
    except Exception:  # noqa: BLE001
        return {}


def state_text(st: dict) -> str:
    if not st:
        return "the page's state could not be read"
    shown = f"modal dialog: {st['dialog']!r} buttons {st.get('buttons')}" if st.get("blocked") or st.get("dialog") else "no modal dialog"
    return f"{shown}; focus in {st.get('active')}; title {st.get('title')!r}; readyState {st.get('ready')}; page text {st.get('body')!r}"


def part_done(lay: dict, part: str) -> bool:
    """The panel is open, or the named bar is hidden."""
    return panel_visible(lay) if part == "panel" else hidden(lay.get(part))


async def make_panel_only(env: Env, page, rep: Reporter | None = None, tries: int = 3) -> dict:
    """Only what is missing: hide the side bar (Ctrl+B) and the secondary side bar (Ctrl+Alt+B) if they show, then open the panel
    (Ctrl+backtick) if it is closed. T37: a modal dialog in the page swallows the key presses, so before each try the page is asked for
    one; a Workspace Trust question is answered 'Yes, I trust' (the folder is the tester's throwaway vault) and anything else is reported.
    T45/T50: the keys reach the workbench only after a real mouse press, and only if the press lands on something that is not the terminal
    (a press on the terminal gives the focus to its textarea and Ctrl+B / Ctrl+Alt+B go to the shell). So the bars go first, each with a
    press INSIDE the bar its key acts on (page.click_part), and the panel last, with a press on a part that is still showing (the editor,
    else any other part but the terminal); no press is ever at the window centre, which is the panel once it is open. A step whose
    outcome already holds is skipped. Each key press is repeated up to `tries` times while the layout does not change, each time with a
    new press in the same part; when it still has not changed, `rep` gets what the page showed."""
    lay = await page.layout()
    # the secondary side bar (Chat in a current VS Code) is on by default and is not hidden by the side bar key: Ctrl+Alt+B (Cmd+Alt+B on a Mac)
    for part, press_on, key, mod, code, vk in (
        ("sidebar", [".part.sidebar"], "b", SIDEBAR_MOD, "KeyB", 66),
        ("auxiliarybar", [".part.auxiliarybar"], "b", SIDEBAR_MOD | ALT, "KeyB", 66),
        ("panel", NON_TERMINAL_PARTS, "`", CTRL, "Backquote", 192),
    ):
        pressed_on = None
        for attempt in range(tries):
            if part_done(lay, part):
                break
            st = await page_state(page)
            if st.get("blocked") or st.get("dialog"):
                pressed = await page.ev(PRESS_TRUST_JS) if "trust" in (st.get("dialog") or "").lower() else "not a trust question"
                if rep:
                    rep.info(f"a modal dialog is up in the page ({state_text(st)}): {pressed}")
                await env.sleep(2)
            pressed_on = None
            for selector in press_on:
                if await page.click_part(selector):
                    pressed_on = selector
                    break
            await page.key(key, code, vk, mod)
            await env.sleep(5 if part == "panel" else 2)
            lay = await page.layout()
        if rep and not part_done(lay, part):
            rep.info(f"after {tries} tries the {part} key did not change the layout (pressed in {pressed_on or 'no part: none of ' + ', '.join(press_on) + ' is showing'} before the key): {state_text(await page_state(page))}")
    return lay


def folders_for(vault: str) -> dict:
    return {k: os.path.join(vault, n) for k, n in FOLDER_NAMES.items()}


def resolve_server(env: Env, a) -> dict:
    """The server under test: --server-pid, else the live vscode-server entry of --pidfile; its server data dir from --server-data-dir
    or from the server's own command line."""
    rows = env.proc_table()
    pid = a.server_pid or (server_pid_from_pidfile(a.pidfile, env.alive) if a.pidfile else None)
    if pid is None and a.server_data_dir:
        roots = serve_web_roots(rows, a.server_data_dir)
        pid = roots[0] if len(roots) == 1 else None
    if pid is None or not any(r["pid"] == pid for r in rows):
        raise CannotRun("no running server: pass --server-pid, or --pidfile <runtime>/pids.json of the plugin that started it, or --server-data-dir")
    data_dir = a.server_data_dir or next((d for d in (data_dir_of(r) for r in descendants(rows, pid)) if d), None)
    if not data_dir:
        raise CannotRun(f"cannot find --server-data-dir on the command line of the server {pid}; pass it")
    return {"pid": pid, "data_dir": data_dir}


async def code_tab_guard_before(pages) -> dict:
    return {name: await p.layout() for name, p in pages.items()}


async def code_tab_guard_after(rep: Reporter, env: Env, before: dict, pages: dict, shot=None):
    if not before:
        rep.check(False, "S1: a Code tab beside the terminal page keeps its layout", "no Code tab webview found: open a Code tab in Obsidian first, then run again")
        return
    for name, p in pages.items():
        try:
            after = await p.layout()
        except Exception as e:  # noqa: BLE001 (T46: the Code tab's webview was closed or re-created while the page was worked on)
            rep.check(False, f"S1: Code tab {name} has the same side bar, panel and layout before and after", f"before: {layout_text(before[name])} | after: could not be read ({str(e)[:100]}): that Code tab's webview went away or was re-created during the run")
            continue
        same = after == before[name]
        rep.check(same, f"S1: Code tab {name} has the same side bar, panel and layout before and after", f"before: {layout_text(before[name])} | after: {layout_text(after)}")
        if shot and name == next(iter(pages)):
            await p.shot(shot)


async def painted_detail(page) -> dict:
    """What PAINTED_JS saw in the page: the address (token hidden), title, readyState, each part's size and the first words of the text. {} when unreadable."""
    try:
        raw = await page.ev(PAINTED_DETAIL_JS, 10)
        return json.loads(raw) if isinstance(raw, str) and raw.startswith("{") else {}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:120]}


def detail_text(d: dict) -> str:
    if not d:
        return "unreadable (no answer from the page)"
    if "error" in d:
        return f"unreadable ({d['error']})"
    parts = ", ".join(f"{k} {v}" for k, v in (d.get("parts") or {}).items())
    return f"painted={d.get('painted')}; address {d.get('href')}; title {d.get('title')!r}; readyState {d.get('readyState')}; parts: {parts}; text {d.get('body')!r}"


async def settle_targets(env: Env, seconds: float = 5.0, step: float = 1.0, limit: float = 40.0) -> list[dict]:
    """T44: the workbench webview targets once the list has stopped changing for `seconds` (at most `limit` s). A Code tab opened on a file goes
    through two webviews (the Welcome page, then the file), so the list right after the first one appears is not the Code tab's final one."""
    last = {t["id"] for t in env.list_webviews()}
    stable = waited = 0.0
    while stable < seconds and waited < limit:
        await env.sleep(step)
        waited += step
        now = {t["id"] for t in env.list_webviews()}
        if now == last:
            stable += step
        else:
            last, stable = now, 0.0
    return env.list_webviews()


async def find_page_targets(env: Env, seconds: float = 60, skip=()):
    """T44/T46: the webview targets that are the terminal page, found by what they are (their partition holds the page's own settings, see
    PAGE_MARK_JS), not by being new: a Code tab can be re-created at any time and then is new too. `skip` is a set of target ids not to look at.
    Returns [(target, page)] with a connected page for each hit (the caller closes them) and the ids that were read as something else."""
    found: dict = {}
    others = set(skip)

    async def scan():
        connect = env.connect
        if connect is None:
            return
        for t in env.list_webviews():
            if t["id"] in found or t["id"] in others:
                continue
            try:
                page = await connect(t)
            except Exception:  # noqa: BLE001 (a target that went away between the list and the connection)
                continue
            mark = await page.page_mark()
            if mark == "page":
                found[t["id"]] = (t, page)
            else:
                await page.close()
                if mark == "other":
                    others.add(t["id"])

    for _ in range(int(seconds) + 1):
        await scan()
        if found:
            break
        await env.sleep(1)
    if found:
        await env.sleep(2)  # a second page in that partition would show up by now
        await scan()
    return list(found.values()), others


async def reload_and_wait(env: Env, rep: Reporter, term, seconds: float = 45, skip=()):
    """T38: reload the terminal page and wait for it to paint, saying what happened. Reports the target reloaded, what PAINTED_JS saw, and,
    when it did not paint: the targets the endpoint lists now and whether the reloaded target is still among them.
    T49: the reload is `env.reload_page` (webview.reload() on the page's <webview> element, from the Obsidian window); a CDP Page.reload on
    the page's own target closes that target in the container. When that cannot be done the run says why and the page counts as not painted.
    T46: if the page was re-created under another id it is found again by its partition (PAINTED_JS and the settings it carries), never by
    being the one new target (that was a Code tab's webview); if no target is in that partition the reload closed the page and the run says so.
    T55: the document on screen is marked before the reload and only a document without the mark counts as painted again (a reload that
    did not happen is not a repaint); the Obsidian window's own view of the <webview> (does the element exist, its address, loading,
    crashed) is reported before the reload and again when the page did not come back, which is what tells a closed target from a closed
    element; a target that is still listed under the same id, or listed under another one, is connected to afresh by its partition
    (the old connection dies with the old document); and when the element is in the window but no page comes back, the window points it at
    the page's address again (webview.loadURL), so GP2 and S2 can still be measured. A page that needed that is not a pass of the
    reload: the third value is True and the caller records the repaint line as a FAIL.
    Then the page's own address is navigated to once (when its target is still listed). `skip` is a set of target ids that are not the page
    (the Code tabs). Returns (painted, page, recovered): the page to go on with, and whether the window had to load it again."""
    name = getattr(term, "name", "?")
    before = await painted_detail(term)
    href = await term.ev("location.href") if before else None
    rep.info(f"reloading target {name}: before the reload PAINTED_JS saw {detail_text(before)}")
    rep.info(f"the <webview> in the Obsidian window before the reload: {webview_text(await env.webview_state())}")
    await mark_old_document(term)
    why_not = await env.reload_page(term)
    if why_not:
        rep.info(f"the page was not reloaded: {why_not}")
        return False, term, False
    await env.sleep(2)

    def gone():
        listed = env.list_webviews()
        return bool(listed) and all(t["id"] != name for t in listed)

    if await wait_reloaded(env, term, seconds, gone=gone):
        return True, term, False
    rep.info(f"target {name} did not paint within {seconds:g} s of the reload: PAINTED_JS saw {detail_text(await painted_detail(term))}")
    if await old_document(term):
        rep.info(f"target {name} still shows the document that was there before the reload (the mark set before it is still in the page): the reload did not happen, or it was held back (an unanswered 'leave the page?' prompt)")
    now = env.list_webviews()
    rep.info("webview targets now: " + (" | ".join(f"{t['id']} {redact_url(t.get('url', ''))[:90]} {t.get('title', '')!r}" for t in now) or "none listed"))
    still = any(t["id"] == name for t in now)
    rep.info(f"the reloaded target {name} is " + ("still listed" if still else "no longer listed: the reload closed the webview, or the page was re-created under another id"))
    state = await env.webview_state()
    rep.info(f"the <webview> in the Obsidian window after the reload: {webview_text(state)}")
    if env.connect:
        # T55: the old id is not skipped: a target that stays listed has a new document and the old connection is dead, so it is connected to afresh
        hits, others = await find_page_targets(env, 0 if still else 20, skip=set(skip))
        if len(hits) >= 1:
            target, page = hits[0]
            for _t, extra in hits[1:]:
                await extra.close()
            rep.info(f"target {target['id']} is in the page's partition (it carries {TERMINAL_PAGE_SETTING}); connecting to it instead" + (f" ({len(hits)} such targets: the first)" if len(hits) > 1 else ""))
            env.extra_pages.append(page)
            await page.prepare_for_typing()
            if await wait_reloaded(env, page, seconds):
                return True, page, False
            rep.info(f"the target {target['id']} did not paint either: PAINTED_JS saw {detail_text(await painted_detail(page))}")
        elif not still:
            rep.info(f"no listed webview target is in the page's partition (checked {sorted(others - set(skip) - {name})}): the Code tab's webviews are not used in its place")
    if (still or not now) and isinstance(href, str) and href.startswith("http"):  # (an empty list says nothing about the target: try)
        rep.info(f"navigating target {name} to its own address once more")
        try:
            await term.navigate(href)
        except Exception as e:  # noqa: BLE001
            rep.info(f"the navigation failed: {str(e)[:120]}")
        else:
            await env.sleep(2)
            if await wait_painted(env, term, seconds):
                return True, term, False
            rep.info(f"after the navigation PAINTED_JS saw {detail_text(await painted_detail(term))}")
    if isinstance(href, str) and href.startswith("http"):
        # T55: nothing came back through the page's own target. The window still owns the element: point it at the address again
        why = await env.load_page(href)
        if why:
            rep.info(f"the <webview> was not pointed at the page's address again: {why}")
        else:
            rep.info("the <webview> in the Obsidian window was pointed at the page's address again (webview.loadURL)")
            await env.sleep(2)
            if env.connect:
                hits, _others = await find_page_targets(env, 20, skip=set(skip))
                for _t, extra in hits[1:]:
                    await extra.close()
                if hits:
                    page = hits[0][1]
                    env.extra_pages.append(page)
                    await page.prepare_for_typing()
                    if await wait_painted(env, page, seconds):
                        rep.info(f"target {hits[0][0]['id']} painted after the window loaded the address again: the reload alone did not bring the page back")
                        return False, page, True
                    rep.info(f"the target {hits[0][0]['id']} did not paint after the load either: PAINTED_JS saw {detail_text(await painted_detail(page))}")
                else:
                    rep.info("no target in the page's partition is listed after the load either")
            elif await wait_painted(env, term, seconds):
                return False, term, True
    return False, term, False


async def run_terminal_at(env: Env, rep: Reporter, a, term, codes: dict, server: dict, source_cjs: str, out_dir: str):
    """GP2 and S2 in the container. `term` and `codes` are Page objects (the terminal page and the Code tabs)."""
    vault = a.vault
    folders = folders_for(vault)
    for key in ("spaces", "unicode"):
        os.makedirs(folders[key], exist_ok=True)
    sv = server["pid"]
    rep.info(f"server pid {sv}, server data dir {server['data_dir']}, vault {vault}")

    # 1. no other serve-web on this server data dir (its extension host would take or lose the request)
    left = leftover_roots(env.proc_table(), server["data_dir"], sv)
    rep.check(not left, "no leftover serve-web uses this server data dir", f"other trees: {left}" if left else "only the server under test")

    # 2. the Code tabs' layout, before anything is done to the terminal page
    code_before = await code_tab_guard_before(codes)
    rep.info("Code tabs before: " + (" | ".join(f"{n}: {layout_text(l)}" for n, l in code_before.items()) or "none"))

    # 3. the extension, inside the server's own extension dir
    inst = install_extension(server["data_dir"], source_cjs)
    ext_dir = inst["ext_dir"]
    inside = os.path.realpath(ext_dir).startswith(os.path.realpath(os.path.join(server["data_dir"], "extensions")) + os.sep)
    rep.check(inside and os.path.exists(os.path.join(ext_dir, "extension.js")) and os.path.exists(os.path.join(ext_dir, "package.json")),
              "S2: the extension is installed inside the server's own extension dir", ext_dir)

    # 4. the setting that names the terminal page, written into that webview's own settings, then a reload so its extension host starts with it
    seeded = await term.ev(build_seed_script(PANEL_SETTINGS))
    rep.check(seeded == "seeded", f"the panel-only webview's settings carry {TERMINAL_PAGE_SETTING} = true (seeded through its own CDP target)", seeded)
    painted, term, recovered = await reload_and_wait(env, rep, term, skip={getattr(p, "name", None) for p in codes.values()})
    rep.check(painted, "the terminal page painted again after the reload", f"target {getattr(term, 'name', '?')}" if painted else "see the INFO lines above for the target, what PAINTED_JS saw and what the Obsidian window says about the <webview>")
    if not painted and not recovered:
        # T51: the Code tab's layout is still measured, so a failed reload does not hide whether the run disturbed it
        await code_tab_guard_after(rep, env, code_before, codes, None)
        return
    # (T55: recovered = the reload alone left no page, the window loaded the address again; the FAIL above stays, and the checks that need
    # the page are run on the page that came back, so GP2 and S2 are still measured)
    lay = await make_panel_only(env, term, rep)
    rep.check(panel_only(lay), "S1: in the container's webview, every other part measures 0 px and the panel fills the window", layout_text(lay))
    await env.sleep(3)

    # 5. GP2: the shell the panel started, read from the process table
    first = await wait_until(env, lambda: shells_now(env, sv), 20)
    rep.check(len(first) == 1, "GP2: one shell started with the panel", f"{len(first)} shell(s) under the server" + ("" if len(first) == 1 else "; start from a fresh server to get exactly one"))
    cwds = [(s["pid"], env.read_cwd(s["pid"])) for s in first]
    rep.check(bool(first) and all(same_folder(c, vault) for _, c in cwds), "GP2: the shell's working directory is the vault root (readlink of the process's cwd)", ", ".join(f"pid {p}: {c}" for p, c in cwds))
    second = await new_terminal(env, term, sv)
    await env.sleep(2)
    rects = await term.entry_rects()
    win = (await term.layout())["win"]
    rep.check(list_on_right(rects, win[0]), "GP2: with two terminals the terminal list sits on the right of the page (measured in the page)", f"entries at x {[r[0] for r in rects]} of {win[0]}")
    rep.check(bool(second) and same_folder(env.read_cwd(second["pid"]), vault), "GP2: the second shell also starts in the vault root", f"{env.read_cwd(second['pid']) if second else 'no second shell'}")
    await term.shot(os.path.join(out_dir, "shot-1-container-panel-only-two-terminals.png"))

    # 6. S2: ask for a terminal at each folder through the request file, and read what the machine did
    pwd_dir = tempfile.mkdtemp(prefix="pwd-", dir=out_dir)
    os.chmod(pwd_dir, 0o777)  # the shell may run as another user than this helper
    results = {}
    for key in ("spaces", "unicode", "missing"):
        known = {s["pid"] for s in shells_now(env, sv)}
        stale = os.path.join(ext_dir, "request.json")
        if os.path.exists(stale):
            os.remove(stale)
        req = build_request(f"container-{key}-{int(time.time() * 1000)}", folders[key])
        write_request(ext_dir, req, server["data_dir"])
        fresh, dead = await live_new_shell(env, sv, known, 15 if key != "missing" else 8)
        taken = not os.path.exists(os.path.join(ext_dir, "request.json"))
        r = {"folder": folders[key], "request_file_taken": taken, "new_shell": fresh["pid"] if fresh else None, "children_that_did_not_live": dead}
        if key == "missing":
            # (T64: a child the pty host forked for the folder that is gone, or has no readable cwd, is not a terminal)
            rep.check(fresh is None, "S2: a folder that does not exist opens no terminal",
                      f"request file {'taken' if taken else 'still there'}" + (f"; {len(dead)} child process(es) seen and not alive with a cwd (pid {', '.join(map(str, dead))}), not counted" if dead else ""))
        else:
            cwd = env.read_cwd(fresh["pid"]) if fresh else None
            r["shell_cwd"] = cwd
            rep.check(fresh is not None, f"S2: a request for the {key} folder opened a terminal", f"request file {'taken' if taken else 'still there'}")
            rep.check(same_folder(cwd, folders[key]), f"S2: the new shell's working directory is the {key} folder (readlink of the process's cwd)", cwd)
            if fresh:
                out_file = os.path.join(pwd_dir, f"{key}.txt")
                how = await type_line(env, term, f"pwd | tee '{out_file}'", lambda: os.path.exists(out_file) and os.path.getsize(out_file) > 0)
                printed = open(out_file, encoding="utf8").read().strip() if os.path.exists(out_file) else None
                r["pwd_printed"], r["typed_with"] = printed, how
                rep.check(printed is not None and same_folder(printed, folders[key]), f"S2: `pwd` in that terminal printed the {key} folder", f"{printed!r} (typed with {how})")
                if key == "spaces":
                    await env.sleep(1)
                    await term.shot(os.path.join(out_dir, "shot-3-container-terminal-at-folder-with-spaces.png"))
        results[key] = r
    rep.data["s2"] = results

    # 7. S1: the Code tabs beside, unchanged
    await code_tab_guard_after(rep, env, code_before, codes, os.path.join(out_dir, "shot-4b-container-code-tab-beside.png") if codes else None)
    leftover_request = os.path.join(ext_dir, "request.json")
    if os.path.exists(leftover_request):
        os.remove(leftover_request)


async def read_plugin_state(page, plugin_id: str) -> dict:
    raw = await page.ev(plugin_state_js(plugin_id))
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        raise CannotRun(f"the Obsidian window did not answer the plugin state query: {raw!r}")


async def run_trust_plugins(env: Env, rep: Reporter, page, plugin_id: str, out_dir: str, wait: float = 30):
    """T18: press the vault's trust prompt so the plugin loads. Passes only when the plugin has an instance, commands, and no prompt is up."""
    st = await read_plugin_state(page, plugin_id)
    rep.info(f"before: {json.dumps(st)}")
    if not st.get("app"):
        raise CannotRun("this CDP target is not an Obsidian window (no `app`)")
    if plugin_loaded(st):
        rep.check(True, f"plugin {plugin_id} is loaded and the trust prompt is not showing", "nothing to do")
        return
    if st.get("modal"):
        await page.shot(os.path.join(out_dir, "obsidian-trust-prompt.png"))
        clicked = await page.ev(CLICK_TRUST_JS)
        rep.check(clicked == "clicked", f"pressed \"{TRUST_BUTTON_TEXT}\" on the vault trust prompt", clicked)
    for step in ("after the prompt", "after setEnable(true) and enablePluginAndSave"):
        for _ in range(int(wait / 0.5) + 1):
            st = await read_plugin_state(page, plugin_id)
            if plugin_loaded(st):
                break
            await env.sleep(0.5)
        if plugin_loaded(st) or step != "after the prompt":
            break
        rep.info(f"still not loaded {step}: {json.dumps(st)}; trying setEnable(true) and enablePluginAndSave")
        rep.info("enable call: " + str(await page.ev(enable_plugin_js(plugin_id))))
    await page.shot(os.path.join(out_dir, "obsidian-after-trust.png"))
    rep.check(plugin_loaded(st), f"plugin {plugin_id} is loaded (instance and commands present) and no trust prompt is showing", json.dumps(st))


def parse_page_result(raw) -> dict:
    try:
        v = json.loads(raw)
    except (TypeError, ValueError):
        raise CannotRun(f"the Obsidian window did not answer the open-page script: {str(raw)[:200]!r}")
    if not isinstance(v, dict) or "status" not in v:
        raise CannotRun(f"the Obsidian window answered the open-page script with something unexpected: {str(raw)[:200]!r}")
    return v


async def run_open_page(env: Env, rep: Reporter, obs, a, out_dir: str):
    """T29: build what the other modes work on. A Code tab beside (default partition), then the panel-only page in its own partition, with
    the server the plugin started. Everything is read back from the CDP target list and the pidfile, not taken on trust from the script.
    T34: with `--accept-licence` a timer in the Obsidian window presses "Accept and download" on the plugin's licence prompt, which would
    otherwise hold the server (and so the Code tab and the page) back for ever on a first run. It is off unless asked for."""
    st = await read_plugin_state(obs, PLUGIN_ID)
    if not st.get("app"):
        raise CannotRun("this CDP target is not an Obsidian window (no `app`)")
    if not plugin_loaded(st):
        raise CannotRun(f"the plugin {PLUGIN_ID} is not loaded in this Obsidian window ({json.dumps(st)}): run `trust-plugins` first")
    armed = False
    if a.accept_licence:
        armed = (await obs.ev(accept_licence_js(int((float(a.wait) + 120) * 1000)))) in ("armed", "already armed")
        rep.info("licence prompt: a timer in the Obsidian window will press \"" + LICENCE_ACCEPT_TEXT + "\" if it shows (--accept-licence)")
    try:
        await open_page_steps(env, rep, obs, a, out_dir)
    finally:
        if armed:
            try:
                done = json.loads(await obs.ev(disarm_licence_js()))
                rep.info(f"licence prompt: \"{LICENCE_ACCEPT_TEXT}\" was pressed {done.get('pressed', 0)} time(s)" + ("" if done.get("pressed") else " (no prompt appeared: already accepted)"))
            except Exception as e:  # noqa: BLE001 (the window may be gone; the run has its own result)
                rep.info(f"licence prompt: could not stop the timer in the Obsidian window ({e})")


async def scan_code_tabs(env: Env, rep: Reporter, tries: int = 3) -> dict:
    """T56: the Code tabs, as connected pages keyed by a label. Before the terminal page is opened every workbench webview that is not
    already a page of an earlier run (page_mark "page") is a Code tab. A webview whose partition cannot be read is asked again, and then
    still counted (the page is not open yet, so it is a Code tab); one that cannot be connected to is a FAIL line by name, not a silent skip."""
    pages: dict = {}
    if env.connect is None:
        return pages
    for t in env.list_webviews():
        label = f"{t['id']} {t.get('title', '')}".strip()
        page, mark, why = None, "unreadable", ""
        for attempt in range(tries):
            if attempt:
                await env.sleep(2)
            try:
                page = await env.connect(t)
            except Exception as e:  # noqa: BLE001 (a target that went away between the list and the connection)
                page, why = None, f"could not be connected to ({str(e)[:80]})"
                continue
            mark = await page.page_mark()
            if mark != "unreadable":
                break
            why = "its partition could not be read"
            if attempt < tries - 1:
                await page.close()
                page = None
        if page is None:
            rep.check(False, f"S1: Code tab {label} can be connected to and measured", why)
            continue
        if mark == "page":
            await page.close()
            continue
        if mark == "unreadable":
            rep.info(f"webview {label}: {why} after {tries} tries; counted as a Code tab because the terminal page is not open yet")
        pages[label] = page
    return pages


async def open_page_steps(env: Env, rep: Reporter, obs, a, out_dir: str):
    wait = float(a.wait)
    start = {t["id"] for t in env.list_webviews()}

    # 1. a Code tab, so the page is opened with one beside it (S1)
    if not a.no_code_tab:
        done = await obs.ev(open_code_tab_js(PLUGIN_ID, a.code_file), timeout=wait + 60)
        rep.info(f"Code tab: {done}" + (f" ({a.code_file})" if a.code_file else f" (the helper's file {DEFAULT_CODE_FILE} in the vault, made if missing; pass --code-file <vault-relative file> to name another)"))
        codes = await wait_until(env, lambda: env.list_webviews(), wait, 1.0)
        n_new = len([t for t in codes if t["id"] not in start])
        rep.check(bool(codes), "a Code tab is open: a workbench webview in the default partition", f"{n_new} new, {len(codes) - n_new} already open" if codes else f"none appeared (the Code tab script answered {done!r}); the first run downloads the server and asks for the licence in Obsidian: run again with --accept-licence (or accept it by hand)")
        if codes:
            # T44: a Code tab opened on a file goes through two webviews (the Welcome page, then the file); wait until the list stops changing
            settled = await settle_targets(env)
            rep.info(f"the Code tab settled: {len(settled)} workbench webview target(s) listed: " + " | ".join(f"{t['id']} {t.get('title', '')!r}" for t in settled))

    # T51/T56: the Code tabs' layout before the page is opened and again after its layout was made (S1: a Code tab beside the page is not
    # touched). Every workbench webview that is not the terminal page is a Code tab, and the check cannot be skipped: with a Code tab asked
    # for (no --no-code-tab) and none found or readable the run FAILs by name, whether or not the page opened.
    code_pages: dict = {}
    try:
        if not a.no_code_tab:
            code_pages = await scan_code_tabs(env, rep)
        code_before = await code_tab_guard_before(code_pages) if code_pages else {}
        if not a.no_code_tab:
            rep.info("Code tabs before: " + (" | ".join(f"{n}: {layout_text(l)}" for n, l in code_before.items()) or "none"))
        opened = await open_page_in_window(env, rep, obs, a, out_dir)
        if not a.no_code_tab:  # T51: the Code tabs beside the page, unchanged (also when the page itself failed a check above)
            await code_tab_guard_after(rep, env, code_before, code_pages, None)
        if opened and a.pidfile:
            # 4. the server the plugin started is the one in its pidfile (terminal-at and force-quit read it from there)
            pid = await wait_until(env, lambda: server_pid_from_pidfile(a.pidfile, env.alive), 20)
            rep.check(pid is not None, "the plugin's pidfile names the live vscode-server", f"pid {pid}" if pid else a.pidfile)
        if opened:
            rep.info("next: terminal-at (GP2, S2, shot 3, S1) and force-quit prepare; both find this page as the one webview that is panel-only")
    finally:
        for p in code_pages.values():
            await p.close()


async def open_page_in_window(env: Env, rep: Reporter, obs, a, out_dir: str) -> bool:
    """Opens the panel-only page and checks it. True when a page was opened (its checks ran or failed by name), False when none was."""
    wait = float(a.wait)
    # 2. the panel-only page, in a partition of its own, from the server the plugin owns
    raw = await obs.ev(open_page_js(PLUGIN_ID, a.vault, build_seed_script(PANEL_SETTINGS), server_ms=int(wait * 1000), trust_template=trust_script_template()), timeout=wait + 60)
    res = parse_page_result(raw)
    status = res["status"]
    if status == "no-plugin":
        raise CannotRun(f"the plugin {PLUGIN_ID} has no `ensureServer` in this Obsidian window")
    if status == "no-server":
        raise CannotRun(f"the plugin's server did not start: {res.get('error', '')}. If Obsidian shows the VS Code licence prompt, run again with --accept-licence (or accept it by hand); a first run also downloads the server, so --wait may need to be longer")
    if status == "already-open":
        rep.info(f"the terminal page is already docked in this window (element #{PAGE_HOLDER_ID}); nothing was started")
        return False
    rep.check(res.get("partition") == PAGE_PARTITION and res.get("partition") != "persist:vscode-workbench", "E3: the page is a <webview> in its own partition, not persist:vscode-workbench", res.get("partition"))
    rep.check(res.get("ready") is True, "the webview loaded the server's origin (dom-ready)")
    rep.check(res.get("seed") == "seeded", f"the panel-only settings ({', '.join(PANEL_SETTINGS)}) were written into that partition's own settings before the workbench loaded", res.get("seed"))

    rep.check(res.get("trust") == "seeded", "the vault folder's Workspace Trust record was written into that partition, as a Code tab does, before the workbench loaded (an untrusted folder opens a modal that swallows the key presses)", res.get("trust"))

    # 3. the new webview target, found by what it is (a webview in the page's own partition: it carries the settings just seeded), not by being
    # new: T44, a Code tab can add or replace a webview of its own at any moment, and then that one is new too
    hits, _others = await find_page_targets(env, 60)
    rep.check(len(hits) == 1, "exactly one workbench webview target is the page (it carries the page's own settings; a Code tab's partition does not)", f"{len(hits)} found among {len(env.list_webviews())} webview target(s)")
    if len(hits) != 1:
        for _t, extra in hits:
            await extra.close()
        return True
    page = hits[0][1]
    try:
        await page.prepare_for_typing()
        painted = await wait_painted(env, page)
        rep.check(painted, "the workbench painted in the new page")
        if painted:
            lay = await make_panel_only(env, page, rep)
            rep.check(panel_only(lay), "S1: in the container's webview, every other part measures 0 px and the panel fills the window", layout_text(lay))
            await page.shot(os.path.join(out_dir, "shot-0-container-page-opened.png"))
    finally:
        await page.close()
    return True


def state_file(a) -> str:
    return a.state or os.path.join(a.out_dir, "force-quit-state.json")


def load_state(a) -> dict:
    try:
        with open(state_file(a), encoding="utf8") as f:
            return json.load(f)
    except (OSError, ValueError):
        raise CannotRun(f"no state at {state_file(a)}: run `force-quit prepare` first (same --out-dir)")


def save_state(a, st: dict) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(state_file(a))), exist_ok=True)
    with open(state_file(a), "w", encoding="utf8") as f:
        json.dump(st, f, indent=2)


def watched_pids(rows: list[dict], st: dict) -> list[int]:
    now = {r["pid"] for r in descendants(rows, st["server_pid"])}
    return sorted(set(st.get("watched", [])) | now)


def tree_block(env: Env, rep: Reporter, title: str, st: dict):
    rows = env.proc_table()
    text = env.ps_text(rows, watched_pids(rows, st))
    if len(text.strip().split("\n")) <= 1:  # only the header: nothing of the tree is left
        text += "(none of the server tree's processes is left)\n"
    rep.block(title, text)


def nohup_row(rows: list[dict], marker: str):
    return next((r for r in rows if marker in r["cmd"] and "nohup" not in r["cmd"]), None)


def http_row(rows: list[dict], port: int):
    return next((r for r in rows if "http.server" in r["cmd"] and str(port) in r["cmd"]), None)


async def run_force_quit_prepare(env: Env, rep: Reporter, a, term, codes: dict, server: dict, out_dir: str):
    sv = server["pid"]
    code_before = await code_tab_guard_before(codes)
    port = env.free_port()
    marker = f"sleep {700 + (os.getpid() % 90)}"
    rep.info(f"server pid {sv}; http.server port {port}; nohup marker `{marker}`")
    await make_panel_only(env, term, rep)
    if not shells_now(env, sv):
        await wait_until(env, lambda: shells_now(env, sv), 20)
    t1 = await new_terminal(env, term, sv)
    how1 = await type_line(env, term, f"python3 -m http.server {port} --bind 127.0.0.1", lambda: http_row(env.proc_table(), port))
    t2 = await new_terminal(env, term, sv)
    how2 = await type_line(env, term, f"nohup {marker} >/dev/null 2>&1 & disown", lambda: nohup_row(env.proc_table(), marker))
    rows = env.proc_table()
    http, nohup = http_row(rows, port), nohup_row(rows, marker)
    view = server_view(rows, sv)
    rep.check(bool(t1 and t2), "E7: two more terminals opened (an http.server and a nohup/disown process go in them)", f"{len(view['shells'])} shells under the server")
    rep.check(http is not None and env.http_status(port) == 200, "E7: `python3 -m http.server` runs under a shell and answers", f"typed with {how1}; port {port}")
    rep.check(nohup is not None, "E7: the nohup/disown process runs", f"typed with {how2}; {nohup['cmd'] if nohup else marker}")
    in_tree = {r["pid"] for r in view["tree"]}
    rep.check(bool(http and nohup and http["pid"] in in_tree and nohup["pid"] in in_tree), "E7: both are in the server's process tree (reachable by the sweep's walk)")
    st = {"server_pid": sv, "data_dir": server["data_dir"], "watched": sorted(in_tree), "http_port": port, "http_pid": http["pid"] if http else None,
          "nohup_marker": marker, "nohup_pid": nohup["pid"] if nohup else None, "phase": "prepared",
          "server_cmd_head": view["tree"][0]["cmd"][:120] if view["tree"] else ""}
    save_state(a, st)
    # shot 4a: ps typed into the page's own terminal (only this server's pids)
    csv = ",".join(str(p) for p in st["watched"])
    await type_line(env, term, f"ps -o pid,ppid,stat,args --forest -p {csv} | cut -c1-170", lambda: True)
    await env.sleep(2)
    await term.shot(os.path.join(out_dir, "shot-4a-container-ps-before-force-quit.png"))
    tree_block(env, rep, "ps -ef --forest, server tree, before the force-quit", st)
    await code_tab_guard_after(rep, env, code_before, codes, None)
    rep.info("next: `force-quit kill --obsidian-pid <pid>`")


def obsidian_ok(row) -> bool:
    return row is not None and "obsidian" in row["cmd"].lower()


async def run_force_quit_kill(env: Env, rep: Reporter, a):
    st = load_state(a)
    sv = st["server_pid"]
    rows = env.proc_table()
    rep.check(running(rows, sv), "the server is running before the force-quit", f"pid {sv}")
    tree_block(env, rep, "ps -ef --forest, server tree, immediately before the force-quit", st)
    pids = a.obsidian_pid or []
    if not pids:
        raise CannotRun("pass --obsidian-pid <pid> (repeat it for the renderer processes you want killed too)")
    by_pid = {r["pid"]: r for r in rows}
    for p in pids:  # SIGKILL only processes that are Obsidian's: a refusal here means a wrong pid, not something to work around
        if not obsidian_ok(by_pid.get(p)):
            raise CannotRun(f"pid {p} is not an Obsidian process ({by_pid[p]['cmd'][:80] if p in by_pid else 'not running'}); refusing to signal it")
    for p in pids:
        env.kill(p, signal.SIGKILL)
    gone = await wait_until(env, lambda: not any(running(env.proc_table(), p) for p in pids), 10)
    rep.check(bool(gone), "Obsidian was force-quit (SIGKILL)", f"pids {pids}")
    await env.sleep(3)
    rows = env.proc_table()
    tree_block(env, rep, "ps -ef --forest, after the force-quit, before the next plugin start", st)
    shells = [r for r in server_view(rows, sv)["shells"]]
    rep.check(running(rows, sv), "after the force-quit the server is still running (it is detached)", f"pid {sv}")
    rep.check(len(shells) > 0, "after the force-quit the interactive shells are still running", f"{len(shells)} shell(s)")
    rep.check(env.http_status(st["http_port"]) == 200, "after the force-quit the http.server still answers", f"port {st['http_port']}")
    rep.check(nohup_row(rows, st["nohup_marker"]) is not None, "after the force-quit the nohup/disown process is still running", st["nohup_marker"])
    st["phase"] = "killed"
    save_state(a, st)
    rep.info("next: start Obsidian again (the plugin's startup runs the sweep), then `force-quit after`")


async def run_force_quit_after(env: Env, rep: Reporter, a):
    st = load_state(a)
    sv = st["server_pid"]
    gone = await wait_until(env, lambda: not running(env.proc_table(), sv), a.wait, 1.0)
    rows = env.proc_table()
    tree_block(env, rep, "ps -ef --forest, after the next plugin start's sweep", st)
    rep.check(bool(gone), "after the next plugin start the sweep took the server down", f"pid {sv}")
    rep.check(not any(r["pid"] in st["watched"] and is_shell(r) for r in rows), "after the sweep no interactive shell of that server is left")
    rep.check(env.http_status(st["http_port"]) == 0, "after the sweep the http.server no longer answers", f"port {st['http_port']}")
    nh = nohup_row(rows, st["nohup_marker"])
    rep.info(f"nohup/disown process after the sweep: {'STILL RUNNING pid ' + str(nh['pid']) + ' (ppid ' + str(nh['ppid']) + ')' if nh else 'gone (the sweep or the shell took it)'}; the spike leaves that choice to Dan (R2)")
    # stop by PID what the helper's own terminals started and the sweep left, when it is still the same command
    for pid, needle in ((nh["pid"] if nh else None, st["nohup_marker"]), (st.get("http_pid"), "http.server")):
        row = next((r for r in rows if r["pid"] == pid), None) if pid else None
        if pid and row and needle in row["cmd"]:
            env.kill(pid, signal.SIGTERM)
            rep.info(f"stopped pid {pid} ({row['cmd'][:60]}), which this check started")
    st["phase"] = "swept"
    save_state(a, st)


# ---------------------------------------------------------------------------------------------------------------------
# the command line
# ---------------------------------------------------------------------------------------------------------------------
def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Container checks for the terminal spike: GP2, S2 and E7/S1, read from the OS.")
    sub = p.add_subparsers(dest="mode", required=True)

    def common(sp, page=True):
        sp.add_argument("--out-dir", default="terminal-check-out", help="where the .txt/.json/screenshots go")
        if page:
            sp.add_argument("--server-pid", type=int, help="pid of the serve-web wrapper under test")
            sp.add_argument("--pidfile", help="the plugin's <runtime>/pids.json: the live vscode-server entry is the server")
            sp.add_argument("--server-data-dir", help="the server's --server-data-dir (default: read from its command line)")
            sp.add_argument("--cdp", default="http://127.0.0.1:9333", help="Obsidian's remote-debugging endpoint")
            sp.add_argument("--vault", required=True, help="the vault folder the terminal page was opened on (also GP2's expected cwd)")
            sp.add_argument("--terminal-target", help="index or url/title part of the panel-only webview (default: the one that is panel-only)")
            sp.add_argument("--target-type", default="webview", help="CDP target type of the workbench pages (webview in Obsidian)")

    tp = sub.add_parser("trust-plugins", help="press the vault trust prompt so the plugin loads (run first on a new vault)")
    common(tp, page=False)
    tp.add_argument("--cdp", default="http://127.0.0.1:9333", help="Obsidian's remote-debugging endpoint")
    tp.add_argument("--plugin-id", default=PLUGIN_ID)
    tp.add_argument("--wait", type=float, default=30, help="seconds to wait for the plugin to load")
    op = sub.add_parser("open-page", help="open a Code tab and the spike's panel-only page (own partition) with the plugin's server")
    common(op)
    op.add_argument("--code-file", help="vault-relative file for the Code tab (default: the plugin's open-spike-file command)")
    op.add_argument("--no-code-tab", action="store_true", help="do not open a Code tab (the S1 check in terminal-at then has no Code tab to compare)")
    op.add_argument("--accept-licence", action="store_true", help="press \"Accept and download\" on the plugin's VS Code server licence prompt (a first run); off by default")
    op.add_argument("--wait", type=float, default=180, help="seconds to wait for the server (a first run downloads it) and for the Code tab")
    common(sub.add_parser("terminal-at", help="GP2, S2, shot 3 and the S1 Code-tab check"))
    fq = sub.add_parser("force-quit", help="E7 and shot 4 in three runs")
    fsub = fq.add_subparsers(dest="phase", required=True)
    pre = fsub.add_parser("prepare")
    common(pre)
    pre.add_argument("--state")
    k = fsub.add_parser("kill")
    common(k, page=False)
    k.add_argument("--obsidian-pid", type=int, action="append")
    k.add_argument("--state")
    af = fsub.add_parser("after")
    common(af, page=False)
    af.add_argument("--wait", type=float, default=30, help="seconds to wait for the sweep")
    af.add_argument("--state")
    return p


async def open_pages(env: Env, a):
    """The terminal page and the Code tabs, as Page objects, found through the CDP target list."""
    targets = list_targets(a.cdp, a.target_type)
    pages, layouts = {}, {}
    for t in targets:
        pages[t["id"]] = Page(await Cdp.open(t["webSocketDebuggerUrl"]), t["id"])
        try:
            layouts[t["id"]] = await pages[t["id"]].layout()
        except Exception:  # noqa: BLE001
            layouts[t["id"]] = {"win": [0, 0], "panel": None}
    term_t, code_ts = pick_targets(targets, layouts, a.terminal_target)
    await pages[term_t["id"]].prepare_for_typing()
    return pages[term_t["id"]], {f"[{targets.index(t)}] {t.get('title') or t['id'][:8]}": pages[t["id"]] for t in code_ts}, pages


async def amain(argv) -> int:
    a = parser().parse_args(argv)
    env = Env()
    rep = Reporter()
    mode = a.mode if a.mode != "force-quit" else f"force-quit-{a.phase}"
    os.makedirs(a.out_dir, exist_ok=True)
    pages = {}
    try:
        if a.mode == "trust-plugins":
            wins = obsidian_window_targets(a.cdp)
            if not wins:
                raise CannotRun(f"no Obsidian window (type page, app://obsidian.md) at {a.cdp}")
            pages["obsidian"] = Page(await Cdp.open(wins[0]["webSocketDebuggerUrl"]), "obsidian")
            await run_trust_plugins(env, rep, pages["obsidian"], a.plugin_id, a.out_dir, a.wait)
        elif a.mode == "open-page":
            wins = obsidian_window_targets(a.cdp)
            if not wins:
                raise CannotRun(f"no Obsidian window (type page, app://obsidian.md) at {a.cdp}")
            pages["obsidian"] = Page(await Cdp.open(wins[0]["webSocketDebuggerUrl"]), "obsidian")
            env.list_webviews = lambda: list_targets(a.cdp, a.target_type)

            async def connect(t):
                return Page(await Cdp.open(t["webSocketDebuggerUrl"]), t["id"])

            env.connect = connect
            await run_open_page(env, rep, pages["obsidian"], a, a.out_dir)
        elif a.mode == "terminal-at" or (a.mode == "force-quit" and a.phase == "prepare"):
            server = resolve_server(env, a)
            env.list_webviews = lambda: list_targets(a.cdp, a.target_type)

            async def connect_target(t):
                return Page(await Cdp.open(t["webSocketDebuggerUrl"]), t["id"])

            env.connect = connect_target
            if a.mode == "terminal-at":
                # T49: the page is reloaded from the Obsidian window (webview.reload()), not through the page's own CDP target
                wins = obsidian_window_targets(a.cdp)
                if not wins:
                    raise CannotRun(f"no Obsidian window (type page, app://obsidian.md) at {a.cdp} to reload the terminal page's webview from")
                obs = Page(await Cdp.open(wins[0]["webSocketDebuggerUrl"]), "obsidian")
                env.extra_pages.append(obs)
                env.reload_page = webview_reloader(obs)
                env.webview_state = webview_state_reader(obs)
                env.load_page = webview_loader(obs)
            term, codes, pages = await open_pages(env, a)
            if a.mode == "terminal-at":
                here = os.path.dirname(os.path.abspath(__file__))
                await run_terminal_at(env, rep, a, term, codes, server, os.path.join(here, "terminal-at-extension.cjs"), a.out_dir)
            else:
                await run_force_quit_prepare(env, rep, a, term, codes, server, a.out_dir)
        elif a.phase == "kill":
            await run_force_quit_kill(env, rep, a)
        else:
            await run_force_quit_after(env, rep, a)
    except CannotRun as e:
        print(f"CANNOT RUN: {e}", file=sys.stderr)
        return 2
    finally:
        for p in list(pages.values()) + list(env.extra_pages):
            await p.close()
    out = os.path.join(a.out_dir, f"{mode}.txt")
    rep.write(out)
    print(f"\n{rep.summary()}\noutput: {out}")
    return rep.exit_code()


def main() -> None:
    sys.exit(asyncio.run(amain(sys.argv[1:])))


if __name__ == "__main__":
    main()
