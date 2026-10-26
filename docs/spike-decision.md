---
embed: works
chrome: visible
hotkey_bridge: no
---

# Spike decision (PR-1)

Written by the PR-1 build. Round 3 ran the golden path in Obsidian itself (the
container, Obsidian 1.14.5, VS Code 1.143.1 `serve-web`, Python extensions), so the rows
that were PENDING are now filled in. Result keys above: `embed` (works | partial | fails),
`chrome` (hidden | visible), `hotkey_bridge` (yes | no).

Overall: **embed WORKS.** A plain `<iframe>` does not work in Obsidian (see below), but the
Code tab's `<webview>` renders the full workbench inside Obsidian's Electron, loads the
shared extensions, shows Python completions, follows Obsidian light/dark on reload and
opens a non-ASCII path. Caveats, each recorded in its own row: the side bar stays visible
(`chrome: visible`), Workspace Trust has to be accepted once per server start before the
Python extensions activate, keys pressed inside the workbench never reach Obsidian
(`hotkey_bridge: no`), and F5 is PARTIAL. There is no Monaco fallback (F2).

Probed on: macOS host, `Visual Studio Code.app` (an Insiders build, `1.144.0-insider`,
`code-insiders` 1.144.0), headless Chrome 156 driven over the DevTools protocol, system
`python3` 3.9.6, Node 24.11.1. Obsidian 1.14.4 is installed on the host but was not
started (it is Dan's running app). Round 3 (Obsidian): the `desktop-warkworth-34` container,
Obsidian 1.14.5 (Electron 43.7.7, Chromium 150, Node 24.21.0), VS Code 1.143.1 at
`/usr/share/code`, Python 2026.10.0 and Pylance 2026.4.1, driven over the DevTools
protocol and `xdotool`. Screenshots are in the round-3 evidence set (`PR-1-*.png`).

## Unknowns

| Unknown | Result | Evidence |
|---|---|---|
| Workbench served by `code serve-web` on loopback | WORKS | `code serve-web --host 127.0.0.1 --port <free> ...` printed its "Web UI available" line; `GET /?tkn=<token>` returned 302 once the server had downloaded (first run answers 202 "downloading" for about 40 s), 403 for a wrong or missing token. `lsof` showed `127.0.0.1:<port>` only. |
| iframe runs in Obsidian (service worker, cookies) | FAILS for `<iframe>`; `<webview>` WORKS | `<iframe>` (`data.json` `embed: "iframe"`) in Obsidian 1.14.5: the frame loads `127.0.0.1:<port>` but the page body is `Forbidden.` and no workbench is created (the server also sends `X-Frame-Options: SAMEORIGIN` and `Content-Security-Policy: frame-ancestors 'self'`, and the app origin is `app://obsidian.md`). `<webview partition="persist:vscode-workbench">` (the default): the workbench rendered (`document.title` `estimate_time.py - vault - Visual Studio Code`, 11 editor lines, no error dialog, Obsidian tab title `estimate_time.py`). Service worker and cookies work (it loaded and edited a file). |
| Token-file auth | WORKS | `--connection-token-file` (mode 0600) accepted; `?tkn=` sets the `vscode-tkn` cookie and redirects; wrong token gives 403. `ps -axww` showed 0 occurrences of the token; no token in any argument. serve-web prints the token in its own stdout line, so the plugin drains stdout and keeps nothing from it. |
| Extension sharing | WORKS (symlinks) | serve-web has no `--extensions-dir` flag. It reads `<server-data-dir>/extensions`. The plugin symlinks each extension directory from the chosen build's own extensions dir (from `product.json` `dataFolderName`, e.g. `~/.vscode/extensions`) into that dir and writes a rewritten `extensions.json` (every entry's `location` moved from the instance's folder to the symlink; round 2, see below). The instance's folder is only read. In Obsidian: the Extensions view listed Pylance, Python, Python Debugger and Python Environments, and `ms-python.python` and Pylance activated on `onLanguage:python` (extension host log). The plugin resolves the folder from `os.homedir()` of the Obsidian process; a launcher that sets a different `HOME` (the container did, until `~/.vscode` was linked) finds no extensions. Mechanism: symlink per extension. |
| Chrome hiding | PARTIAL | In Obsidian the activity bar, status bar, title bar and panel measured 0 px wide; the side bar (166 px in the 680 px tab) and the secondary side bar (162 px) stayed visible. They have no settings switch (`workbench.secondarySideBar.defaultVisibility` did not hide it on a fresh profile). Not fixed in this PR (F11: ship visible). Header: `chrome: visible`. |
| Theme follows Obsidian light/dark | PARTIAL | WORKS on reload, not live. `workbench.colorTheme` is written to the Machine settings at server start and on Obsidian's `css-change`, then open tabs reload. In Obsidian: light gave editor chrome `rgb(248,248,248)` (class `light_modern`), dark `rgb(31,31,31)` (`dark_modern`) (`PR-1-theme.png`, left light, right dark). Round 3 fix: the plugin wrote `Default Light Modern`; VS Code 1.143.1 does not know it, rewrote the Machine file to `Dark Modern` on load, and light never applied. The ids are now `Dark Modern` and `Light Modern`. |
| IntelliSense (GP4) | WORKS (yes), after Workspace Trust is accepted | In Obsidian, in `estimate_time.py`, typing `os.` opened the suggest widget with `abort, access, altsep, chdir, chmod, chown, chroot, CLD_CONTINUED, CLD_DUMPED, CLD_EXITED` (Pylance, not word-based; before trust it listed only `__main__, __name__, def, getcwd, if, import, main, os, print`) (`PR-1-intellisense.png`). |
| Workspace Trust | PARTIAL | The workbench starts in Restricted Mode. `security.workspace.trust.enabled=false` in the Machine file does not change that (round 3 removes it from the file: it was ineffective, and a silent trust-off would trust whatever sits in the vault). With Python 2026.10.0 / Pylance 2026.4.1 the extensions are listed but do not activate in Restricted Mode (the extension rows show the workspace-trust icon; no `ms-python.*` activation in the extension host log) and `os.` gives only word completions. After `Workspaces: Manage Workspace Trust` and the `Trust` button, `ms-python.python` and Pylance activated and completions came from Pylance. The trust decision is stored per origin in the Code tab's browser profile; the origin includes the random port, so a new server start asks again (observed: trusted on `:40371`, Restricted Mode again on `:42321`). Left for PR-2: decide between a stable port, an automatic trust step, or telling the user. Dan to decide. |
| Hotkey bridge into the embed | NO (confirmed) | With focus inside the workbench, Ctrl+` toggled the workbench's own panel (terminal strip 213 px high) while a capture-phase `keydown` listener on Obsidian's window recorded nothing. Electron's `<webview>` does not forward keys to the host page. Fallback per plan Q18: hotkey outside the embed plus the bottom strip. |
| Extensionless-file click interception | NOT PROBED | Needs a running Obsidian; belongs to the PR that registers extensions. Assume best-effort. |
| node / Python versions | RECORDED | Host: Node 24.11.1, system `python3` 3.9.6. Obsidian 1.14.5 (container): Electron 43.7.7, Chromium 150.0.7871.250, Node 24.21.0; container `python3` 3.14.4 (found by the Python extension). The server brings its own Node. The plugin spawns the user's `code` CLI and needs no Node of its own. |
| Telemetry | PARTIAL | `--disable-telemetry` is supported by `serve-web` and is passed: with no extensions the server process sent no telemetry. Extension telemetry is a different path (see "Outbound connections"): `telemetry.telemetryLevel: off` in the machine settings did NOT stop it (application-scoped, ignored there); setting it in the browser profile did. |
| Outbound connections (F5) | PARTIAL | See the section below. Measured on the host with a loopback logging proxy for the server tree, `lsof` on the server pids and a Chrome net-log for the workbench page. |
| Non-ASCII path (E5) | WORKS | In Obsidian, `Mock Exams/scripts/estimaté tïme 文件.py` opened in a Code tab: the workbench title and editor tab read `estimaté tïme 文件.py`, the editor showed the file's one line (`print("unicode path ok")`), and the Obsidian tab header is `estimaté tïme 文件.py` (`PR-1-nonascii.png`). Round 4: Obsidian has no view for `.py`, so such a file can never be the active file and the ribbon fell back to `estimate_time.py`. The ribbon now also tries the hand-edited `spikeFile` in `data.json` (and the file name in the other Unicode normal form) before the built-in spike file; with `spikeFile` set to this path, clicking the ribbon in Obsidian 1.14.5 opened it (workbench title `estimaté tïme 文件.py - vault - Visual Studio Code`, one editor line `print("unicode path ok")`). URL from `src/paths.ts`: `.../Mock%2520Exams/scripts/estimat%25C3%25A9%2520t%25C3%25AFme%2520%25E6%2596%2587%25E4%25BB%25B6.py`. |
| Ribbon tooltip (shot 1) | WORKS | Obsidian 1.14.5 draws the tooltip itself from the ribbon button's `aria-label` (`Open in VS Code`, set by `addRibbonIcon` in `src/main.ts`; asserted in `tests/integration/plugin.test.ts`). It shows only after the pointer travels onto the icon and rests ~300 ms (`data-tooltip-delay`), so a single teleporting mouse event or an early DOM check sees nothing. Driving CDP `Input.dispatchMouseEvent` `mouseMoved` through x = 200, 100, 60, 40, 30, 22 at y = 120, then waiting 1 s, produced `div.tooltip.mod-right` with text `Open in VS Code`, visible, at 43,103 (125 x 33 px); the DOM check ran immediately before and after `Page.captureScreenshot` (`PR-1-ribbon.png`; `PR-1-ribbon-nohover.png` is the same view with no tooltip). |
| Stop kills everything | WORKS | The `code` wrapper does not forward SIGTERM and its Electron and tunnel children leave the process group, so stopping only the spawned pid orphans the server. `stop()` signals the process group and every collected descendant. In Obsidian with the real CLI: disabling the plugin left 0 `serve-web`/`server-main`/`code-tunnel` processes and no listener on the port. |

## Outbound connections (F5), PR-1 round 2

Method: real VS Code Insiders build, Dan's 12 installed extensions shared, headless Chrome (its own throw-away profile, background networking off) loading the workbench. Server side: `HTTPS_PROXY`/`HTTP_PROXY` pointed at a logging CONNECT proxy on a scratch loopback port (the server, the extension host and the `code` launcher all honour it, so every outbound host shows up by name and by process), plus `lsof -i` on the server pid tree. Browser side: Chrome `--log-net-log`.

| Source | Before (round 1 settings) | After (round 2) |
|---|---|---|
| `code serve-web` launcher | `update.code.visualstudio.com` on every start (asks for the latest server; the cached server was a different commit from the installed build, so a newer release would be downloaded silently) | nothing once the server is cached. `--commit-id <installed build's commit>` pins the server; the one-time download happens only if that commit is not cached. WORKS |
| Server process | `main.vscode-cdn.net` | `main.vscode-cdn.net` (one request, cannot be switched off) |
| Extension host (Python, Pylance, ...) | `mobile.events.data.microsoft.com` (telemetry) and `default.exp-tas.com` (experiments), 4 connections | none. WORKS |
| Browser workbench | `marketplace.visualstudio.com/_apis/public/gallery/vscode/<pub>/<name>/latest` for each of the 12 installed extensions (24 requests with preflight), `default.exp-tas.com`, `main.vscode-cdn.net` | only `main.vscode-cdn.net` (`extensions/chat.json`, `extensions/marketplace.json`, static files). marketplace and exp-tas: none. WORKS |

Which off switches take effect:

- `--disable-telemetry` (server arg): takes effect for the server process only.
- `telemetry.telemetryLevel`, `update.mode`, `update.showReleaseNotes`, `extensions.autoUpdate`, `extensions.autoCheckUpdates`, `extensions.ignoreRecommendations`, `workbench.enableExperiments` in the server's Machine `settings.json` or in `<server-data>/data/User/settings.json`: NO effect. They are application-scoped and the workbench reads those only from the browser profile. Round 1 listed telemetry as WORKS because of this file; that was wrong.
- The same keys in the browser profile's user settings (IndexedDB `vscode-web-db`, store `vscode-userdata-store`, key `/User/settings.json`): take effect. The Code tab writes them with `buildBrowserSeedScript` (`src/settings.ts`): the webview first loads the server's origin, the script merges the keys into that file (other settings kept; a file it cannot parse is left alone), then the webview navigates to the workbench. Verified in headless Chrome against the real server and Dan's extensions: marketplace 24 to 0, exp-tas 2 to 0, extension-host telemetry gone, Python completions still shown (`abort, access, altsep, chdir, ...` after `os.`).
- Verified in round 3: Obsidian's Electron `<webview>` fires `dom-ready` on the server's bare origin and `executeJavaScript` can write IndexedDB; the seeded keys were read back from `vscode-web-db` in the running Code tab. The Code tab does not log the seed's outcome, so a future silent failure would only show as the round-1 traffic.
- The seed depends on VS Code internals (database name, version 3, store and key names). Re-check it whenever the server commit changes behaviour; the Code tab keeps working if it stops matching, it just goes back to making the calls above.

Round 3 (inside Obsidian's `<webview>`, VS Code 1.143.1, the four Python extensions): the browser profile held the seeded keys (read back from IndexedDB `vscode-web-db`), so the seed does run in Obsidian's Electron (R9). Requests from the workbench page to anything other than 127.0.0.1, from the Resource Timing list and a DevTools Network capture of a reload: `main.vscode-cdn.net/extensions/chat.json`, `main.vscode-cdn.net/extensions/marketplace.json`, and one `POST marketplace.visualstudio.com/_apis/public/gallery/extensionquery` asking for the single extension id `github.copilot-chat` (a fixed id from the workbench's chat feature; it does not send the installed extension list). That last request is new compared with the headless-Chrome run and was not switched off by the seeded keys. Server side: `ss -tn state established` over 30 s showed no connection owned by the server tree; the only non-loopback connection belonged to Obsidian's own network process (`150.171.74.16:443`, a Microsoft address). Result stays PARTIAL: `main.vscode-cdn.net` and the one `github.copilot-chat` marketplace query on each load. Dan to decide.

Result: F5 is PARTIAL. Everything the plugin starts is silent except `main.vscode-cdn.net`, and that cannot be switched off from settings. It would need a loopback proxy in front of the workbench that rewrites the page's Content-Security-Policy, or a patched `product.json` in the downloaded server; both are bigger and are left for a later PR. Blocking all extension network access (a dead `HTTPS_PROXY` for the server tree) would also silence the server side but break extensions that need the network, so it is not done. Dan to decide.

### Extension sharing: `extensions.json` (R1)

Real `extensions.json` entries carry an absolute `location` into the instance's own folder (Dan's: `/Users/danfletcher/.vscode-insiders/extensions/ms-azuretools.vscode-docker-2.0.0`). Round 1 copied the file unchanged, so the server could have resolved extensions in the instance's real folder. `shareExtensions` now rewrites each `location` to the same-named symlink under `<server-data>/extensions`; the copy contains no path under the instance's folder. Observed on the real server: the server removed the link of an extension the instance marks obsolete (`ms-python.vscode-python-envs-1.41.2026102201`); the instance's folder and its 180 files were untouched, and the instance's folder listing and `extensions.json` checksum were identical before and after four server runs. A unit test removes an extension through the link and checks the instance's copy survives. Auto-update and update-check switches are set in the browser profile as above (Machine scope does not take effect), which is where they apply.

## Which later checks apply, by result

| Spike result | What later PRs do |
|---|---|
| `embed: works` (now) | Later PRs run all webview checks as written (the `<webview>` Code tab; never `<iframe>`). |
| `embed: partial` | Build on the `<webview>` Code tab; checks that need the tab to render run only once a container shot of the Code tab confirms it. |
| `embed: fails` | STOP: ask Dan. Later PRs do not start. No Monaco or CodeMirror fallback (F2). |
| `chrome: hidden` | Add a check that the side bar, activity bar, status bar and panel are not visible. |
| `chrome: visible` (now) | Ship with chrome visible (F11); skip the hidden-chrome check; keep the check that the activity bar and status bar are hidden by settings. |
| `hotkey_bridge: yes` | Check Ctrl+` and the quick switcher with focus inside the editor. |
| `hotkey_bridge: no` (now) | Check the hotkey and strip outside the embed only; with focus inside the editor expect the editor to keep the key. |

## Round-3 container run: what was checked

All of the former open items were run in Obsidian 1.14.5: Code tab renders (`PR-1-code-tab.png`),
`<iframe>` fails, theme toggled (`PR-1-theme.png`), Ctrl+` confirmed not bridged, Node version
recorded. Still for Dan on his Mac: the feel of IntelliSense and the real macOS VS Code build
with his own extensions (Pylance), and the Workspace Trust decision above.
