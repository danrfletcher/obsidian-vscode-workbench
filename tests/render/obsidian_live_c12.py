"""
C12 of tests/render/obsidian-live-check.py: two Code tabs in an Obsidian split (`getLeaf('split', 'vertical')`, so two tab groups).
Each shows only its editor (no side bar, activity bar, status bar, title bar, panel, tab strip or second editor group). A file opened from
the editor with Cmd+P quick open (Ctrl+P in the Linux container), after a real mouse click on that pane, lands as a NEW tab in THAT pane's
tab group, in front; the other pane is untouched and no tab navigates in place.
"""
from __future__ import annotations

import asyncio
import json

from obsidian_live_cdp import CTRL, VIEW_TYPE, Cdp, webview_for
from obsidian_live_vault import FOLDER, Report, code_leaves, open_code, reset_workspace, restart_server, wait_for, write_fixture

SHAPE_JS = """(() => {
  const shown = (s) => [...document.querySelectorAll(s)].some((e) => e.offsetWidth > 0 && e.offsetHeight > 0);
  return { editorShown: shown('.part.editor'), editors: document.querySelectorAll('.part.editor .monaco-editor').length,
    groups: document.querySelectorAll('.editor-group-container').length,
    chromeShown: ['.part.sidebar', '.part.activitybar', '.part.statusbar', '.part.titlebar', '.part.panel', '.part.auxiliarybar', '.tabs-container'].filter(shown) };
})()"""
# The centre of the <webview> of the Code tab that shows `file`, in the Obsidian window.
WEBVIEW_RECT_JS = """(() => { const l = app.workspace.getLeavesOfType(%s).find((x) => x.view.file === %s); const r = l.view.contentEl.querySelector('webview').getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2]; })()"""
QUICK_INPUT_JS = "(() => { const q = document.querySelector('.quick-input-widget'); return !!q && getComputedStyle(q).display !== 'none'; })()"
# The highlighted entry (what Enter takes) is the file typed: the first row, after the list has stopped re-filtering.
QUICK_ROW_JS = "(() => { const rows = [...document.querySelectorAll('.quick-input-list .monaco-list-row')]; return rows.length > 0 && rows[0].textContent.includes(%s); })()"


async def only_its_editor(rep: Report, tag: str, name: str, step: str):
    w = await webview_for(name)
    shape = await w.ev(SHAPE_JS)
    ok = shape["editorShown"] and shape["editors"] == 1 and shape["groups"] == 1 and not shape["chromeShown"]
    rep.check(tag, ok, f"{step}: the Code tab for {name} shows only its editor", json.dumps(shape))
    await w.close()


async def quick_open_from(p: Cdp, rep: Report, tag: str, pane_file: str, target: str):
    """Click the pane that shows `pane_file`, press Ctrl+P in its page, type `target`, press Enter."""
    pos = await p.ev(WEBVIEW_RECT_JS % (json.dumps(VIEW_TYPE), json.dumps(f"{FOLDER}/{pane_file}")))
    await p.click(pos[0], pos[1])
    await asyncio.sleep(1)  # the click moves the keyboard focus into that pane's page
    active = [x["file"].split("/")[-1] for x in await code_leaves(p) if x["active"]]
    rep.info(f"Obsidian's active Code tab when the open starts from {pane_file}: {active} (the plugin makes the opening pane active before it makes the new tab)")
    w = await webview_for(pane_file)
    for _ in range(4):
        await w.key("p", "KeyP", 80, CTRL)
        if await wait_for(lambda: w.ev(QUICK_INPUT_JS), 5):
            break
    rep.check(tag, bool(await w.ev(QUICK_INPUT_JS)), f"Cmd+P quick open is up in the editor of {pane_file}")
    await w.send("Input.insertText", {"text": target})
    listed = await wait_for(lambda: w.ev(QUICK_ROW_JS % json.dumps(target)), 30)
    rep.check(tag, bool(listed), f"quick open offers {target} first")
    await asyncio.sleep(2)
    rep.check(tag, bool(await w.ev(QUICK_ROW_JS % json.dumps(target))), f"quick open still offers {target} first, so Enter takes it")
    await w.key("Enter", "Enter", 13)
    return w


async def run_c12(p: Cdp, rep: Report):
    tag = "C12"
    await reset_workspace(p, rep)
    await restart_server(p, rep)
    for n in ("c12-p1.js", "c12-p2.js", "c12-t1.js", "c12-t2.js"):
        await write_fixture(p, n, "export const %s = 1;\n" % n.replace("-", "_").replace(".js", ""))
    await open_code(p, "c12-p1.js")
    await p.ev("(async () => { const l = app.workspace.getLeaf('split', 'vertical'); await l.setViewState({ type: %s, state: { file: %s }, active: true }); return true; })()" % (json.dumps(VIEW_TYPE), json.dumps(f"{FOLDER}/c12-p2.js")))
    leaves = await wait_for(lambda: two_panes(p), 60)
    rep.check(tag, bool(leaves), "two Code tabs, each in its own tab group of an Obsidian split", json.dumps(leaves))
    if not leaves:
        return
    await only_its_editor(rep, tag, "c12-p1.js", "in the split")
    await only_its_editor(rep, tag, "c12-p2.js", "in the split")
    for pane, target in (("c12-p1.js", "c12-t1.js"), ("c12-p2.js", "c12-t2.js")):
        w = await quick_open_from(p, rep, tag, pane, target)
        group = next(x["group"] for x in leaves if x["file"].endswith(pane))
        now = await wait_for(lambda: landed(p, target), 90)
        new = next((x for x in now or [] if x["file"].endswith(target)), None)
        rep.check(tag, bool(new) and new["group"] == group and new["index"] == 1 and new["active"], f"{target}, opened from the editor of {pane}, is a new tab in that pane's tab group, in front", json.dumps(new))
        await w.close()
        await only_its_editor(rep, tag, target, "after the open")
    final = await code_leaves(p)
    byfile = {x["file"].split("/")[-1]: x for x in final}
    rep.check(tag, len(final) == 4 and byfile["c12-p1.js"]["group"] == byfile["c12-t1.js"]["group"] and byfile["c12-p2.js"]["group"] == byfile["c12-t2.js"]["group"]
              and byfile["c12-p1.js"]["group"] != byfile["c12-p2.js"]["group"], "each pane's tab group holds its own two files, and neither tab navigated in place", json.dumps([[x["file"].split("/")[-1], x["group"][:4]] for x in final]))
    await p.screenshot(f"{rep.out_dir}/c12-split-after-opens.png")


async def two_panes(p: Cdp):
    leaves = await code_leaves(p)
    return leaves if len(leaves) == 2 and leaves[0]["group"] != leaves[1]["group"] else None


async def landed(p: Cdp, target: str):
    leaves = await code_leaves(p)
    return leaves if any(x["file"].endswith(target) for x in leaves) else None
