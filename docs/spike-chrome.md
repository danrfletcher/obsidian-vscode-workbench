# Chrome spike: can a Code tab show only the editor? (ticket warkworth-42, PR-1)

Result: **the side bar can be hidden on both builds, so the build does not stop.** The stop rule (E10) fires only when neither
VS Code 1.143.1 nor 1.144.0 can hide the side bar by any route. Both can, by the same routes, with the same measured sizes.
The `chrome` header of `docs/spike-decision.md` is now `hidden` (measured: hideable). When this spike was written the product was
unchanged and 0.1.0's "ship visible" rule (`chrome: visible`) still stood; PR-2 built the routes below and retired that rule, the
README "Hidden chrome" text and the old `src/chrome-settings.ts` table together, and PR-6 corrected the remaining docs.

Every size below is the `getBoundingClientRect()` width x height in px of the part's element in the page's computed layout, read by
`npm run check:chrome-spike` (`tests/render/chrome-spike-check.mjs`), not a screenshot. The probe starts a scratch `code serve-web`
with the plugin's own `writeMachineSettings` and `buildBrowserSeedScript`, so each route is applied on top of what the plugin writes
today.

Run it with `CLI_DATA_SRC=<a --cli-data-dir that holds the server for the build> COMMIT_ID=<server commit> VERSION_LABEL=<version> npm run check:chrome-spike -- <outDir>`.
Exit codes as `check:workbench`: 0 passed, 1 a check failed, 2 could not run.

The Obsidian Code tab run (S1 only) is `tests/render/container-chrome-check.py`, run inside the Obsidian desktop container (python3, no
node there). On the Mac build the pack with `node tests/render/chrome-spike-pack.mjs <config>/pack.json /config/vault`; in the container
start Obsidian with `--remote-debugging-port`, accept the VS Code server licence, open one Code tab on a vault file, then run
`python3 tests/render/container-chrome-check.py --pack /config/pack.json --out-dir <dir> --build-label <version>`. It needs the vault's
plugin to find a `code` CLI (`customCliPath`), and it prints no token.

## What was and was not measured

