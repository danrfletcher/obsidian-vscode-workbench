"""
C2 of tests/render/obsidian-live-check.py: a Code tab with unsaved edits is handed another file. Two ways, both live:

  click     a REAL mouse click on the file in Obsidian's file explorer. A Code view is not a navigation view (`view.navigation` is false),
            so Obsidian's own open (`getLeaf(false)`) gives the file a NEW tab and never hands it to the Code tab: the old tab keeps its
            file and its unsaved edits, no prompt is needed, and no Code tab shows two files.
  openFile  `leaf.openFile(file)` on the active, dirty Code tab, the call another plugin or Obsidian itself makes to navigate a tab in
            place. The unsaved-changes prompt must appear; Discard changes and Save then show the new file alone in that same tab;
            Cancel keeps the old file (still unsaved) and opens the new one in a new tab. No Code tab ever shows two files.
"""
from __future__ import annotations

import asyncio
import json

from obsidian_live_cdp import VIEW_TYPE, Cdp, dirty_tab, webview_for
from obsidian_live_vault import FOLDER, MODAL_JS, Report, click_modal_button, code_leaves, open_code, read_fixture, reset_workspace, restart_server, wait_for, write_fixture

EDIT = "// unsaved edit from the live check\n"
BODY = "export const value = 1;\n"
# The centre of the explorer row for `path` (the folder is revealed and the row scrolled into view first).
EXPLORER_ROW_JS = """(async (path) => {
  app.workspace.leftSplit.expand();
  const ex = app.workspace.getLeavesOfType('file-explorer')[0];
  ex.view.revealInFolder(app.vault.getAbstractFileByPath(path));
  await new Promise((r) => setTimeout(r, 800));
  const item = ex.view.fileItems[path];
  const el = item && (item.selfEl || item.titleEl);
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  await new Promise((r) => setTimeout(r, 300));
  const r = el.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
})(%s)"""
# What the page of one Code tab holds: how many editors and tab-strip tabs it has, and the names the tab strip carries.
PAGE_SHAPE_JS = ("({ title: document.title.slice(0, 50), editors: document.querySelectorAll('.monaco-editor').length, "
                 "tabs: [...document.querySelectorAll('.monaco-workbench .tabs-container .tab')].map((t) => t.getAttribute('aria-label') || t.textContent) })")


# Hand the active Code tab (the one that shows `a`) the file `b`, the way Obsidian navigates a tab in place.
OPEN_FILE_JS = """(() => { const leaf = app.workspace.getLeavesOfType('%s').find((l) => l.view.file === %s);
  app.workspace.setActiveLeaf(leaf, { focus: true }); void leaf.openFile(app.vault.getAbstractFileByPath(%s)); return true; })()"""


async def hand_over_by_explorer_click(p: Cdp, path: str):
    pos = await p.ev(EXPLORER_ROW_JS % json.dumps(path))
    if not pos:
        return False
    await p.click(pos[0], pos[1])
    return True


async def hand_over(p: Cdp, how: str, a: str, b: str):
    if how == "click":
        return await hand_over_by_explorer_click(p, f"{FOLDER}/{b}")
    return await p.ev(OPEN_FILE_JS % (VIEW_TYPE, json.dumps(f"{FOLDER}/{a}"), json.dumps(f"{FOLDER}/{b}")))


