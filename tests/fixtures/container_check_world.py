"""
A pretend machine for tests/integration/container-terminal-check.test.ts: a process table, a server data dir, a vault, and a page
that behaves the way the Obsidian webview does for the checks in tests/render/container-terminal-check.py (a new terminal is a new
shell under the pty host, a request.json is taken and turned into a shell whose cwd is the folder asked for, a typed line becomes a
process or a file). Nothing here starts a real process.
"""
from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, "..", "render", "container-terminal-check.py")
spec = importlib.util.spec_from_file_location("ctc", HELPER)
assert spec is not None and spec.loader is not None
m = importlib.util.module_from_spec(spec)
sys.modules["ctc"] = m
spec.loader.exec_module(m)

OBSIDIAN_PID = 5000
SERVER_PID = 100


def row(pid, ppid, args, state="S"):
    return {"pid": pid, "ppid": ppid, "state": state, "args": args, "cmd": " ".join(args)}


class World:
    def __init__(self, consume=True, extra_server=False, missing_child=None):
        self.tmp = tempfile.mkdtemp(prefix="ctc-world-")
        self.data = os.path.join(self.tmp, "server data")  # spaces on purpose
        self.vault = os.path.join(self.tmp, "vault")
        self.out = os.path.join(self.tmp, "out")
        for d in (self.data, self.vault, self.out):
            os.makedirs(d)
        self.consume = consume
        # T64: what the pty host does for a folder that does not exist. None: nothing. "gone": it forks a child that has no readable cwd
        # (it failed its chdir) and is gone by the next tick. "flash": the child still has its parent's cwd for one tick, then is gone.
        self.missing_child = missing_child
        self.flashing = []
        self.seeded = False
        self.killed = []
        self.rows = []
        self.cwds = {}
        self.next_pid = 1000
        self.signals = []
        flag = ["--server-data-dir", self.data]
        self.rows += [
            row(SERVER_PID, 1, ["bash", "/opt/code", "serve-web", *flag]),
            row(101, 100, ["node", "cli.js", "serve-web", *flag]),
            row(102, 101, ["node", "out/server-main.js"]),
            row(103, 102, ["node", "out/bootstrap-fork", "--type=ptyHost"]),
            row(OBSIDIAN_PID, 1, ["/opt/Obsidian/obsidian", "--no-sandbox"]),
        ]
        self.shell(self.vault)  # the shell the panel started
        if extra_server:
            self.rows += [row(200, 1, ["bash", "/opt/code", "serve-web", *flag])]

    # ---- the machine
    def shells(self):
        return [r for r in self.rows if r["ppid"] == 103 and m.is_shell(r)]

    def shell(self, cwd):
        pid = self.next_pid
        self.next_pid += 1
        self.rows.append(row(pid, 103, ["/bin/zsh", "-il"]))
        self.cwds[pid] = cwd
        return pid

    def last_shell(self):
        return self.shells()[-1]["pid"]

    @property
    def ext_dir(self):
        return os.path.join(self.data, "extensions", m.EXT_DIR_NAME)

    def tick(self):
        if self.flashing:
            gone = set(self.flashing)
            self.rows = [r for r in self.rows if r["pid"] not in gone]
            self.flashing = []
        f = os.path.join(self.ext_dir, "request.json")
        if self.consume and os.path.exists(f):
            req = json.load(open(f, encoding="utf8"))
            if os.path.isdir(req["cwd"]):
                self.shell(req["cwd"])
            elif self.missing_child:
                pid = self.shell(self.vault if self.missing_child == "flash" else None)
                if self.missing_child == "gone":
                    del self.cwds[pid]
                self.flashing.append(pid)
            os.remove(f)

    def run_line(self, text):
        sh = self.last_shell()
        t = re.match(r"^pwd \| tee '(.*)'$", text)
        if t:
            with open(t.group(1), "w", encoding="utf8") as f:
                f.write(self.cwds[sh] + "\n")
        port = re.match(r"^python3 -m http\.server (\d+) --bind", text)
        if port:
            pid = self.next_pid
            self.next_pid += 1
            self.rows.append(row(pid, sh, ["python3", "-m", "http.server", port.group(1), "--bind", "127.0.0.1"]))
        nh = re.match(r"^nohup (sleep \d+) ", text)
        if nh:
            pid = self.next_pid
            self.next_pid += 1
            self.rows.append(row(pid, sh, nh.group(1).split(" ")))

    def sweep(self, kill_nohup=False):
        """The plugin's next start: the server tree goes (the nohup process is re-parented to init and left, or killed with the tree)."""
        tree = {r["pid"] for r in m.descendants(self.rows, SERVER_PID)}
        keep_nohup = [r for r in self.rows if r["pid"] in tree and r["args"][0] == "sleep" and not kill_nohup]
        self.rows = [r for r in self.rows if r["pid"] not in tree or r in keep_nohup]
        for r in keep_nohup:
            r["ppid"] = 1

    def kill(self, pid, sig):
        self.signals.append((pid, int(sig)))
        if int(sig) == 9 or int(sig) == 15:
            self.rows = [r for r in self.rows if r["pid"] != pid]

    def http_status(self, port):
        return 200 if any("http.server" in r["cmd"] and str(port) in r["cmd"] for r in self.rows) else 0

    def env(self):
        e = m.Env()
        e.proc_table = lambda: [dict(r) for r in self.rows]
        e.read_cwd = lambda pid: self.cwds.get(pid)

        async def sleep(_s):
            self.tick()

        e.sleep = sleep
        e.alive = lambda pid: any(r["pid"] == pid for r in self.rows)
        e.http_status = self.http_status
        e.ps_text = lambda rows, pids: m.render_forest(rows, pids)
        e.kill = self.kill
        e.free_port = lambda: 45678

        async def reload_page(page):  # T49: the pretend machine's page reloads itself (the real helper reloads the <webview> from the Obsidian window)
            await page.reload()

        e.reload_page = reload_page
        return e