- **Both builds were measured on the host (macOS) with headless Chrome over the DevTools protocol, viewport 1000x700** (about an Obsidian
  pane), and **1.143.1 was measured again inside a Code tab's `<webview>` in the Obsidian desktop container** (Obsidian 1.12.7, Electron
  39.8.3, Linux arm64; VS Code 1.143.1 linux-arm64 as the plugin's `customCliPath`; the plugin's own server; the pane 680x662 px). The
  container run is `tests/render/container-chrome-check.py` with the pack `tests/render/chrome-spike-pack.mjs` writes (same routes, same
  page scripts and the plugin's own seed scripts as the host probe; see "S1 in the Obsidian Code tab" below). 1.144.0 was not run in the
  container. Every S1 route was measured fresh, after a reload and on a
  profile with saved layout state, on both builds on the host and on 1.143.1 in the container. Host and container agree on every
  hidden/visible result in S1; the one thing that varied between container runs is R5b (the saved layout keys written into a fresh
  profile), which hid the side bar in the latest run and did not in the run before it (stated in S1).
- **Builds.** 1.143.1 is server commit `e646868227c3e3a9e3f24277c8c7220be42c0be7`. 1.144.0 is server commit
  `2c33b50b16c472efe58357d1d2a8a5414bc23fbf` (the page title ended "Visual Studio Code - Insiders" in the first full run and reads "... Visual Studio Code" with no suffix in
  the later runs against the same commit, which the pictures and the S1 to S3 and S5 tables come from; the cause was not found, and the
  server's `product.json` names it "Visual Studio Code", quality stable, version 1.144.0). 1.145.0 was not measured.
- **How the servers were obtained.** The 1.144.0 server was downloaded by the `code serve-web` launcher once and saved
  (`CLI_DATA_SAVE`). The launcher's download of 1.143.1 hung, so the 1.143.1 server was unpacked by hand from
  `vscode-server-darwin-arm64-web.zip` (the stable CDN download for that commit) into a `--cli-data-dir` laid out like the launcher's,
  with `code-server` copied to the name `code-server-insiders` that this launcher starts. The zip's checksum was not recorded.
  Every full run below used these saved copies, with no download during the run.
- The probe sends keys with `Input.dispatchKeyEvent` (Cmd, i.e. Meta, on this Mac) and reads state with `Runtime.evaluate` and console
  messages. It uses no `fetch` or WebSocket of its own and no port beyond the server's scratch port and Chrome's own DevTools port.
- **Screenshots.** Every picture cited below was looked at, one run per picture, with the `claude` CLI (it reads PNGs with vision):
  `claude -p "Use the Read tool to view <absolute path>.png and describe what it shows: <a question specific to the picture>" --allowedTools Read --add-dir <folder of the png>`.
  The question was S1: which of the eight parts show; S2: which file is open and where the cursor is; S3: whether anything the chords should
  hide appeared; S4: what each frame of the sheet shows; S5: whether a dirty marker is visible. Each "Looked at:" line under a question
  names the file, what is visible and whether it agrees with the tables; the viewer's replies and the prompts are kept in
  `/Users/danfletcher/.local/share/vector/tickets/warkworth-42/results/evidence/picture-looks/`. The viewer is a model reading a picture, so small text (the S4 sheets are 450 px per frame) is read approximately;
  the tables are still the measurement and the pictures check them. The earlier text recognition and pixel comparisons are kept where they
  add something. Looking changed three statements, each corrected where it occurs: the S5 pictures do not show even a text caret as the
  dirty/saved difference (S5); the 1.144.0 page title carries no "- Insiders" suffix in the latest runs (Builds, below, and S5); the
  "Forbidden." first frame of the S4 sheets is explained (S4).
- The two builds agreed on every size and every result word in S1 to S3 and S5. They differ only in S4 frame timings, in the
  window title suffix of the first full run, and in one F4 host; each is stated where it occurs.

Routes, in the order the spec asks for (R0 is today's plugin settings, the baseline):

| Route | What it is |
|---|---|
| R0 | the settings the plugin writes today (`chromeSettings()`) |
| R1 | Zen Mode: `zenMode.fullScreen` false, `silentNotifications` false, `centerLayout` false, `hideLineNumbers` false, `zenMode.restore` true; `workbench.action.toggleZenMode` run once from the palette; the toggle chord (`cmd+k z`, `ctrl+k z`) and the exit chord (`escape escape`) removed with `-command` entries |
| R2 | `workbench.editor.showTabs: none` |
| R3 | `breadcrumbs.enabled: false` |
| R4 | other settings: `workbench.secondarySideBar.defaultVisibility` hidden, `workbench.layoutControl.enabled` false, `window.menuBarVisibility` hidden, `window.commandCenter` false, `workbench.editor.editorActionsLocation` hidden, `workbench.editor.enablePreview` false, `workbench.statusBar.visible` false, `workbench.activityBar.location` hidden, `workbench.sideBar.location` right, `workbench.panel.defaultLocation` bottom, `workbench.startupEditor` none |
| R5 | saved layout state: the workbench's own IndexedDB layout keys (38 found) after closing the parts with the close commands and reloading the same profile (R5a), and those keys written into a fresh profile (R5b) |
| R6a | page script: `workbench.action.closeSidebar`, `closeAuxiliaryBar` and `closePanel`, each bound to a seeded chord (`ctrl+alt+shift+1`, `2`, `3`) and pressed by the script when the part shows, with a MutationObserver that presses again if the part comes back |
| R6b | page script: a `<style>` with `display: none !important` on every part |

## S1: which route hides each part

"(0px, focusable)" means 0x0 but the element still exists and can take focus.

| Part | Routes tried, in order, with the measured size | Exact setting or script | 1.143.1 | 1.144.0 | Result |
|---|---|---|---|---|---|
| Side bar | R0 246x670; R1 0x0; R2 246x640; R3 246x670; R4 242x670; R5a 0x0; R5b 0x0; R6a 0x0; R6b 0x0 (0px, focusable) | R1 is the first route that hides it (the four `zenMode.*` overrides, `zenMode.restore: true`, `toggleZenMode` once; still hidden after a reload). R2, R3 and R4 do not hide it, alone or together (R2+R3+R4 242x670). Also hidden by R5 (saved layout) and R6a (`workbench.action.closeSidebar` on a seeded chord) | HIDDEN 0x0 | HIDDEN 0x0 | HIDDEN |
| Secondary side bar | R0 0x0 (0px, focusable); R1 0x0; R2 0x0; R3 0x0; R4 0x0; R5 0x0; R6a 0x0; R6b 0x0 (0px, focusable) | `workbench.secondarySideBar.defaultVisibility: "hidden"`, which the plugin already writes. On a fresh profile it is 0x0 under every route, in the Code tab too. On a profile that already holds saved layout state it measures 242x670 (host) / 162x654 (Code tab) under R0, R2, R3, R4 and R2+R3+R4 (the 162 px of the earlier spike); R1, R5, R6a and R6b keep it 0x0 | HIDDEN 0x0 | HIDDEN 0x0 | HIDDEN |
| Activity bar | R0 0x0; every later route 0x0 | `workbench.activityBar.location: "hidden"` (already written today) | HIDDEN 0x0 | HIDDEN 0x0 | HIDDEN |
| Status bar | R0 0x0; every later route 0x0 | `workbench.statusBar.visible: false` (already written today) | HIDDEN 0x0 | HIDDEN 0x0 | HIDDEN |
| Title bar | R0 0x0 (0px, focusable); R1 0x0; R2 1000x30; R3 0x0; R4 0x0; R5 0x0; R6a 0x0; R6b 0x0 (0px, focusable) | `window.commandCenter: false` and `workbench.layoutControl.enabled: false` (already written today). R2 on its own brings the title bar back at 1000x30, so R2 is applied together with R0 and R4 (R2+R3+R4 measured 0x0) | HIDDEN 0x0 | HIDDEN 0x0 | HIDDEN |
| Panel | R0 0x0 (0px, focusable); R1 0x0; R2 0x0; R3 0x0; R4 0x0; R5 0x0; R6a 0x0; R6b 0x0 (0px, focusable) | closed by default on a fresh profile, no setting needed (on a saved-layout profile only R1, R5, R6a and R6b close it, table below); R6a `workbench.action.closePanel` on a seeded chord undoes a reveal (S4) | HIDDEN 0x0 | HIDDEN 0x0 | HIDDEN |
| Tab strip | R0 740x32; R1 990x32; R2 0x0; R3 740x32; R4 744x32; R5 990x32; R6a 990x32; R6b 0x0 (0px, focusable) | `workbench.editor.showTabs: "none"` (R2). Zen Mode does not hide it | HIDDEN 0x0 | HIDDEN 0x0 | HIDDEN |
| Breadcrumb | R0 740x23; R1 990x23; R2 740x23; R3 0x0; R4 744x23; R5 990x23; R6a 990x23; R6b 0x0 (0px, focusable) | `breadcrumbs.enabled: false` (R3) | HIDDEN 0x0 | HIDDEN 0x0 | HIDDEN |

### S1: every route after a reload and on a profile with saved layout state (host, both builds)

Review item T1 (checklist C20): each route is measured three times, on **both builds**: on a fresh profile; after a reload of that
same profile (a route with a page script runs its script again after the reload, as the plugin would on every load; the size before
the script ran again is in `chrome-spike-<build>.json` under `routes.<id>.afterReload.beforeScript`); and on a copy of a profile that
already holds saved layout state. That profile is made by the baseline settings (R0), then "View: Toggle Secondary Side Bar Visibility"
and "View: Toggle Panel Visibility" from the palette (the workbench saves them), and it is measured before any route is applied
(`priorState`: side bar 246x670, secondary side bar 242x670, panel 496x225, tab strip 494x32). The route's settings, keybindings and
page script are then applied on top of that profile's storage. Each cell reads `fresh / after reload / saved layout`. The 1.143.1 and
1.144.0 tables were generated from the two result files and are identical in every cell (checked with `diff`), so one table is shown.
Evidence: `host-s1-s3-s5-<build>/chrome-spike-<build>.json` and `run.log`.

| Part | Every route: fresh profile / after a reload / on a profile with saved layout | Best route |
|---|---|---|
| Side bar | R0 246x670 / 246x670 / 246x670; R1 0x0 / 0x0 / 0x0; R2 246x640 / 246x640 / 246x640; R3 246x670 / 246x670 / 246x670; R4 242x670 / 242x670 / 242x670; R2+R3+R4 242x670 / 242x670 / 242x670; R5 0x0 / 0x0 / 0x0; R5b 0x0 / 0x0 / 0x0; R6a 0x0 / 0x0 / 0x0; R6b 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); best 0x0 / 0x0 / 0x0 | HIDDEN |
| Secondary side bar | R0 0x0 (0px, focusable) / 0x0 (0px, focusable) / 242x670; R1 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R2 0x0 (0px, focusable) / 0x0 (0px, focusable) / 242x640; R3 0x0 (0px, focusable) / 0x0 (0px, focusable) / 242x670; R4 0x0 (0px, focusable) / 0x0 (0px, focusable) / 246x670; R2+R3+R4 0x0 (0px, focusable) / 0x0 (0px, focusable) / 246x670; R5 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R5b 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R6a 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R6b 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); best 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable) | HIDDEN |
| Activity bar | R0 0x0 / 0x0 / 0x0; R1 0x0 / 0x0 / 0x0; R2 0x0 / 0x0 / 0x0; R3 0x0 / 0x0 / 0x0; R4 0x0 / 0x0 / 0x0; R2+R3+R4 0x0 / 0x0 / 0x0; R5 0x0 / 0x0 / 0x0; R5b 0x0 / 0x0 / 0x0; R6a 0x0 / 0x0 / 0x0; R6b 0x0 / 0x0 / 0x0; best 0x0 / 0x0 / 0x0 | HIDDEN |
| Status bar | R0 0x0 / 0x0 / 0x0; R1 0x0 / 0x0 / 0x0; R2 0x0 / 0x0 / 0x0; R3 0x0 / 0x0 / 0x0; R4 0x0 / 0x0 / 0x0; R2+R3+R4 0x0 / 0x0 / 0x0; R5 0x0 / 0x0 / 0x0; R5b 0x0 / 0x0 / 0x0; R6a 0x0 / 0x0 / 0x0; R6b 0x0 / 0x0 / 0x0; best 0x0 / 0x0 / 0x0 | HIDDEN |
| Title bar | R0 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R1 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R2 1000x30 / 1000x30 / 1000x30; R3 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R4 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R2+R3+R4 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R5 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R5b 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R6a 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R6b 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); best 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable) | HIDDEN |
| Panel | R0 0x0 (0px, focusable) / 0x0 (0px, focusable) / 496x225; R1 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R2 0x0 (0px, focusable) / 0x0 (0px, focusable) / 496x225; R3 0x0 (0px, focusable) / 0x0 (0px, focusable) / 496x225; R4 0x0 (0px, focusable) / 0x0 (0px, focusable) / 496x225; R2+R3+R4 0x0 (0px, focusable) / 0x0 (0px, focusable) / 496x225; R5 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R5b 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R6a 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R6b 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); best 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable) | HIDDEN |
| Tab strip | R0 740x32 / 740x32 / 494x32; R1 990x32 / 990x32 / 990x32; R2 0x0 / 0x0 / 0x0; R3 740x32 / 740x32 / 494x32; R4 744x32 / 744x32 / 494x32; R2+R3+R4 0x0 / 0x0 / 0x0; R5 990x32 / 990x32 / 990x32; R5b 990x32 / 990x32 / 990x32; R6a 990x32 / 990x32 / 990x32; R6b 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); best 0x0 / 0x0 / 0x0 | HIDDEN |
| Breadcrumb | R0 740x23 / 740x23 / 494x23; R1 990x23 / 990x23 / 990x23; R2 740x23 / 740x23 / 494x23; R3 0x0 / 0x0 / 0x0; R4 744x23 / 744x23 / 494x23; R2+R3+R4 0x0 / 0x0 / 0x0; R5 990x23 / 990x23 / 990x23; R5b 990x23 / 990x23 / 990x23; R6a 990x23 / 990x23 / 990x23; R6b 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); best 0x0 / 0x0 / 0x0 | HIDDEN |