async def c2_variant(p: Cdp, rep: Report, variant: str, button: str):
    tag = f"C2 openFile-{variant}"
    a, b = f"c2-{variant}-a.js", f"c2-{variant}-b.js"
    await write_fixture(p, a, BODY)
    await write_fixture(p, b, "export const other = 2;\n")
    await open_code(p, a)
    w, proof = await dirty_tab(a, EDIT)
    rep.check(tag, proof["title"].startswith("●") and proof["shown"], "the Code tab holds genuinely unsaved edits (typed through its own target)", json.dumps(proof))
    before = [x for x in await code_leaves(p) if x["file"].endswith(a)]
    rep.check(tag, bool(await hand_over(p, "openFile", a, b)), f"the active Code tab is handed {b} with leaf.openFile")
    modal = await wait_for(lambda: p.ev(MODAL_JS), 15)
    rep.check(tag, bool(modal) and a in modal["title"] and modal["buttons"] == ["Cancel", "Discard changes", "Save"], "the unsaved-changes prompt appears for the dirty tab", json.dumps(modal))
    await p.screenshot(f"{rep.out_dir}/c2-{variant}-prompt.png")
    await click_modal_button(p, button)
    await asyncio.sleep(1)
    leaves = await wait_for(lambda: settled(p, variant, a, b), 90)
    names = sorted(x["file"].split("/")[-1] for x in await code_leaves(p))
    on_disk = await read_fixture(p, a)
    if variant == "cancel":
        old = [x for x in leaves if x["file"].endswith(a)]
        new = [x for x in leaves if x["file"].endswith(b)]
        rep.check(tag, len(old) == 1 and len(new) == 1 and old[0]["id"] == before[0]["id"] and new[0]["id"] != old[0]["id"], "Cancel: the old tab keeps its file and the new file is in a new tab", str(names))
        rep.check(tag, new[0]["group"] == old[0]["group"] and new[0]["active"], "Cancel: the new tab is beside the old one, in front", json.dumps(new[0]))
        rep.check(tag, EDIT.strip() not in on_disk, "Cancel: nothing was written to the old file")
        w2 = await webview_for(a)
        shape = await w2.ev(PAGE_SHAPE_JS)
        rep.check(tag, shape["title"].startswith("●"), "Cancel: the old tab is still unsaved", json.dumps(shape))
        await w2.close()
    else:
        same = [x for x in leaves if x["file"].endswith(b)]
        rep.check(tag, len(leaves) == 1 and len(same) == 1 and same[0]["id"] == before[0]["id"], f"{button}: the same tab now shows {b} and no Code tab shows {a}", str(names))
        w2 = await webview_for(b)
        shape = await w2.ev(PAGE_SHAPE_JS)
        rep.check(tag, shape["editors"] == 1 and all(a not in t for t in shape["tabs"]), f"{button}: the tab's page shows the new file alone (one editor, no second file)", json.dumps(shape))
        await w2.close()
        saved = EDIT.strip() in on_disk
        rep.check(tag, saved == (variant == "save"), f"{button}: the edit {'was saved to' if variant == 'save' else 'was not written to'} {a}")
    await w.close()
    await reset_workspace(p, rep)


async def settled(p: Cdp, variant: str, a: str, b: str):
    leaves = await code_leaves(p)
    want = 2 if variant == "cancel" else 1
    return leaves if len(leaves) == want and any(x["file"].endswith(b) for x in leaves) else None


async def c2_click(p: Cdp, rep: Report):
    tag = "C2 click"
    a, b = "c2-click-a.js", "c2-click-b.js"
    await write_fixture(p, a, BODY)
    await write_fixture(p, b, "export const other = 2;\n")
    await open_code(p, a)
    w, proof = await dirty_tab(a, EDIT)
    rep.check(tag, proof["title"].startswith("●") and proof["shown"], "the Code tab holds genuinely unsaved edits (typed through its own target)", json.dumps(proof))
    before = [x for x in await code_leaves(p) if x["file"].endswith(a)]
    nav = await p.ev("app.workspace.getLeavesOfType(%s)[0].view.navigation" % json.dumps(VIEW_TYPE))
    rep.info(f"the Code view's navigation flag is {nav}: Obsidian's own open does not hand a file to a tab whose view is not a navigation view")
    rep.check(tag, await hand_over(p, "click", a, b), f"a real mouse click on {b} in the file explorer")
    leaves = await wait_for(lambda: settled(p, "cancel", a, b), 90)
    await (await webview_for(b)).close()  # the new tab has loaded, so closing it later is not a question about an unready page
    names = sorted(x["file"].split("/")[-1] for x in await code_leaves(p))
    rep.check(tag, not await p.ev(MODAL_JS), "no prompt is up: the tab was not handed the file, so there is nothing to ask")
    old = [x for x in leaves or [] if x["file"].endswith(a)]
    new = [x for x in leaves or [] if x["file"].endswith(b)]
    rep.check(tag, len(old) == 1 and len(new) == 1 and old[0]["id"] == before[0]["id"], "the old tab still shows only its file and the clicked file is in its own new tab", str(names))
    rep.check(tag, bool(new) and new[0]["group"] == old[0]["group"] and new[0]["active"], "the new tab is beside the old one, in front", json.dumps(new))
    w2 = await webview_for(a)
    rep.check(tag, (await w2.ev("document.title")).startswith("●"), "the old tab still holds its unsaved edit")
    rep.check(tag, EDIT.strip() not in await read_fixture(p, a), "nothing was written to the old file")
    await p.screenshot(f"{rep.out_dir}/c2-click-two-tabs.png")
    await w.close()
    await w2.close()
    await reset_workspace(p, rep)


async def run_c2(p: Cdp, rep: Report):
    await reset_workspace(p, rep)
    await c2_click(p, rep)
    for variant, button in (("discard", "Discard changes"), ("save", "Save"), ("cancel", "Cancel")):
        await reset_workspace(p, rep)
        await restart_server(p, rep)
        await c2_variant(p, rep, variant, button)
