#!/usr/bin/env python3
"""
Container-side S1 measurement for the chrome spike (ticket warkworth-42, PR-1, review issue R1): which route hides each part of the
VS Code workbench, measured INSIDE the Obsidian Code tab's <webview> and not in a Chrome the probe starts itself.

Why it exists. tests/render/chrome-spike-check.mjs measures the routes in headless Chrome on the Mac at a fixed 1000x700 viewport.
That is not what a Code tab is: the pane is Obsidian's, the page runs in the plugin's `persist:vscode-workbench` partition, and the
earlier spike measured the secondary side bar at 162 px in Obsidian where the host probe measured 0x0. This helper drives the real
Code tab through Obsidian's remote-debugging port, the same way tests/render/container-terminal-check.py does (it imports that file for
its CDP client), and runs the same routes with the same page scripts: both come from `chrome-spike-pack.mjs`, which builds the pack
this helper reads from the plugin's own `buildBrowserSeedScript`, `buildTrustSeedScript` and `chromeSettings()` and from
tests/render/chrome-spike-scripts.mjs, the file chrome-spike-check.mjs shares.

It runs INSIDE the container (python3 and the `websockets` package are there, node is not):

  node tests/render/chrome-spike-pack.mjs <config>/pack.json /config/vault        # on the Mac
  python3 tests/render/container-chrome-check.py --pack /config/pack.json --out-dir /tmp/chrome-out --build-label 1.143.1

Prerequisite: Obsidian runs with --remote-debugging-port (9333 by default here), the vault is trusted, the plugin is loaded, the VS
Code server licence is accepted and one Code tab is open (a file of the vault), so the plugin has a server and `webview[partition=
persist:vscode-workbench]` exists. The helper takes the tab's address (token-free: the token is a cookie) from that <webview> and loads
it again for every route; it never prints or stores a token.

Every route is measured in three states (review item T1 of the tester): on a fresh profile, again after a reload of that profile, and on a
profile that already holds saved layout state (R0 with the secondary side bar and the panel opened and saved, the route applied on top).

A route is applied the way the host probe applies it: the origin's IndexedDB/localStorage is cleared (a "fresh profile"), the
<webview> is pointed at the server's bare origin, the route's browser seed (settings + keybindings) and the Workspace Trust record are
written in that page, then the <webview> is pointed at the tab's address again, and the parts are measured with `getBoundingClientRect()`.
Everything goes through the window's `webview.loadURL()`/`reload()` (a CDP Page.navigate/reload on a webview's own target closes it).

Output: PASS / FAIL / INFO lines on stdout and in <out-dir>/container-chrome-check.txt (with .json), screenshots in <out-dir>.
Exit codes: 0 every check held, 1 a check failed, 2 it could not run (no websockets, no CDP target, no <webview>, no pack).
"""
from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import os
import re
import sys
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
WORKBENCH_PARTITION = "persist:vscode-workbench"  # src/code-view.ts: the Code tab's <webview> partition
PLACEHOLDER_HOST = "127.0.0.1:1"  # chrome-spike-pack.mjs PLACEHOLDER_ORIGIN
CLEAR_TYPES = "indexeddb,local_storage,cache_storage,service_workers"  # not cookies: the token is a cookie
DEFAULT_PARTS = ["sideBar", "secondarySideBar", "activityBar", "statusBar", "titleBar", "panel", "tabStrip", "breadcrumb"]