What this table adds:

- **Reload changes nothing, on any route and any part.** Every "after reload" cell equals its "fresh" cell on both builds.
- **A profile that already holds saved layout state breaks the settings-only routes.** On it R0, R2, R3, R4 and R2+R3+R4 leave the
  **secondary side bar visible (242x670 to 246x670, 242x640 under R2) and the panel visible (496x225)**. `workbench.secondarySideBar.defaultVisibility: "hidden"`
  is a default for a profile with no saved layout, and the panel has no setting at all. This is the 0.1.0 finding (the secondary side
  bar hidden only on a fresh profile), reproduced. The side bar, activity bar, status bar, title bar, tab strip and breadcrumb held on
  that profile under the routes that hide them.
- **The routes that hold on every state:** R1 (Zen Mode), R5 and R5b (saved layout state), R6a (close commands on seeded chords with the
  watcher) and R6b (CSS) hid the side bar, secondary side bar and panel on a fresh profile, after a reload and on the saved-layout profile.
  R1 and R5 leave the tab strip and breadcrumb (R1 990x32 / 990x23 on the host) to R2 and R3, and R6b leaves every part focusable at 0 px.
- **The best combination hid all eight parts in all three states on both builds** (R2+R3+R4 settings, R6a page script with its watcher,
  and the saved layout keys, R5b, as on the host).

### S1 in the Obsidian Code tab (1.143.1, container)