class FakePage:
    """What the Obsidian webview does, as far as the checks look."""

    layout = m.Page.layout
    entry_rects = m.Page.entry_rects
    focus_terminal = m.Page.focus_terminal

    def __init__(self, world, lay, react_to_seed=None, deliver_text=True, deliver_keys=True, dialog=None, keys_work=False, name="term-1", blank_after_reload=None, is_terminal=True, needs_real_click=False, drop_keys=0):
        self.w = world
        self.name = name
        self.is_terminal = is_terminal  # T44/T46: the page's partition carries the page's own settings (PAGE_MARK_JS answers "page"); a Code tab's does not
        self.needs_real_click = needs_real_click  # T45: the layout keys reach the workbench only after a real mouse press (click_center), not after a DOM click
        self.focus = None  # T50: where the last real press landed: None, a part name, or "terminal"
        self.events = []  # T50: in order: ("press", part), ("press-center", where it landed), ("key", code, modifiers)
        self.drop_keys = drop_keys  # T50: the first N layout chords are swallowed (to see a retry press again)
        self.clicks = 0
        self.blank_after_reload = blank_after_reload  # T38: None, or "navigate" (paints again after a navigate), or "never"; until then the page shows an error text
        self.reloaded = False
        self.healed = False
        self.navigated = []
        self.lay = dict(lay)
        self.dialog = dialog  # T37: a modal dialog in the page, {"dialog": text, "buttons": [...]}; the layout keys do nothing while it is up
        self.keys_work = keys_work  # the layout keys (Ctrl+backtick, Ctrl+B) change self.lay, as VS Code would
        self.pressed = []
        self.react_to_seed = react_to_seed
        self.deliver_text = deliver_text
        self.deliver_keys = deliver_keys
        self.shots = []
        self.reloads = 0

    def unpainted(self):
        return self.reloaded and self.blank_after_reload is not None and not self.healed

    async def ev(self, expr, timeout=30):
        if expr == "location.href":
            return "http://127.0.0.1:45123/?tkn=SECRET-TOKEN&folder=%2Fv"
        if expr == m.PAINTED_DETAIL_JS:
            bad = self.unpainted()
            return json.dumps({"href": "http://127.0.0.1:45123/?tkn=(hidden)&folder=%2Fv", "title": "", "readyState": "complete", "painted": not bad,
                               "parts": {"statusbar": None, "editor": None if bad else "800x300", "panel": None},
                               "body": "ERR_CONNECTION_REFUSED" if bad else "VS Code"})
        if expr == m.PAGE_MARK_JS:
            return "page" if self.is_terminal else "other"
        if expr == m.PAGE_STATE_JS:
            return json.dumps({"ready": "complete", "title": "VS Code", "blocked": bool(self.dialog), "dialog": (self.dialog or {}).get("dialog", ""),
                               "buttons": (self.dialog or {}).get("buttons", []), "active": "body", "body": "fake page"})
        if expr == m.PRESS_TRUST_JS:
            if not self.dialog:
                return "no dialog"
            if not any(b.lower().startswith("yes, i trust") for b in self.dialog["buttons"]):
                return "no trust button"
            self.pressed.append("trust")
            self.dialog = None
            return "pressed"
        if expr == m.LAYOUT_JS:
            lay = self.react_to_seed if (self.react_to_seed and self.w.seeded) else self.lay
            return json.dumps(lay)
        if expr == m.PAINTED_JS:
            return not self.unpainted()
        if expr == m.ENTRY_RECTS_JS:
            n = len(self.w.shells())
            return json.dumps([[1280, 10 + 30 * i, 100, 24] for i in range(n)] if n >= 2 else [])
        if expr == m.FOCUS_JS:
            return "focused"
        if "indexedDB" in expr:
            self.w.seeded = True
            return "seeded"
        return None

    async def key(self, key, code, vk, modifiers=0):
        self.events.append(("key", code, modifiers))
        chord = code == "KeyB" or (code == "Backquote" and modifiers == m.CTRL)
        if chord and self.drop_keys:
            self.drop_keys -= 1  # swallowed
        elif chord and self.keys_work and not self.dialog and (self.focus is not None or not self.needs_real_click):
            if code == "Backquote":
                self.lay["panel"] = [self.lay["win"][0] - 8, self.lay["win"][1] - 8] if not self.lay.get("panel") else None
                self.lay["editor"] = [0, 0]
            if code == "KeyB" and self.focus != "terminal":  # T50: with the terminal focused Ctrl+B and Ctrl+Alt+B are the shell's
                bar = "auxiliarybar" if modifiers & m.ALT else "sidebar"
                self.lay[bar] = [0, self.lay["win"][1] - 8] if self.lay.get(bar) and self.lay[bar][0] else [252, self.lay["win"][1] - 8]
        if code == "Backquote" and modifiers == (m.CTRL | m.SHIFT):
            self.w.shell(self.w.vault)

    async def click_center(self):
        """The middle of the window: the terminal once the panel is open (T50), the editor before."""
        self.clicks += 1
        self.focus = "terminal" if m.panel_visible(self.lay) else "editor"
        self.events.append(("press-center", self.focus))

    async def click_part(self, selector):
        """T50: a press inside the named part; nothing to press when that part is hidden. Pressing the panel gives the terminal the focus."""
        part = selector[len(".part."):]
        rect = self.lay.get(part)
        if not rect or rect[0] <= 0 or rect[1] <= 0:
            return False
        self.clicks += 1
        self.focus = "terminal" if part == "panel" else part
        self.events.append(("press", part))
        return True

    async def page_mark(self):
        return await m.Page.page_mark(self)

    async def insert_text(self, text):
        if self.deliver_text:
            self.w.run_line(text)

    async def type_chars(self, text):
        if self.deliver_keys:
            self.w.run_line(text)

    async def enter(self):
        pass

    async def shot(self, path):
        with open(path, "wb") as f:
            f.write(b"png")
        self.shots.append(path)

    async def reload(self):
        self.reloads += 1
        self.reloaded = True

    async def navigate(self, url):
        self.navigated.append(url)
        if self.blank_after_reload == "navigate":
            self.healed = True

    async def prepare_for_typing(self):
        pass

    async def close(self):
        pass


