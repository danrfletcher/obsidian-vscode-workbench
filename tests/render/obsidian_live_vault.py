"""
Vault, workspace and report helpers for tests/render/obsidian-live-check.py (see obsidian_live_cdp.py). Everything the page needs is
run in the Obsidian window; the fixtures live in one vault folder (`live-check/`) that the run creates and removes again.
"""
from __future__ import annotations

import asyncio
import json
import os
import time

from obsidian_live_cdp import Cdp, VIEW_TYPE

FOLDER = "live-check"
PLUGIN = "app.plugins.plugins['obsidian-vscode-workbench']"

# Every Code tab: its file, leaf id, tab group (parent) id and its place in that group.
CODE_LEAVES_JS = (
    "(() => { const o = []; app.workspace.iterateAllLeaves((l) => { if (l.view.getViewType() === " + json.dumps(VIEW_TYPE) + ") "
    "o.push({ id: l.id, file: l.view.file || '', group: l.parent && l.parent.id, index: l.parent ? l.parent.children.indexOf(l) : -1, "
    "active: app.workspace.activeLeaf === l }); }); return o; })()"
)
# The Obsidian modal that is up now (title and button labels), or null.
MODAL_JS = (
    "(() => { const m = document.querySelector('.modal-container .modal'); if (!m) return null; "
    "return { title: (m.querySelector('h2') || {}).textContent || '', buttons: [...m.querySelectorAll('button')].map((b) => b.textContent.trim()) }; })()"
)


class Report:
    """PASS / FAIL / INFO lines on stdout and in <out-dir>/obsidian-live-check.txt."""

    def __init__(self, out_dir: str):
        os.makedirs(out_dir, exist_ok=True)
        self.out_dir, self.failed, self.lines = out_dir, 0, []

    def _emit(self, line: str):
        print(line, flush=True)
        self.lines.append(line)

    def check(self, line_id: str, ok: bool, what: str, detail: str = ""):
        self.failed += 0 if ok else 1
        self._emit(f"{'PASS' if ok else 'FAIL'} {line_id} {what}" + (f" ({detail})" if detail else ""))

    def info(self, text: str):
        self._emit("INFO " + text)

    def save(self):
        with open(os.path.join(self.out_dir, "obsidian-live-check.txt"), "w") as f:
            f.write("\n".join(self.lines) + "\n")


async def wait_for(fn, timeout: float = 20, step: float = 0.4):
    """Await `fn()` (a coroutine function) until it returns something truthy; the last value (falsy) after the timeout."""
    end = time.monotonic() + timeout
    value = await fn()
    while not value and time.monotonic() < end:
        await asyncio.sleep(step)
        value = await fn()
    return value


async def click_modal_button(p: Cdp, label: str) -> bool:
    """A real mouse click on the button of the modal that is up."""
    pos = await p.ev(
        "(() => { const b = [...document.querySelectorAll('.modal-container .modal button')].find((x) => x.textContent.trim() === " + json.dumps(label) + "); "
        "if (!b) return null; const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()"
    )
    if not pos:
        return False
    await p.click(pos[0], pos[1])
    return True


async def code_leaves(p: Cdp) -> list[dict]:
    return await p.ev(CODE_LEAVES_JS)


async def reset_workspace(p: Cdp, rep: Report):
    """Close every tab of the main area; a dirty Code tab left by an earlier run is discarded at its prompt."""
    await p.ev("(() => { app.workspace.iterateRootLeaves((l) => { l.detach(); }); app.workspace.leftSplit.expand(); return true; })()")
    quiet = 0
    for _ in range(40):
        modal = await p.ev(MODAL_JS)
        leave = next((b for b in ("Discard changes", "Close anyway") if modal and b in modal["buttons"]), None)
        if leave:
            rep.info(f"reset: gave up a Code tab left by an earlier step ({leave}): " + modal["title"])
            await click_modal_button(p, leave)
        await asyncio.sleep(0.4)
        quiet = quiet + 1 if not modal and not await code_leaves(p) else 0
        if quiet >= 3:
            break


async def write_fixture(p: Cdp, name: str, text: str):
    await p.ev(
        "(async () => { if (!app.vault.getAbstractFileByPath(%s)) await app.vault.createFolder(%s); const path = %s; const f = app.vault.getAbstractFileByPath(path); "
        "if (f) await app.vault.modify(f, %s); else await app.vault.create(path, %s); return true; })()"
        % (json.dumps(FOLDER), json.dumps(FOLDER), json.dumps(f"{FOLDER}/{name}"), json.dumps(text), json.dumps(text))
    )


async def read_fixture(p: Cdp, name: str) -> str:
    return await p.ev("app.vault.adapter.read(%s)" % json.dumps(f"{FOLDER}/{name}"))


async def remove_fixtures(p: Cdp):
    await p.ev("(async () => { const f = app.vault.getAbstractFileByPath(%s); if (f) await app.vault.delete(f, true); return true; })()" % json.dumps(FOLDER))


async def open_code(p: Cdp, name: str):
    """The plugin's own open of a Code tab (setup only; what each line asserts is driven by clicks and keys)."""
    await p.ev("(async () => { await %s.openCodeFile(%s); return true; })()" % (PLUGIN, json.dumps(f"{FOLDER}/{name}")))
    await drop_empty_tabs(p)


async def drop_empty_tabs(p: Cdp):
    """Closing the last tab leaves an empty "New tab", which Obsidian's own open (an explorer click) would reuse instead of the
    Code tab. Dan's workspace has none, so the check removes them to stand where a click on a file hands it to the active tab."""
    await p.ev("(() => { app.workspace.iterateRootLeaves((l) => { if (l.view.getViewType() === 'empty') l.detach(); }); return true; })()")


async def restart_server(p: Cdp, rep: Report):
    """Every page load leaves an extension host (hundreds of MB) in the VS Code server for hours after its tab closed, and one run loads a
    dozen pages, so the container's memory fills. With no Code tab open, the plugin's own Restart server drops them all. Its prompt
    names unsaved files or live terminals; terminals are given up, but a prompt that names a file stops the run: nothing is discarded."""
    await p.ev("(() => { window.__liveCheckRestart = %s.restartServer().then(() => 'done', (e) => 'error: ' + e); return true; })()" % PLUGIN)
    modal = await wait_for(lambda: p.ev("(() => { const m = document.querySelector('.modal-container .modal'); return m && m.textContent.includes('Restart the VS Code server') ? m.textContent : null; })()"), 8)
    if modal:
        if "unsaved" in modal:
            raise RuntimeError("the Restart server prompt names unsaved changes, so nothing was discarded: " + modal[:200])
        await click_modal_button(p, "Restart and discard changes")
    result = await p.ev("window.__liveCheckRestart", 180)
    rep.info(f"the VS Code server was restarted to drop the extension hosts of closed tabs: {result}")