Measured by `tests/render/container-chrome-check.py` inside the Obsidian container, in the `<webview>` of a real Code tab (partition
`persist:vscode-workbench`, 680x662 px, so the viewport is 680x662, not the host's 1000x700). Each route runs on a profile
wiped of IndexedDB, local storage and caches (the token cookie is kept). R0 is a Code tab the plugin opened afresh on `a.js`, so the
settings are the ones the plugin writes today. **Every route is measured three times** (review item T1, checklist C20), each cell below reading
`fresh / after a reload / on a profile with saved layout`: on a wiped profile; after `webview.reload()` of that profile; and on a profile that
already holds saved layout state. That profile is R0, then "View: Toggle Secondary Side Bar Visibility" and "View: Toggle Panel Visibility" from
the palette (measured before any route: side bar 166x654, secondary side bar 162x654, panel 336x213, tab strip 334x32), with the route applied on top
of its storage. Every other route is seeded with the plugin's own `buildBrowserSeedScript` (the route's
settings and keybindings) and the Workspace Trust record the plugin writes, and then the tab's address is loaded again. "After reload" is
`webview.reload()`. Every size is `getBoundingClientRect()`, as above. Evidence: `container-chrome-check.txt`, `.json` and `run.log` in
`results/evidence/container-chrome-1.143.1/` (this run is the one measured on 2026-11-02 after the tester's round 1; the run before it is kept in `container-chrome-1.143.1-run3/`).

| Part | Every route: fresh profile / after a reload / on a profile with saved layout | Best route |
|---|---|---|
| Side bar | R0 166x654 / 166x654 / 166x654; R1 0x0 / 0x0 / 0x0; R2 166x628 / 166x628 / 166x628; R3 166x654 / 166x654 / 166x654; R4 162x654 / 162x654 / 162x654; R2+R3+R4 162x654 / 162x654 / 162x654; R5 0x0 / 0x0 / 0x0; R5b 0x0 / 0x0 / 0x0; R6a 0x0 / 0x0 / 0x0; R6b 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); best 0x0 / 0x0 / 0x0 | HIDDEN |
| Secondary side bar | R0 0x0 (0px, focusable) / 0x0 (0px, focusable) / 162x654; R1 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R2 0x0 (0px, focusable) / 0x0 (0px, focusable) / 162x628; R3 0x0 (0px, focusable) / 0x0 (0px, focusable) / 162x654; R4 0x0 (0px, focusable) / 0x0 (0px, focusable) / 166x654; R2+R3+R4 0x0 (0px, focusable) / 0x0 (0px, focusable) / 166x654; R5 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R5b 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R6a 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R6b 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); best 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable) | HIDDEN |
| Activity bar | R0 0x0 / 0x0 / 0x0; R1 0x0 / 0x0 / 0x0; R2 0x0 / 0x0 / 0x0; R3 0x0 / 0x0 / 0x0; R4 0x0 / 0x0 / 0x0; R2+R3+R4 0x0 / 0x0 / 0x0; R5 0x0 / 0x0 / 0x0; R5b 0x0 / 0x0 / 0x0; R6a 0x0 / 0x0 / 0x0; R6b 0x0 / 0x0 / 0x0; best 0x0 / 0x0 / 0x0 | HIDDEN |
| Status bar | R0 0x0 / 0x0 / 0x0; R1 0x0 / 0x0 / 0x0; R2 0x0 / 0x0 / 0x0; R3 0x0 / 0x0 / 0x0; R4 0x0 / 0x0 / 0x0; R2+R3+R4 0x0 / 0x0 / 0x0; R5 0x0 / 0x0 / 0x0; R5b 0x0 / 0x0 / 0x0; R6a 0x0 / 0x0 / 0x0; R6b 0x0 / 0x0 / 0x0; best 0x0 / 0x0 / 0x0 | HIDDEN |
| Title bar | R0 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R1 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R2 680x30 / 680x30 / 680x30; R3 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R4 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R2+R3+R4 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R5 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R5b 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R6a 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R6b 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); best 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable) | HIDDEN |
| Panel | R0 0x0 (0px, focusable) / 0x0 (0px, focusable) / 336x212; R1 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R2 0x0 (0px, focusable) / 0x0 (0px, focusable) / 336x212; R3 0x0 (0px, focusable) / 0x0 (0px, focusable) / 336x212; R4 0x0 (0px, focusable) / 0x0 (0px, focusable) / 336x212; R2+R3+R4 0x0 (0px, focusable) / 0x0 (0px, focusable) / 336x212; R5 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R5b 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R6a 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); R6b 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); best 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable) | HIDDEN |
| Tab strip | R0 500x32 / 500x32 / 334x32; R1 670x32 / 670x32 / 670x32; R2 0x0 / 0x0 / 0x0; R3 500x32 / 500x32 / 334x32; R4 504x32 / 504x32 / 334x32; R2+R3+R4 0x0 / 0x0 / 0x0; R5 670x32 / 670x32 / 670x32; R5b 670x32 / 670x32 / 670x32; R6a 670x32 / 670x32 / 670x32; R6b 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); best 0x0 / 0x0 / 0x0 | HIDDEN |
| Breadcrumb | R0 500x22 / 500x22 / 334x22; R1 670x22 / 670x22 / 670x22; R2 500x22 / 500x22 / 334x22; R3 0x0 / 0x0 / 0x0; R4 504x22 / 504x22 / 334x22; R2+R3+R4 0x0 / 0x0 / 0x0; R5 670x22 / 670x22 / 670x22; R5b 670x22 / 670x22 / 670x22; R6a 670x22 / 670x22 / 670x22; R6b 0x0 (0px, focusable) / 0x0 (0px, focusable) / 0x0 (0px, focusable); best 0x0 / 0x0 / 0x0 | HIDDEN |

What the container run adds to the host table:

- **R0 in the Code tab shows the side bar at 166x654, the tab strip at 500x32 and the breadcrumb at 500x22.** The activity bar, status bar, title bar, secondary side bar and panel are already 0x0 (the last three still focusable). Same parts as on the host, narrower because the pane is.
- **Reload changes nothing here either:** every "after reload" cell equals its "fresh" cell, for every route and every part.
- **On a profile that already holds saved layout state the settings-only routes lose the secondary side bar and the panel**, as on the host: R0, R2, R3, R4 and R2+R3+R4 measure the secondary side bar at 162x654 (162x628 under R2, 166x654 under R4 and R2+R3+R4) and the panel at 336x212. The earlier container run said the secondary side bar was 0x0 under every route; that was only true of the fresh profile. A Code tab that has had its secondary side bar or panel opened once would keep showing it under R0 to R4.
- **R1, R5, R5b, R6a, R6b and the best route hid the side bar, secondary side bar and panel in all three states.** R5b (the layout keys written into a fresh profile) hid the side bar here (0x0) in this run, and did not (166x654) in the earlier container run on the same build (`container-chrome-1.143.1-run3/`), so it is not stable enough to build on; PR-2 should not depend on it. The best route (R2+R3+R4 with the R6a page script and its watcher, and the R5b keys) hid all eight parts on first load, after a reload and on a profile with saved layout state; R6a alone (without R5b) hid the side bar, secondary side bar and panel in all three states, and R2 and R3 are still needed for the tab strip and breadcrumb.
- R1 (Zen) hid the side bar and held after a reload and on the saved-layout profile. As on the host it leaves the tab strip (670x32) and breadcrumb (670x22) to R2 and R3.
- R2 on its own brings the title bar back (680x30), as on the host.
- Screenshots `PR-1-S1-container-r0.png` (R0) and `PR-1-S1-container-best.png` (best route) are in the same folder; the tables above are what was read from the page.
- Looked at: `PR-1-S1-container-r0.png` (680x662, dark theme, the Code tab's page only): a side bar on the left, about 165 to 170 px wide, with Explorer (folder `vault`: `.obsidian`, `a.js`, `Notes.md`) and `Outline` and `Timeline` collapsed below; one tab `a.js` in a tab strip; breadcrumbs `a.js > helper`; the editor with `function helper() {` and four more lines. No activity bar, secondary side bar, panel, status bar or title bar, no banner. Agrees with the R0 cells (side bar 166x654, tab strip and breadcrumb visible, the other five parts 0x0). `PR-1-S1-container-best.png`: the editor alone with the same five lines; none of the eight parts, no banner; the viewer found no Obsidian interface in it (the picture is the webview's page, with a thin lighter border at its edges). Agrees with the best route measuring 0x0 for every part.