class FakeObsidian:
    """The Obsidian window as the trust check sees it: a trust prompt that loads nothing until its button is pressed (the T18 symptom)."""

    PLUGIN = m.PLUGIN_ID

    def __init__(self, modal=True, button_works=True, enable_works=True, loaded=False):
        self.modal = modal
        self.loaded = loaded
        self.button_works = button_works
        self.enable_works = enable_works
        self.calls = []
        self.shots = []

    def state(self):
        return {"app": True, "modal": self.modal, "restricted": self.modal, "enabled": True, "loaded": self.loaded, "commands": 3 if self.loaded else 0}

    async def ev(self, expr):
        if expr == m.plugin_state_js(self.PLUGIN):
            return json.dumps(self.state())
        if expr == m.CLICK_TRUST_JS:
            self.calls.append("click")
            if not self.modal:
                return "no button"
            if self.button_works:
                self.modal, self.loaded = False, True
            return "clicked"
        if expr == m.enable_plugin_js(self.PLUGIN):
            self.calls.append("enable")
            if self.enable_works:
                self.modal, self.loaded = False, True
            return "enabled"
        return None

    async def shot(self, path):
        with open(path, "wb") as f:
            f.write(b"png")
        self.shots.append(os.path.basename(path))


class FakeWindow(FakeObsidian):
    """The Obsidian window as open-page sees it: a loaded plugin whose server may or may not start, the Code tab command, the docked
    webview, and the CDP list of workbench webviews that grows when each of them opens."""

    def __init__(self, world, *, loaded=True, server="ok", seed="seeded", trust="seeded", partition=None, page_status="opened", code="opened", code_target=True, page_target=True, panel=None, licence_modal=False, page=None, late_code=False, code_changes=False):
        super().__init__(modal=False, loaded=loaded)
        self.world = world
        self.server, self.seed, self.trust = server, seed, trust
        self.partition = m.PAGE_PARTITION if partition is None else partition
        self.page_status, self.code, self.code_target, self.page_target = page_status, code, code_target, page_target
        self.targets = []
        self.page = page or FakePage(world, panel or PANEL_ONLY)
        self.scripts = []
        self.licence_modal = licence_modal
        self.armed = False
        self.pressed = 0
        self.late_code = late_code  # T44: a Code tab on a file goes through two webviews: "code-2" is listed three list calls after "code-1"
        self.code_changes = code_changes  # T51: the Code tab's layout changes when the page is opened
        self.listed_after_code = 0

    def list_webviews(self):
        if self.targets and any(t["id"] == "code-1" for t in self.targets):
            self.listed_after_code += 1
            if self.late_code and self.listed_after_code >= 3 and not any(t["id"] == "code-2" for t in self.targets):
                self.targets.append({"id": "code-2", "type": "webview", "url": "http://127.0.0.1:5000/?tkn=SECRET&folder=%2Fv&payload=%5B%5B%22openFile%22%5D%5D", "webSocketDebuggerUrl": "ws://x/code-2"})
        return [dict(t) for t in self.targets]

    async def ev(self, expr, timeout=30):
        if expr.startswith("(() => { const K = "):  # accept_licence_js / disarm_licence_js: the timer in the window, as far as the helper can tell
            if "setInterval" in expr:
                self.scripts.append(("arm-licence", expr))
                self.armed = True
                return "armed"
            self.scripts.append(("disarm-licence", expr))
            was, self.armed = self.armed, False
            return json.dumps({"armed": was, "pressed": self.pressed})
        asks_server = "setViewState" in expr or "openCodeFile" in expr or "const PLUGIN = " in expr
        if asks_server and self.licence_modal and self.armed:
            self.licence_modal, self.pressed = False, self.pressed + 1  # the prompt shows at the first thing that needs the server; the timer presses it
        held = asks_server and self.licence_modal  # nobody pressed it: the server start (and the tab, and the page) wait on the prompt
        if "setViewState" in expr or "openCodeFile" in expr:
            self.scripts.append(("code-tab", expr))
            if self.code == "opened" and self.code_target and not held:
                self.targets.append({"id": "code-1", "type": "webview", "url": "http://127.0.0.1:5000/?tkn=SECRET&folder=%2Fv", "webSocketDebuggerUrl": "ws://x/code-1"})
            return self.code
        if "const PLUGIN = " in expr:
            self.scripts.append(("page", expr))
            if held:
                return json.dumps({"status": "no-server", "error": "the server did not start in time"})
            if self.page_status == "opened" and self.page_target:
                self.targets.append({"id": "term-1", "type": "webview", "url": "http://127.0.0.1:5000/?tkn=SECRET&folder=%2Fv", "webSocketDebuggerUrl": "ws://x/term-1"})
            if self.page_status == "opened":
                self.world.seeded = True  # T51: a Code tab beside it may be changed by the page being opened (react_to_seed)
            res = {"status": self.page_status}
            if self.page_status == "opened":
                res.update(ready=True, seed=self.seed, partition=self.partition)
                if self.trust is not None:
                    res["trust"] = self.trust
            if self.page_status == "no-server":
                res["error"] = "the server did not start in time"
            return json.dumps(res)
        return await super().ev(expr)

    def env(self):
        e = self.world.env()
        e.list_webviews = self.list_webviews

        async def connect(target):
            if target["id"].startswith("term"):
                return self.page
            return FakePage(self.world, CODE_TAB, name=target["id"], is_terminal=False, react_to_seed={**CODE_TAB, "panel": [1092, 292]} if self.code_changes else None)

        e.connect = connect
        return e


PANEL_ONLY = {"win": [1400, 900], "titlebar": None, "activitybar": None, "sidebar": [0, 892], "auxiliarybar": None, "editor": [0, 0], "panel": [1392, 892], "statusbar": None}
SIDE_BAR_SHOWING = {"win": [1400, 900], "titlebar": None, "activitybar": None, "sidebar": [252, 892], "auxiliarybar": [248, 892], "editor": [508, 892], "panel": None, "statusbar": None}
CODE_TAB = {"win": [1400, 900], "titlebar": None, "activitybar": None, "sidebar": [296, 892], "auxiliarybar": None, "editor": [1092, 892], "panel": None, "statusbar": None}


def args(world, **kw):
    base = dict(vault=world.vault, out_dir=world.out, state=None, obsidian_pid=[OBSIDIAN_PID], wait=0, code_file=None, no_code_tab=False, pidfile=None, accept_licence=False)
    base.update(kw)
    return argparse.Namespace(**base)


def run(coro):
    return asyncio.run(coro)