def load_terminal_check():
    """container-terminal-check.py (its CDP client, target lists and reporter) loaded by path: the file name has dashes."""
    spec = importlib.util.spec_from_file_location("container_terminal_check", os.path.join(HERE, "container-terminal-check.py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("container_terminal_check", mod)
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------------------------------------------------
# pure helpers (pinned by tests/integration/container-chrome-check.test.ts)
# ---------------------------------------------------------------------------------------------------------------------
def hidden_parts(measure: dict, part_names=DEFAULT_PARTS) -> list[str]:
    """The parts that are not shown (zero width or height, or display none) in one MEASURE result."""
    parts = (measure or {}).get("parts") or {}
    return [p for p in part_names if not (parts.get(p) or {}).get("shown")]


def px(measure: dict, part: str) -> str:
    """`WxH`, with ` (0px, focusable)` for a part that measures 0x0 but still holds focusable elements (the same words as the host report)."""
    p = ((measure or {}).get("parts") or {}).get(part) or {}
    text = f"{p.get('w', 0)}x{p.get('h', 0)}"
    if not p.get("shown") and (p.get("focusable") or 0) > 0:
        text += " (0px, focusable)"
    return text


def summary(measure: dict, part_names=DEFAULT_PARTS) -> str:
    return "; ".join(f"{p} {px(measure, p)}" for p in part_names)


def fill_origin(script: str, host: str) -> str:
    """The pack is written with the origin http://127.0.0.1:1; put the Code tab's real host:port in its place."""
    return re.sub(re.escape(PLACEHOLDER_HOST) + r"(?!\d)", host, script)


def layout_seed_script(template: str, rows) -> str:
    """The pack's LAYOUT_SEED(null) template with the rows dumped by LAYOUT_DUMP put in place of `null`."""
    marker = "const rows = null;"
    if marker not in template:
        raise ValueError("the layout seed template has no `const rows = null;` line")
    return template.replace(marker, "const rows = " + json.dumps(rows, separators=(",", ":")) + ";", 1)


def route_row(results: dict, part: str) -> str:
    """One line per part: every measured case with its size, in the order the cases ran."""
    return "; ".join(f"{cid} {px(m, part)}" for cid, m in results.items() if m)


def origin_of(href: str) -> str:
    u = urllib.parse.urlsplit(href)
    return f"{u.scheme}://{u.netloc}"


def strip_token(href: str) -> str:
    """The address with any `tkn=` query value removed, for messages."""
    return re.sub(r"tkn=[^&#]*", "tkn=(hidden)", href)


# ---------------------------------------------------------------------------------------------------------------------
# driving the Code tab
# ---------------------------------------------------------------------------------------------------------------------
GET_VIEW_JS = (
    "(() => { const w = [...document.querySelectorAll('webview')].filter((x) => x.getAttribute('partition') === " + json.dumps(WORKBENCH_PARTITION) + "); "
    "if (w.length !== 1) return JSON.stringify({ n: w.length }); "
    "return JSON.stringify({ n: 1, url: w[0].getURL(), size: [w[0].clientWidth, w[0].clientHeight] }); })()"
)


def load_js(href: str) -> str:
    return (
        "(async () => { const w = [...document.querySelectorAll('webview')].find((x) => x.getAttribute('partition') === " + json.dumps(WORKBENCH_PARTITION) + "); "
        "if (!w) return 'no webview'; "
        "try { await w.loadURL(" + json.dumps(href) + "); } catch (e) { const m = String((e && e.message) || e); if (!/ERR_ABORTED/.test(m)) return 'error:' + m.replace(/tkn=[^&'\\s]*/g, 'tkn=(hidden)').slice(0, 120); } "
        "return 'loaded'; })()"
    )


RELOAD_JS = (
    "(() => { const w = [...document.querySelectorAll('webview')].find((x) => x.getAttribute('partition') === " + json.dumps(WORKBENCH_PARTITION) + "); "
    "if (!w) return 'no webview'; w.reload(); return 'reloaded'; })()"
)

CODE_VIEW_TYPE = "vscode-workbench-code"  # src/code-view.ts VIEW_TYPE_CODE


def close_code_tabs_js() -> str:
    return "(() => { window.app.workspace.detachLeavesOfType(" + json.dumps(CODE_VIEW_TYPE) + "); return 'closed'; })()"


def open_code_tab_js(file: str) -> str:
    """A new Code tab on a vault file, the way Obsidian restores one: the plugin's own load (its seed, its trust record) runs."""
    return (
        "(async () => { const leaf = window.app.workspace.getLeaf('tab'); await leaf.setViewState({ type: " + json.dumps(CODE_VIEW_TYPE)
        + ", state: { file: " + json.dumps(file) + " }, active: true }); return 'opened'; })()"
    )


CANCEL_DIALOG_JS = (
    "(() => { const d = document.querySelector('.monaco-dialog-box'); if (!d) return null; const t = d.innerText.replace(/\\s+/g, ' ').trim(); "
    "const c = [...d.querySelectorAll('a.monaco-button')].find((x) => /^Cancel$/.test(x.innerText.trim())); if (c) c.click(); return t; })()"
)


class Tab:
    """The Code tab's <webview>: load an address, find the page target it makes, run scripts in it."""

    def __init__(self, ctc, obs, cdp_url: str, pack: dict, out_dir: str, rep):
        self.ctc, self.obs, self.cdp_url, self.pack, self.out_dir, self.rep = ctc, obs, cdp_url, pack, out_dir, rep
        self.page = None
        self.href = ""
        self.base = ""
        self.host = ""
        self.shots = 0

    async def read_view(self) -> dict:
        raw = await self.obs.ev(GET_VIEW_JS, 15)
        try:
            return json.loads(raw)
        except (TypeError, ValueError):
            return {"n": 0}

    async def attach(self, prefix: str, seconds: float = 60):
        """The CDP target whose address starts with `prefix` (the newest), connected as a Page."""
        deadline = time.time() + seconds
        while time.time() < deadline:
            hits = [t for t in self.ctc.list_targets(self.cdp_url, "webview") if t.get("url", "").startswith(prefix)]
            if hits:
                if self.page is not None:
                    await self.page.close()
                self.page = self.ctc.Page(await self.ctc.Cdp.open(hits[-1]["webSocketDebuggerUrl"]), "code-tab")
                try:
                    await self.page.cdp.send("Page.enable")
                    await self.page.cdp.send("Emulation.setFocusEmulationEnabled", {"enabled": True})
                except Exception:  # noqa: BLE001
                    pass
                return self.page
            await asyncio.sleep(0.5)
        raise self.ctc.CannotRun(f"no webview target at {strip_token(prefix)[:80]} after {seconds:.0f} s")

    async def load(self, href: str):
        res = await self.obs.ev(load_js(href), 60)
        if res != "loaded":
            raise self.ctc.CannotRun(f"the Obsidian window could not load the Code tab's <webview>: {res}")
        return await self.attach(href.split("?")[0])

    async def reload(self):
        if await self.obs.ev(RELOAD_JS, 15) != "reloaded":
            raise self.ctc.CannotRun("the Obsidian window has no Code tab <webview> to reload")
        await asyncio.sleep(1.0)
        return await self.attach(self.base + "/")

    async def ready(self, seconds: float = 90) -> bool:
        deadline = time.time() + seconds
        while time.time() < deadline:
            try:
                if await self.page.ev(self.pack["scripts"]["READY"], 10) is True:
                    return True
            except Exception:  # noqa: BLE001 (the target is between documents)
                pass
            await asyncio.sleep(0.5)
        return False

    async def fresh_code_tab(self, file: str, seconds: float = 90) -> dict:
        """R0 as the plugin makes it: wipe the origin's storage (the profile every earlier run left behind), close the Code tab and open a
        new one on `file`. The plugin's own load then writes its settings; nothing of this helper's is applied yet."""
        note = await self.clear()
        await self.obs.ev(close_code_tabs_js(), 15)
        await asyncio.sleep(2)
        if await self.obs.ev(open_code_tab_js(file), 60) != "opened":
            raise self.ctc.CannotRun("the Obsidian window could not open a new Code tab")
        deadline = time.time() + seconds
        view: dict = {"n": 0}
        while time.time() < deadline:
            view = await self.read_view()
            # the plugin loads the bare origin first (to seed it), then the workbench address that names the folder: wait for that one
            if view.get("n") == 1 and view.get("url", "").startswith("http") and "folder=" in view["url"]:
                break
            await asyncio.sleep(0.5)
        if view.get("n") != 1 or "folder=" not in view.get("url", ""):
            raise self.ctc.CannotRun("the new Code tab did not load the workbench (a <webview> with a folder address) in %.0f s" % seconds)
        self.href = view["url"]
        self.base = origin_of(self.href)
        self.host = urllib.parse.urlsplit(self.href).netloc
        await self.attach(self.base + "/", 60)
        if not await self.ready(seconds):
            raise self.ctc.CannotRun("the new Code tab's page did not render")
        await asyncio.sleep(4)
        return {"storage": note, "size": view["size"]}

    async def clear(self) -> str:
        """A fresh profile for the origin: its IndexedDB, local storage, caches and service workers (not the token cookie)."""
        try:
            await self.page.cdp.send("Storage.clearDataForOrigin", {"origin": self.base, "storageTypes": CLEAR_TYPES})
        except Exception as e:  # noqa: BLE001
            return f"not cleared: {str(e)[:100]}"
        left = await self.page.ev("indexedDB.databases().then((d) => d.map((x) => x.name))", 10)
        return "cleared" if not left else f"cleared, but {len(left)} IndexedDB database(s) remain: {left}"

    async def palette(self, text: str):
        await self.page.click_part(".part.editor")
        await self.page.key("F1", "F1", 112)
        await asyncio.sleep(0.8)
        await self.page.insert_text(text)
        await asyncio.sleep(0.8)
        await self.page.enter()
        await asyncio.sleep(1.5)
        dialog = await self.page.ev(CANCEL_DIALOG_JS, 10)
        if dialog:
            self.rep.info(f"a VS Code dialog opened after \"{text}\" and was cancelled: {str(dialog)[:140]}")
            await asyncio.sleep(0.5)

    async def measure(self) -> dict:
        return await self.page.ev(self.pack["scripts"]["MEASURE"], 20)

    async def shot(self, name: str):
        path = os.path.join(self.out_dir, name)
        try:
            await self.page.shot(path)
            self.rep.info(f"screenshot {path}")
        except Exception as e:  # noqa: BLE001
            self.rep.info(f"no screenshot {name}: {str(e)[:80]}")


async def run_case(tab: Tab, case: dict, rows=None, keep: bool = False, settle: float = 2.5, shot: str | None = None) -> dict | None:
    """One route on a fresh profile (or the current one with `keep`): seed, load the tab's address, run the page script, measure."""
    pack, rep = tab.pack, tab.rep
    rep.info(f".. {case['id']}: {case['label']}")
    note = "kept" if keep else await tab.clear()
    await tab.load(tab.base + "/")
    seeded = await tab.page.ev(fill_origin(case["seed"], tab.host), 30)
    trust = await tab.page.ev(fill_origin(pack["scripts"]["TRUST"], tab.host), 30)
    layout_n = await tab.page.ev(layout_seed_script(pack["scripts"]["LAYOUT_SEED_TEMPLATE"], rows), 30) if rows else None
    await tab.load(tab.href)
    if not await tab.ready():
        rep.check(False, f"{case['id']}: the Code tab's page rendered", "the editor never appeared in 90 s")
        await tab.shot(f"debug-{case['id']}.png")
        return None
    await asyncio.sleep(1.5)
    dialog = await tab.page.ev(CANCEL_DIALOG_JS, 10)
    if dialog:
        rep.info(f"{case['id']}: a VS Code dialog was open on load and was cancelled: {str(dialog)[:140]}")
    if case.get("enterZen"):
        await tab.palette("View: Toggle Zen Mode")
    pressed = await tab.page.ev(case["pageScript"], 30) if case.get("pageScript") else None
    await asyncio.sleep(settle)
    m = await tab.measure()
    rep.info(f"[{case['id']}] storage {note}; seed {str(seeded)[:60]}; trust {str(trust)[:60]}"
             + (f"; layout keys written {layout_n}" if rows else "") + (f"; page script pressed {pressed}" if pressed is not None else ""))
    rep.info(f"[{case['id']}] hidden: {', '.join(hidden_parts(m, pack['partNames'])) or 'none'} | {summary(m, pack['partNames'])} | editor {m['editor']['w']}x{m['editor']['h']} | viewport {m['viewport']['w']}x{m['viewport']['h']}")
    if shot:
        await tab.shot(shot)
    return m


async def after_reload(tab: Tab, case: dict, label: str, settle: float = 3.0) -> dict | None:
    """The same profile, the <webview> reloaded (what Obsidian does when the tab is reopened); the case's page script runs again."""
    await tab.reload()
    if not await tab.ready():
        tab.rep.check(False, f"{label}: the Code tab's page rendered after a reload")
        return None
    await asyncio.sleep(8)
    if case.get("pageScript"):
        await tab.page.ev(case["pageScript"], 30)
    await asyncio.sleep(settle)
    m = await tab.measure()
    tab.rep.info(f"[{label}] hidden: {', '.join(hidden_parts(m, tab.pack['partNames'])) or 'none'} | {summary(m, tab.pack['partNames'])}")
    return m


SAVED_LAYOUT_COMMANDS = ("View: Toggle Secondary Side Bar Visibility", "View: Toggle Panel Visibility")


async def make_prior_state(tab: Tab, r0_case: dict) -> dict | None:
    """A profile that already holds saved layout state and shows everything: today's settings (R0), then the secondary side bar and the
    panel opened from the palette, which the workbench saves. Returns its measurement, or None when the page did not render."""
    if not await run_case(tab, r0_case):
        return None
    for command in SAVED_LAYOUT_COMMANDS:
        await tab.palette(command)
    await asyncio.sleep(2)
    m = await tab.measure()
    names = tab.pack["partNames"]
    tab.rep.info(f"[prior state saved] hidden: {', '.join(hidden_parts(m, names)) or 'none'} | {summary(m, names)}")
    return m


async def three_states(tab: Tab, case: dict, r0_case: dict, out: dict, keys: tuple[str, str, str] | None = None, rows=None,
                       settle: float = 2.5, shot: str | None = None) -> None:
    """One route in the three states review item T1 asks for, each stored in `out` under its own key:
    on a fresh profile, again after a reload of that profile (the route's page script runs again, as the plugin runs it on every load),
    and on a profile that already holds saved layout state (the route is applied on top of it, the storage kept)."""
    fresh, reloaded, saved = keys or (case["label"], f"{case['label']} after reload", f"{case['label']} on saved layout")
    out[fresh] = await run_case(tab, case, rows=rows, settle=settle, shot=shot)
    if out[fresh]:
        out[reloaded] = await after_reload(tab, case, reloaded, settle=max(settle, 3.0))
    prior = await make_prior_state(tab, r0_case)
    if prior and not any(k.startswith("prior state") for k in out):
        out["prior state (R0 + panel + secondary side bar opened)"] = prior
    out[saved] = await run_case(tab, case, rows=rows, keep=True, settle=max(settle, 3.0)) if prior else None


async def measure_all(tab: Tab, by_id: dict, rep) -> dict:
    """Every route of docs/spike-chrome.md S1 in the Code tab's <webview>, each on a fresh profile, after a reload and on a profile that
    already holds saved layout state. Returns {case id: MEASURE result}."""
    pack = tab.pack
    names = pack["partNames"]
    r0 = by_id["r0"]
    out: dict = {}
    # R0 as the plugin loaded the tab (nothing touched yet), then the same profile after a reload.
    out["R0 first load"] = await tab.measure()
    rep.info(f"[R0 first load, the tab as the plugin opened it] hidden: {', '.join(hidden_parts(out['R0 first load'], names)) or 'none'} | {summary(out['R0 first load'], names)} | viewport {out['R0 first load']['viewport']['w']}x{out['R0 first load']['viewport']['h']}")
    await tab.shot("PR-1-S1-container-r0.png")
    out["R0 after reload"] = await after_reload(tab, {}, "R0 after reload")
    prior = await make_prior_state(tab, r0)
    if prior:
        out["prior state (R0 + panel + secondary side bar opened)"] = prior
        out["R0 on saved layout"] = await run_case(tab, r0, keep=True, settle=3.0)
    # R1 .. R4 and the settings together
    for cid, label in (("r1", "R1 Zen"), ("r2", "R2"), ("r3", "R3"), ("r4", "R4"), ("r234", "R2+R3+R4")):
        await three_states(tab, by_id[cid], r0, out, keys=(label, f"{label} after reload", f"{label} on saved layout"), settle=4.0 if cid == "r1" else 2.5)
    # R5: saved layout state. Discover with the close chords, then the same profile after a reload (5a), then the keys in a fresh profile (5b)
    discover = by_id["r5-discover"]
    out["R5 parts closed (close chords)"] = await run_case(tab, discover, settle=3.0)
    rows = None
    if out["R5 parts closed (close chords)"]:
        rows = await tab.page.ev(pack["scripts"]["LAYOUT_DUMP"], 30)
        rep.info(f"[R5 layout state] {len(rows or [])} layout-looking keys in IndexedDB")
        out["R5a same profile, reload, no script"] = await after_reload(tab, {}, "R5a same profile, reload")
        if await make_prior_state(tab, r0):
            out["R5 on saved layout"] = await run_case(tab, discover, keep=True, settle=3.0)
        await three_states(tab, r0, r0, out, keys=("R5b layout keys in a fresh profile", "R5b after reload", "R5b on saved layout"), rows=rows or None)
    # R6a / R6b page scripts
    await three_states(tab, by_id["r6a"], r0, out, keys=("R6a close commands via chords", "R6a after reload", "R6a on saved layout"), settle=3.0)
    await three_states(tab, by_id["r6b"], r0, out, keys=("R6b CSS display none", "R6b after reload", "R6b on saved layout"))
    # the best combination: first load, after a reload, and on a profile that already holds saved layout state
    best = dict(by_id["best"])
    use_rows = rows if rows and "sideBar" in hidden_parts(out.get("R5b layout keys in a fresh profile") or {}, names) else None
    rep.info(f"[best combination] R2+R3+R4 + R6a with a watcher{' + R5b saved layout keys' if use_rows else ''}")
    await three_states(tab, best, r0, out, keys=("best first load", "best after reload", "best on a profile with saved layout"), rows=use_rows, settle=3.0, shot="PR-1-S1-container-best.png")
    return out


def verdicts(out: dict, names=DEFAULT_PARTS) -> dict:
    """What the measurements say: can the side bar be hidden by any route, and does the best route hide each part, in every state."""
    best_keys = ["best first load", "best after reload", "best on a profile with saved layout"]
    side_hidden = {k: ("sideBar" in hidden_parts(out[k], names)) if out.get(k) else None for k in best_keys}
    any_route = any(m and "sideBar" in hidden_parts(m, names) for k, m in out.items() if not k.startswith(("R0", "prior")))
    return {"sideBarHideableByAnyRoute": any_route, "sideBarHiddenByBest": side_hidden,
            "bestHidesAll": {k: (hidden_parts(out[k], names) if out.get(k) else None) for k in best_keys}}


async def amain(argv) -> int:
    a = parse(argv)
    ctc = load_terminal_check()
    rep = ctc.Reporter()
    os.makedirs(a.out_dir, exist_ok=True)
    obs = None
    tab = None
    try:
        if not os.path.exists(a.pack):
            raise ctc.CannotRun(f"no pack at {a.pack} (build it with: node tests/render/chrome-spike-pack.mjs <out.json>)")
        with open(a.pack, encoding="utf8") as f:
            pack = json.load(f)
        wins = ctc.obsidian_window_targets(a.cdp)
        if not wins:
            raise ctc.CannotRun(f"no Obsidian window (type page, app://obsidian.md) at {a.cdp}")
        obs = ctc.Page(await ctc.Cdp.open(wins[0]["webSocketDebuggerUrl"]), "obsidian")
        tab = Tab(ctc, obs, a.cdp, pack, a.out_dir, rep)
        view = await tab.read_view()
        if view.get("n") != 1:
            raise ctc.CannotRun(f"{view.get('n', 0)} <webview> element(s) with partition {WORKBENCH_PARTITION} in the Obsidian window; open exactly one Code tab first")
        tab.href = view["url"]
        tab.base = origin_of(tab.href)
        tab.host = urllib.parse.urlsplit(tab.href).netloc
        rep.info(f"build {a.build_label}; Code tab <webview> {view['size'][0]}x{view['size'][1]} px in the Obsidian window; server {tab.host}")
        await tab.attach(tab.href.split("?")[0], 30)
        fresh = await tab.fresh_code_tab(a.code_file)
        rep.info(f"R0 starts from a new Code tab on {a.code_file} (storage {fresh['storage']}), <webview> {fresh['size'][0]}x{fresh['size'][1]} px")
        by_id = {c["id"]: c for c in pack["cases"]}
        out = await measure_all(tab, by_id, rep)
        names = pack["partNames"]
        v = verdicts(out, names)
        rep.data.update({"build": a.build_label, "webview": {"w": view["size"][0], "h": view["size"][1]},
                         "cases": {k: ({"parts": m["parts"], "editor": m["editor"], "viewport": m["viewport"], "hidden": hidden_parts(m, names)} if m else None) for k, m in out.items()},
                         "verdicts": v})
        rep.info("")
        rep.info(f"S1 in the Obsidian Code tab <webview> on {a.build_label} (width x height in px; 0x0 = hidden):")
        for p in names:
            rep.info(f"S1 {p.ljust(18)} {route_row(out, p)}")
        rep.check(all(m is not None for m in out.values()), "every route rendered in the Code tab", ", ".join(k for k, m in out.items() if m is None) or "all rendered")
        rep.check(v["sideBarHideableByAnyRoute"], f"S1: the side bar can be hidden by some route in the Code tab on {a.build_label}",
                  f"best route: first load {v['sideBarHiddenByBest']['best first load']}, after reload {v['sideBarHiddenByBest']['best after reload']}, saved profile {v['sideBarHiddenByBest']['best on a profile with saved layout']}")
    except ctc.CannotRun as e:
        print(f"CANNOT RUN: {e}", file=sys.stderr)
        return 2
    finally:
        for p in (tab.page if tab else None, obs):
            if p is not None:
                await p.close()
    out_txt = os.path.join(a.out_dir, "container-chrome-check.txt")
    rep.write(out_txt)
    print(f"\n{rep.summary()}\noutput: {out_txt}")
    return rep.exit_code()


def parse(argv):
    p = argparse.ArgumentParser(description="S1 of the chrome spike, measured in the Obsidian Code tab's <webview> (container).")
    p.add_argument("--pack", required=True, help="the JSON written by tests/render/chrome-spike-pack.mjs")
    p.add_argument("--cdp", default="http://127.0.0.1:9333", help="Obsidian's remote-debugging endpoint")
    p.add_argument("--out-dir", default="chrome-check-out", help="where the .txt/.json/screenshots go")
    p.add_argument("--code-file", default="a.js", help="vault-relative file the new Code tab opens (R0 is measured on a Code tab the plugin opens afresh)")
    p.add_argument("--build-label", default="unknown", help="the VS Code version the plugin's server is (for the report)")
    return p.parse_args(argv)


def main() -> None:
    sys.exit(asyncio.run(amain(sys.argv[1:])))


if __name__ == "__main__":
    main()