Questions the S1 acceptance asks beyond the table:

| Question | Answer | Result |
|---|---|---|
| Does Zen Mode with the four overrides and both chord disables bring back anything Dan does not want? | No. Measured: line numbers shown, no centred layout, no toast text, the workbench classes are `mac web nopanel noauxiliarybar noactivitybar nostatusbar nosidebar` (no full-screen class), editor 992x670. It does not hide the tab strip (990x32) or the breadcrumb (990x23), so R2 and R3 are still needed. The two chord disables have to stay, or the user leaves Zen and the side bar returns | NO |
| Is a part at 0 px still focusable? | Yes: the secondary side bar, title bar and panel measure 0x0 but are focusable under every route that hides them (R0 to R6a, in all three states; sizes in the tables); under R6b (CSS) the side bar, tab strip and breadcrumb are 0x0 and focusable too. Under the best combination the side bar, tab strip and breadcrumb are plain 0x0, and the secondary side bar, title bar and panel are 0x0 and focusable | PARTIAL |
| Does a route hold only until reload, or only on a fresh profile? | **Yes for the settings-only routes, no for the others.** No route stops holding after a reload (every route, every part, both builds, host and container). But R0, R2, R3, R4 and R2+R3+R4 hide the secondary side bar and the panel only on a fresh profile: on a profile that already holds saved layout state both come back (host 242x670 and 496x225; container 162x654 and 336x212). R1, R5/R5b, R6a, R6b and the best combination held in all three states, and the best combination hid all eight parts in all three on both builds (editor 992x670 on first load on the host) | YES |
| Does any part stay visible on either build? | Not under the best combination: every part measured 0x0 in all three states on both builds. Under the settings-only routes the secondary side bar and the panel come back on a saved-layout profile (above) | NO |

Best combination for PR-2 to build: R4 settings (they already cover the three parts the plugin hides today), R2 `showTabs: none`, R3
`breadcrumbs.enabled: false`, and the R6a page script with its observer. On the host the saved layout state written into a fresh profile
(R5b) was part of it. R5b hid the side bar in the Code tab in the latest run and left it at 166x654 in the run before, so
PR-2 should not depend on R5b. Because the settings-only routes lose the secondary side bar and the panel on a profile that holds saved
layout state, PR-2 must include the R6a page script (or R1), not settings alone. R6b
(CSS) also measured 0x0 but leaves the parts in the layout and focusable, so it is the last resort. Zen Mode (R1) hides the side bar too but
needs a command run once and leaves the tab strip and breadcrumb to R2 and R3 anyway.

Screenshots: PR-1-S1-1.143.1.png, PR-1-S1-1.144.0.png (the best route applied, in a trusted workspace, each part measured 0x0 in the tables above). Text recognition read only editor text (`import { helper } from "./b.js";`, `const x = helper(1);`, `console.log(x);`) on both builds: no Explorer, Outline, Timeline, tab, breadcrumb or status text.

Looked at: `PR-1-S1-1.143.1.png` and `PR-1-S1-1.144.0.png` (1000x700, light theme). Both show the editor alone: five lines (`import { helper } from "./b.js";`, blank, `const x = helper(1);`, `console.log(x);`, blank), the cursor on line 1 with `import` highlighted, a lightbulb in the gutter of line 2, the minimap and the vertical scrollbar. No activity bar, side bar (no Explorer, Outline or Timeline text), secondary side bar, panel, status bar, tab strip, breadcrumbs or title bar, and no banner. This agrees with the tables, where all eight parts measure 0x0 under the best route on both builds. The minimap, scrollbar and lightbulb are the editor's own and are not among the eight parts. The viewer saw a faint line 1 to 2 px high along the very top edge and could not say what it is; the title bar measures 0x0 (focusable), so nothing else in the tables explains it. The two pictures differ only by the caret and a few edge pixels.

## S2: opening a file from inside the editor

