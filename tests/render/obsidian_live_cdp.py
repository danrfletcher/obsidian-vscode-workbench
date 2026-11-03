"""
CDP helpers for tests/render/obsidian-live-check.py (ticket warkworth-42, PR-4: live checks C2 and C12 in a real Obsidian).

Runs INSIDE the desktop container (its Python and the `websockets` package are there, node is not). It talks to Obsidian's
remote-debugging port: the Obsidian window is the `page` target, and every Code tab's <webview> is its own `webview` target.
Typing into a Code tab's Monaco editor only works through that webview's OWN target: a real mouse click on `.view-lines`
(the `.monaco-editor textarea` is a read-only decoy), then `Input.insertText`. Nothing here prints a server token.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import urllib.request

import websockets

CDP_URL = os.environ.get("OBSIDIAN_CDP", "http://127.0.0.1:9461")
VIEW_TYPE = "vscode-workbench-code"
CTRL, SHIFT = 2, 8  # Input.dispatchKeyEvent modifier bits


def targets() -> list[dict]:
    return json.loads(urllib.request.urlopen(CDP_URL + "/json/list", timeout=5).read())


class Cdp:
    """One CDP websocket: `send` for a method, `ev` for a Runtime.evaluate that returns its value."""

    def __init__(self, ws, label: str):
        self.ws, self.label, self._id = ws, label, 0

    @classmethod
    async def connect(cls, target: dict) -> "Cdp":
        return cls(await websockets.connect(target["webSocketDebuggerUrl"], max_size=None), target.get("title", ""))

    async def send(self, method: str, params: dict | None = None, timeout: float = 30):
        self._id += 1
        mid = self._id
        await self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        while True:
            m = json.loads(await asyncio.wait_for(self.ws.recv(), timeout))
            if m.get("id") == mid:
                return m.get("result", m.get("error"))

    async def ev(self, expr: str, timeout: float = 30):
        r = await self.send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True}, timeout)
        if isinstance(r, dict) and r.get("exceptionDetails"):
            raise RuntimeError("page script threw: " + json.dumps(r["exceptionDetails"])[:300])
        return r.get("result", {}).get("value") if isinstance(r, dict) else r

    async def click(self, x: float, y: float, count: int = 1):
        for typ in ("mouseMoved", "mousePressed", "mouseReleased"):
            await self.send("Input.dispatchMouseEvent", {"type": typ, "x": x, "y": y, "button": "left", "buttons": 0 if typ == "mouseReleased" else 1, "clickCount": count})

    async def key(self, key: str, code: str, vk: int, modifiers: int = 0):
        base = {"key": key, "code": code, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk, "modifiers": modifiers}
        await self.send("Input.dispatchKeyEvent", {"type": "rawKeyDown", **base})
        await self.send("Input.dispatchKeyEvent", {"type": "keyUp", **base})

    async def screenshot(self, path: str):
        s = await self.send("Page.captureScreenshot", {"format": "png"})
        with open(path, "wb") as f:
            f.write(base64.b64decode(s["data"]))

    async def close(self):
        await self.ws.close()


async def page() -> Cdp:
    p = [t for t in targets() if t["type"] == "page" and t["url"].startswith("app://obsidian.md")]
    if not p:
        raise RuntimeError("no Obsidian page target on " + CDP_URL)
    return await Cdp.connect(p[0])


async def webview_for(name: str, timeout: float = 120) -> Cdp:
    """The Code tab webview whose window title names `name` (a unique file name), waited for until its editor has painted."""
    end = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < end:
        for t in targets():
            title = t.get("title", "")
            if t["type"] == "webview" and name in title and "Visual Studio Code" in title:
                w = await Cdp.connect(t)
                try:
                    if await asyncio.wait_for(w.ev("!!document.querySelector('.view-lines')"), 6):
                        return w
                except (asyncio.TimeoutError, RuntimeError):
                    pass
                await w.close()  # a page still loading answers late or not at all: connect again
        await asyncio.sleep(0.7)
    raise RuntimeError(f"no ready Code tab webview titled for {name}")


async def make_dirty(w: Cdp, text: str) -> dict:
    """Real click into the editor, then Input.insertText on the webview's own target. Returns the dirty proof."""
    box = await w.ev("(() => { const e = document.querySelector('.view-lines'); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()")
    await w.click(box[0], box[1])
    await asyncio.sleep(0.5)
    await w.send("Input.insertText", {"text": text})
    await asyncio.sleep(1.5)
    return await w.ev("({ title: document.title.slice(0, 40), dirtyTabs: document.querySelectorAll('.monaco-workbench .tab.dirty').length, shown: document.querySelector('.view-lines').textContent.replace(/\u00a0/g, ' ').includes(" + json.dumps(text.strip()[:12]) + ") })")


async def dirty_tab(name: str, text: str, attempts: int = 3) -> tuple[Cdp, dict]:
    """The Code tab for `name` made dirty. The container's VM can be starved of memory and stall a page for a while, so a stalled
    attempt is dropped and made again on a fresh connection (the text typed is the same, so a repeat does not change what is checked)."""
    for attempt in range(attempts):
        w = await webview_for(name)
        try:
            return w, await asyncio.wait_for(make_dirty(w, text), 60)
        except (asyncio.TimeoutError, RuntimeError):
            await w.close()
    raise RuntimeError(f"could not type into the Code tab for {name} after {attempts} attempts")
