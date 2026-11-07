#!/usr/bin/env python3
"""
Live check of two lines of the PR-4 checklist in a REAL Obsidian (ticket warkworth-42), printing PASS / FAIL per line:

  C2   a Code tab with unsaved edits, handed another file by a real click in Obsidian's file explorer: the unsaved-changes prompt
       appears; Discard changes and Save show the new file alone in that tab; Cancel keeps the old file and opens the new one in a new tab.
  C12  two Code tabs in an Obsidian split: each shows only its editor; a file opened from the editor (Cmd+P quick open) in either lands
       as a new tab in THAT pane's tab group.

It runs INSIDE the desktop container (python3 + `websockets`; no node), from the bind-mounted worktree. Prerequisites: Obsidian runs
there with --remote-debugging-port (9461 for desktop-warkworth-42; set OBSIDIAN_CDP=http://127.0.0.1:<port> otherwise), the vault is
trusted, this plugin is built into the vault (`npm run build`, then main.js, manifest.json and styles.css copied to
<vault>/.obsidian/plugins/vscode-workbench/) and the VS Code server licence is accepted. The run makes fixtures in the vault
folder `live-check/` and removes them again.

  docker exec desktop-warkworth-42 python3 /config/workspace/warkworth-42/tests/render/obsidian-live-check.py [--only c2|c12] [--out-dir DIR]

Exit codes: 0 every line held, 1 a line failed, 2 it could not run (no CDP target, no websockets, a setup step failed).
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from obsidian_live_c2 import run_c2
    from obsidian_live_c12 import run_c12
    from obsidian_live_cdp import page
    from obsidian_live_vault import Report, remove_fixtures, reset_workspace
except ImportError as e:  # websockets missing
    print(f"cannot run: {e}")
    sys.exit(2)


async def main(args) -> int:
    rep = Report(args.out_dir)
    try:
        p = await page()
    except Exception as e:  # noqa: BLE001
        print(f"cannot run: {e}")
        return 2
    try:
        if args.only in ("all", "c2"):
            await run_c2(p, rep)
        if args.only in ("all", "c12"):
            await run_c12(p, rep)
    except Exception:  # noqa: BLE001
        rep.info("the run stopped on an error:\n" + traceback.format_exc())
        rep.failed = max(rep.failed, 1)
        rep.save()
        return 2
    finally:
        try:
            await reset_workspace(p, rep)
            await remove_fixtures(p)
        except Exception:  # noqa: BLE001
            pass
    rep.info("every line held" if not rep.failed else f"{rep.failed} line(s) failed")
    rep.save()
    return 1 if rep.failed else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["all", "c2", "c12"], default="all")
    ap.add_argument("--out-dir", default="/tmp/obsidian-live-check")
    sys.exit(asyncio.run(main(ap.parse_args())))