S2 verdict: INTERCEPT, for Cmd+P quick open and for Go to Definition, by a page script that watches the editor's `data-uri` and the cursor
line and reports through `console.log`; no VS Code internals are patched. Go to Definition was exercised on both builds in a trusted
workspace (the vault folder's Workspace Trust record written, as a Code tab with `trustVaultFolder` on does): F12 on `helper` in `a.js`
opened `b.js` at line 5 on the first press (1.5 s), and the page script's final event carried `b.js` and line 5. It was run in host headless
Chrome on the host; S2 was not run in the container, which was only asked for S1. In an untrusted workspace the same key did not leave `a.js` in
10 presses over 61 s, so a Code tab that does not trust the folder gets no Go to Definition to catch.

| Question | Result on 1.143.1 and 1.144.0 | Result |
|---|---|---|
| Can Cmd+P quick open be caught? | Quick open from `a.js` to `c.txt` changed the open editor's URI; the page script reported both URIs through `console.log` (2 events). Mechanism: page script, console message only | YES |
| Can Go to Definition be caught? | Yes, in a trusted workspace. F12 with the cursor on `helper` (`a.js` line 3, column 11), JS/TS language service, no extra extension: the open editor changed from `a.js` to `b.js`, the cursor went to line 5, and the page script's last event was `{uri: .../b.js, line: 5}`. In the latest run both builds reported four events: `a.js` line 1, `a.js` line 3, one transient event with no URI and no line (`{uri: null, line: null}`, while the editor was swapped), then `b.js` line 5. The tester's run on 1.144.0 reported three (no transient event), so the transient event is timing, not something to rely on; the events that are stable on both builds are the `a.js` events and the final `b.js` line 5. The first press worked (1 press, 1.5 s) on both builds. In an untrusted workspace: 10 presses over 61.3 s, still `a.js`, no change to report. Mechanism: the same page script as quick open; the line comes from the editor's cursor once the URI changes, not from the URI. The Python extension (Pylance) was not tried: the JS/TS provider answered, which is a definition provider going through the same editor service | YES |
| Does catching it need patching VS Code internals? | No for the route above. It reads the DOM and presses a seeded command chord. A hook that stops the open before it happens would need internals and was not tried | NO |
| What does VS Code do with `showTabs: none` when another file opens? | It shows the new file and keeps the earlier editor open behind it in the same group: after quick open the group held `a.js`, `c.txt`; after more opens `a.js`, `link.md`, `b.js`. Identical with `enablePreview` false and true | YES |
| How is a restored previous editor closed on load? | A profile that held `a.js` and `c.txt` and reloaded with `b.js` in the payload showed only `b.js` on both builds, even before any command; the seeded `workbench.action.closeOtherEditors` chord (`ctrl+alt+shift+4`) leaves exactly the active one when two are open (`c.txt`) | YES |
| Does the first tab keep its file and cursor when the new editor is put away? | After quick open of `c.txt` from `a.js` with the cursor on line 3, the seeded `workbench.action.closeActiveEditor` chord (`ctrl+alt+shift+5`) brought `a.js` back at line 3 and left only `a.js` in the group. Between the open and the close the first tab shows the new file; the duration was not measured | YES |
| Does a line number travel in the `openFile` payload? | No. The suffixes `#5`, `#L5` and `:5` each opened `b.js` with the cursor on line 1 (`:5` became the path `b.js%3A5`). The line has to be read from the editor when the change is caught (the Open Link case reported line 5) and placed by the receiving tab | NO |
| Can an already-open editor be moved to a line? | A synthetic Ctrl+G, the line number and Enter sent to the page moved an open editor from line 1 to line 7 | YES |

What this means for PR-4: catch the change, read the new URI and line, and ask the plugin for a Code tab for that file at that line
(`this.openCodeFile` in `src/main.ts`; `OpenFiles.openOnce` in `src/open-file.ts` focuses an existing tab, after which the Ctrl+G sequence
above sets the line), then press the `closeActiveEditor` chord so the first tab shows its own file at its own cursor again. That
wiring was not built or run here.

Screenshots: PR-1-S2-1.143.1.png, PR-1-S2-1.144.0.png (a second file opened from the editor: `b.js`, taken right after Open Link put the cursor on line 5; the earlier pictures were taken after "previous editor" and showed `link.md`).

Looked at: `PR-1-S2-1.143.1.png` and `PR-1-S2-1.144.0.png` (1000x700). Both show the editor alone with `b.js`: the name appears only in the file's own first line `// b.js`; no tab, breadcrumb or title shows it. Lines 5 to 7 read `export function helper(n) {`, `return n + 1;`, `}`; the cursor is at the start of line 5 with `export` highlighted and a lightbulb in the gutter above it. No other part is on screen. This agrees with the tables: a second file open, the cursor on line 5, no tab strip.

Why the two files are byte-identical (md5 3259d661aaef69fcfe7eba6c625edfa8), checked by looking at both and at the runs that wrote them: they are not one picture copied. The 1.143.1 file was written by the run against server commit e646868227 (port 49162, vault `chrome-spike-TTfXYt`) and the 1.144.0 file by the run against 2c33b50b16 (port 49160, vault `chrome-spike-T3rruG`); the JSON of each (`host-s2-<build>-r4/`) records `version` and `commit` of its own build and, at the moment of the capture, the open editor `b.js` at line 5 with the page title `b.js — vault — Visual Studio Code`. The picture is the page only (`Page.captureScreenshot`) and shows nothing that differs between the builds (no title bar, status bar or version text, the same file, the same caret), so the same pixels are expected, not a sign of a stale or wrong target. The S1 pictures, which carry a blinking caret, differ between the builds. The one thing that does tell the builds apart in a page, its title, did not differ in these runs either (see Builds).

## S3: chords

Each chord was pressed in the page, first with no removal entries (control) and then with the `-command` entries in the seeded
keybindings, and the part states (side bar, panel, Zen, editor, status bar) were read before and after.

| Question | Result on 1.143.1 and 1.144.0 | Result |
|---|---|---|
| Does a `-command` entry disable Cmd/Ctrl+B (`workbench.action.toggleSidebarVisibility`)? | Control: the side bar closed. With the entries: nothing changed | YES |
| Does a `-command` entry disable Cmd/Ctrl+J (`workbench.action.togglePanel`)? | Control: the panel opened. With the entries: nothing changed | YES |
| Does a `-command` entry disable Cmd+K Z (`workbench.action.toggleZenMode`)? | Control: the side bar and status bar went. With the entries: nothing changed | YES |
| Does a `-command` entry disable Cmd/Ctrl+W (`workbench.action.closeActiveEditor`)? | Control: the editor closed. With the entries: nothing changed. What Cmd+W does to the Obsidian tab itself was not measured | YES |
| Do the two bridged chords still reach Obsidian's side? | With every removal entry in place the page script of `src/hotkey/hotkey-bridge.ts` reported `toggle-terminal` and `open-switcher` | YES |
| Do the disabled chords survive `buildBrowserSeedScript`? | The entries are kept on a tab reload (same copy id) and are gone after a new copy id, because the copy replaces `/User/keybindings.json` whole. `tests/unit/settings.test.ts` pins that with an in-memory fake IndexedDB | NO |
| Does a user's own rule for the same chord beat the removal? | Yes: a copied keybinding that binds Cmd+B closed the side bar whether the removal entries came after it or before it | YES |

S3 re-apply route: append the removal entries and the seeded close chords to the keybindings text that goes into the copy
(`keybindingsBase64` for `buildBrowserSeedScript`) on every server start, so every new copy id carries them, and keep the R6a observer
running, because a user's own binding beats a removal and the observer is what undoes a side bar or panel that rule reveals.

Pressing the chords on a real Mac keyboard in an Obsidian Code tab is the human step in the spec. The probe's chords on this Mac were
Cmd (Meta) presses sent through the DevTools protocol.

Screenshots: PR-1-S3-1.143.1.png, PR-1-S3-1.144.0.png (the best route, then Cmd+B, Cmd+J, Cmd+K Z and Cmd+W pressed in turn, then the page: nothing appeared, all eight parts still 0x0 on both builds, `hidden after: 8/8` in the run log, and the editor still open). Text recognition read only the three editor lines, no Explorer, Outline or Timeline text.

Looked at: `PR-1-S3-1.143.1.png` and `PR-1-S3-1.144.0.png` (1000x700, byte-identical to each other: the same page state on two builds). Both show the editor alone with the same five lines as S1, the cursor on line 1, a lightbulb, the minimap and the scrollbar. No Explorer, side bar, panel, zen-mode banner, notification, tab strip or other part. The editor is still open after Cmd+W. This agrees with the tables (`hidden after: 8/8`, the editor still open). The picture is the page's own viewport, so a part that had come back would be inside it.

## S4: flash and palette undo

S4 cheapest fix: write the saved layout state (R5b) into the profile before the first load; with it no unwanted part was seen in any frame.

Frames come from a screencast of the page load, each timestamped; an "unwanted part" is any of the side bar, tab strip or breadcrumb
showing.

| Question | 1.143.1 | 1.144.0 | Result |
|---|---|---|---|
| Is the full workbench visible before hiding applies (today's settings, no hiding beyond them)? | 137 frames; workbench at 592 ms, editor at 976 ms; the side bar, tab strip and breadcrumb first seen at 592 ms and never hidden again | 151 frames; workbench at 596 ms, editor at 924 ms; same parts first seen at 596 ms, never hidden again | SEEN |
| Is it visible with the best route (layout state seeded)? | 154 frames; workbench at 555 ms, editor at 818 ms; no flash seen | 149 frames; workbench at 584 ms, editor at 849 ms; no flash seen | NOT SEEN |
| Is it visible with the best route but no saved layout state? | 157 frames; the side bar first seen at 573 ms and gone 2016 ms later (closed by the R6a script) | 143 frames; the side bar first seen at 605 ms and gone 1966 ms later | SEEN |
| Is a palette reveal command (toggle side bar, panel, secondary side bar) undone with no script? | shown at 100, 400 and 1500 ms for all three | same | NOT UNDONE |
| Is it undone with the R6a observer running? | not shown at 100, 400 or 1500 ms for all three | same | UNDONE |

The probe opens the panel from the palette, and VS Code then asks "Do you trust the authors of the files in this folder? Creating a terminal process requires executing code". The server keeps that terminal across loads. The probe cancels that dialog on load and records it under `notes` in its JSON, so it does not take focus from the editor. The dialog is a VS Code popup and the best route does not hide it.

Screenshots: PR-1-S4-1.143.1.png, PR-1-S4-1.144.0.png (a contact sheet of 12 screencast frames of the best route's load; PR-1-S4-1.143.1-settled.png and PR-1-S4-1.144.0-settled.png are the page after it settled). The settled pictures are of an untrusted scratch workspace, so they carry the "Restricted Mode" banner (text recognition read it), which a Code tab with `trustVaultFolder` on does not show. S4 was not re-run in this round.

Looked at: `PR-1-S4-1.143.1.png` (12 of 40 frames) and `PR-1-S4-1.144.0.png` (12 of 42 frames). 1.143.1: frame 1 (+0 ms) is a black page with the text "Forbidden."; frame 2 (+625 ms) is the workbench with the VS Code watermark ("Open Chat", "Show All Commands", "Open Settings") and the Explorer side bar on the right (`vault`, `Outline`, `Timeline`); frame 3 (+809 ms) the same with an empty editor; frame 4 (+975 ms) the file list (`a.js`, `b.js`, `c.txt`, `link.md`) and the code; frame 5 (+1225 ms) the editor alone; frames 6 to 12 (+1759 to +3742 ms) the editor with the Restricted Mode banner. 1.144.0: the same order, with the side bar in frames 2 and 3 (+670 and +853 ms), the editor alone from frame 4 (+1086 ms) and the banner from frame 6 (+1903 ms). In neither sheet is an activity bar, status bar, title bar, tab strip or breadcrumb visible in any frame. This agrees with the report that this load is the "best route but no saved layout state" case (SEEN): the side bar shows early, the R6a script then removes it. It is not the seeded case (NOT SEEN), whose picture is the settled one. The times on the sheet (side bar gone by +1225 ms on 1.143.1 and +1086 ms on 1.144.0) are not the times in the table row (last seen at 2507 and 2496 ms): they are different loads with different zero points, and the JSON keeps only the sheet load's frame count (40 and 42), so the two are not compared further.

The "Forbidden." frame 1 is not part of the best route's load. The screencast block of `tests/render/chrome-spike-check.mjs` first opens `/` without the connection token, which the server answers with "Forbidden.", and starts the screencast on that page before it navigates to the tokened URL; frame 1 is that page. This is read from the code and from the picture, not measured separately.

Looked at: `PR-1-S4-1.143.1-settled.png` and `PR-1-S4-1.144.0-settled.png` (1000x700, byte-identical to each other): the editor with the Restricted Mode banner ("Restricted Mode is intended for safe code browsing. Trust this folder to enable all features.", "Manage", "Learn More", a close button), the five lines of `a.js`, the minimap and the scrollbar; no side bar, tab strip, breadcrumb, status bar or other part. This agrees with the note above: an untrusted scratch workspace and the best route's end state.

The contact sheet is not the "NOT SEEN" case. Its load (`tests/render/chrome-spike-check.mjs`, the "Screencast of one load" block) seeds the best route's settings and keybindings in the browser but writes no saved layout state, so it matches the "best route but no saved layout state" row, which is SEEN. Text recognition over the sheets agrees: it reads `vault`, `Outline` and `Timeline` in the early frames (frames 3 and 4 on 1.143.1; frames 2 and 3 on 1.144.0), the palette entries "Show All Commands" and "Open Settings" in frame 2 on 1.143.1, and the Restricted Mode banner in the later frames. The sheet is small (450 px per frame), so that reading is noisy and is only a hint of what is there; the frame table in the JSON is the evidence. The picture of the seeded case is the settled one, in which none of those texts appear. Anyone looking at the sheet should expect the side bar in its early frames.

## S5: the unsaved-edit signal

S5 chosen signal for PR-5: the window title's leading "●" in `document.title`, one editor per tab. Measured by typing one character in
`a.js` and saving with Cmd+S, with the tab strip hidden three ways. Identical on both builds (in the latest runs both titles end "Visual Studio
Code"; in the first full run the 1.144.0 title ended "Visual Studio Code - Insiders").

| Question | Clean / typed / saved | Result |
|---|---|---|
| Window title "●" with `showTabs: none` (= `DIRTY_SCRIPT`) | false / true / false | CHOSEN |
| `.tab.dirty` with `showTabs: none` (what `fileDirtyScript` reads) | 0 / 0 / 0; `fileDirtyScript` answers `none` in all three states | FALSE |
| `.title` element with class `dirty` with `showTabs: single`, strip hidden by CSS | class absent / present / absent (`.tab.dirty` stays 0 / 0 / 0 there) | TRUE |
| `.tab.dirty` with today's strip (control) | 0 / 1 / 0; `fileDirtyScript` clean / dirty / clean | TRUE |
| "Show All Editors" quick pick row label | `a.js, unsaved changes` while `a.js` is dirty but not active | PARTIAL |

- The title mark is true after typing and false after saving, which is the dirty-to-clean change the rename-carry check in
  `src/code-view.ts` waits for. It is what `DIRTY_SCRIPT` in `src/dirty-script.ts` already reads, so the page-wide case needs no new script.
  `tests/unit/dirty-guard.test.ts` pins today's answers with no `.tab` element.
- The title names the active editor only. With `a.js` dirty and `c.txt` active the title read "c.txt — vault — Visual Studio Code" with no
  mark, `DIRTY_SCRIPT` false and `fileDirtyScript("a.js")` `none`, while the quick pick still listed `a.js, unsaved changes`. That is
  safe once PR-4 gives each tab one file; until then a dirty buffer behind the active one reads clean.
- **If the title "●" is the only signal left:** it is lost whenever `window.title` is set without the dirty marker, and then every state reads clean
  (the jsdom case in `tests/unit/dirty-guard.test.ts` shows this). A user's own `window.title` was not measured in the browser; PR-5 should write
  `window.title` itself in the Machine settings and re-measure. The `.title.dirty` class needs `showTabs: single`, which conflicts with R2, so
  it is the second choice only if PR-5 gives up R2.

Screenshots: PR-1-S5-1.143.1.png and PR-1-S5-1.144.0.png (the `showTabs: none` session with the file dirty) and PR-1-S5-1.143.1-saved.png and PR-1-S5-1.144.0-saved.png (after saving). These sessions are not the best route, so the Explorer side bar (on the right, `workbench.sideBar.location: right`), Outline and Timeline are visible in them; the pictures show the file, not hidden chrome.

Looked at: `PR-1-S5-1.143.1.png`, `PR-1-S5-1.143.1-saved.png`, `PR-1-S5-1.144.0.png` and `PR-1-S5-1.144.0-saved.png` (1000x700) show the same session. The editor is on the left with line 1 reading `importX { helper } from "./b.js";` (the one typed character, an X, after `import`), red squiggles under it, a suggestion popup open below it (`ImageBitmapRendering...`, `interface ImageBitmapRenderingCont...`), a lightbulb or sparkle in the gutter of line 2, a minimap with red marks and a red mark at the top of the scrollbar. On the right is the Explorer side bar with the folder `vault` holding `a.js` (red, selected, with a red "2"), `b.js`, `c.txt`, `link.md`, and `Outline` and `Timeline` collapsed below. There is no tab strip, breadcrumb, title bar, activity bar, status bar, panel or banner. No dirty marker is visible in any of the four: no dot, no title bullet; the red "2" next to `a.js` is a problems count (the squiggled `importX`), not an unsaved mark. The dirty and saved pictures read the same to the viewer (same text with the X, same popup), so the pictures do not show a dirty-versus-saved difference. The earlier pixel comparison of each dirty picture with its saved picture (same build) found 36 differing pixels, all inside a 2 x 18 px strip at x 121-122, y 5-22 on the first editor line; the viewer could not point to anything there, and the first version of this report guessed a text caret from the size, which was not seen. The pictures therefore agree with the table where it says there is no `.tab.dirty` element and no tab signal in this session (the S5 table's `.tab.dirty` row: 0 / 0 / 0), and the dirty/saved difference rests on the table (the window title "●", the page script's events and the file on disk), not on the pictures.

## Fence and stop-rule checks

| Check | Result | Result word |
|---|---|---|
| F1 no editor of our own | `package.json` gains only the `check:chrome-spike` script; no dependency was added and no source file under `src/` changed | YES |
| F1 nothing written to desktop VS Code | Checksums of the Code and Code - Insiders `User/settings.json`, their `User/keybindings.json` (absent before and after) and the two `extensions/extensions.json` files were identical before and after each full run. The probe uses scratch server-data and cli-data directories | YES |
| F4 loopback only | `lsof -i` on the server tree showed only loopback listeners on both builds. Chrome's hosts: `127.0.0.1` and `main.vscode-cdn.net` on 1.144.0; the same plus `marketplace.visualstudio.com` (the one marketplace query) on 1.143.1. No host outside the known set in `docs/spike-decision.md` | YES |
| F4 no new channel | The probe reports through console messages and `Runtime.evaluate`; `src/terminal/` and the server start path are untouched | YES |
| Cleanup | Both runs stopped everything they started by PID; no process or listener was left | YES |
| E10 do the builds disagree? | Not on any size or result word in S1 to S3 or S5; only S4 timings, the title suffix of the first full run and the one F4 host differ, so the older build needs no second route | NO |

## Evidence

Outside the repo, in `/Users/danfletcher/.local/share/vector/tickets/warkworth-42/results/evidence/`:

- `host-s1-s3-s5-<build>/` and `host-s2-<build>-r4/`: `chrome-spike-<build>.json` (every measurement), `run.log` and the screenshots of the
  latest host runs on 1.143.1 and 1.144.0 (S1, S3 and S5 together; S2 re-run after its picture was moved to the right moment).
- `container-chrome-1.143.1/`: the Obsidian Code tab run (`container-chrome-check.txt`, `.json`, `run.log`, two pictures);
  `container-chrome-1.143.1-run3/` is the run before the tester's round 1, kept for the R5b comparison.
- `PR-1-S<n>-<build>.png`: the pictures cited above (copies of the files in the run folders; the ones from earlier runs are in
  `earlier-run-pngs/`).
- `chrome-spike-<build>.json` and `probe-<build>.log` at the top level are from the earlier full runs, which also hold S4 and the
  fence checks that were not repeated.
