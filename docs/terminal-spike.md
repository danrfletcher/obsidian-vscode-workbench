---
panel_only: works
reattach: yes
sweep: finds_shells
cwd_open: extension
live_shells: reliable
focus_bridge: yes
shared_terminals: shared
---

# Terminal spike (ticket warkworth-37, PR-1)

Every answer below is a measured result from `npm run check:terminal-spike`
(`tests/render/terminal-spike-check.mjs`), which writes `terminal-spike-result.json` and the screenshots. Nothing the
user sees changes in this PR: the old `src/terminal/*` drawer is untouched, and no drawer is drawn from a blank or partial page.

Front-matter keys above: `panel_only` (works | fails), `reattach` (yes | no | partial), `sweep` (finds_shells |
misses_shells | partial), `cwd_open` (outside_page | extension | not_possible), `live_shells` (reliable | unreliable),
`focus_bridge` (yes | no), `shared_terminals` (shared | separate).

## How it was measured, and what it was not

- Host run, not the container: macOS (darwin 25.6.0), VS Code Insiders 1.145.0-insider (`code serve-web`), the cached VS Code
  server for commit `206844b5537c1b7582f6e81b41e1c5402c7e7fbc` (passed through `buildServeWebArgs`' `commitId`), headless Google Chrome driven over the DevTools
  protocol. The probe starts the server through `buildServeWebArgs` on 127.0.0.1 on a free port with `--connection-token-file` and
  `--disable-telemetry`, in a scratch folder, and stops what it started by PID.
- **Stand-in for the second `<webview>` partition:** a Chrome browser context (its own cookies, IndexedDB and storage) in place of an
  Obsidian `<webview>` with its own `partition`. It is the same isolation rule but it is not Obsidian's Electron `<webview>`. The
  container run in Obsidian is the tester's job and was not done by the coder: it has since been run for GP2, S2, shot 3 and the `webview.reload()` of the real webview (recorded under S2, S3 and the golden-path notes); destroy and recreate of the real webview was not run there. For the parts that need the shell's working directory and the process tree, the tester now has a helper that reads them from the operating system instead of the page: see [Container run](#container-run).
- The probe sends the keys through the DevTools protocol (`Input.dispatchKeyEvent`). Inside Obsidian the equivalent is
  `webContents.sendInputEvent` or a script in the page; that has not been tried here.
- Probe-only settings (they change nothing visible, they let the probe read terminal text from the page):
  `terminal.integrated.gpuAcceleration: off`, `editor.accessibilitySupport: on`, `terminal.integrated.tabs.hideForOneTerminal: false`.
- Nothing in `src/` calls the probe or the extension used for S2. `package.json` gains one script and no dependency.
- F6: `~/.vscode`, `~/.vscode-insiders` and the desktop `Code` and `Code - Insiders` `settings.json` / `keybindings.json` were listed before and
  after the run: no change. F4: `lsof` listed only `127.0.0.1:64099` for the server tree, and the token appears in no process argument.

## S1 Panel-only layout (`panel_only: works`)

Result: measured, holds. In the terminal page's own browser context, with the panel open, the title bar, activity bar, side bar,
auxiliary bar, editor area and status bar each measure 0 px and the panel fills the window (1392 x 892 in a 1400 x 900 window).

Mechanism (copy this for PR-2):

1. The plugin's existing Code tab browser settings (`BROWSER_APP_SETTINGS` and `workbenchOverlay` from `src/settings.ts`, seeded with
   `buildBrowserSeedScript`, plus the trust record from `buildTrustSeedScript`) already hide the title bar, activity bar, menu bar and status bar.
2. One more setting: `"workbench.panel.opensMaximized": "always"`. With it, opening the panel hides the editor area.
3. Two key presses, once, in that browser context: `Ctrl+backtick` (opens the terminal panel, which starts the first shell) and `Cmd+B` / `Ctrl+B`
   (hides the side bar). Before them the page measured: side bar 296 px wide, editor 1092 px wide, panel 0.
   There is no setting or URL parameter found here that does this without the key presses.

It survives: a page `reload()` with no key press (held), the page destroyed and created again in the same context (held), and the server stopped and started again
on the same port (held; the panel layout is kept in the browser context, not by the server). Reloading a page with a running terminal raises a
`beforeunload` dialog; a webview has no dialog UI, so the host has to answer it (the probe accepts it).

Code tab check: a Code tab in the default context (the plugin's own settings only) measured side bar 296 x 892, editor 1092 x 892, panel 0 before and after
all of the above: unchanged, panel closed.

Panel header actions seen: Problems (⇧⌘M), Output (⇧⌘U), Debug Console (⇧⌘Y), Terminal (⌃`).

Terminal list (GP2): VS Code draws the list only from the second terminal on; with one terminal it measured 0 entries (`terminal.integrated.tabs.hideForOneTerminal: false`, set in this
page's settings, did not change that). With two terminals the list had two entries, both at x = 1280 in a 1400 px window, so it sits on the right of the panel
(`shot-1b-panel-only-two-terminals.png`). The first shell started in the vault root (the folder the page was opened on), and so did the second (`firstShellInVaultRoot: true`,
`secondShellInVaultRoot: true`, read with `lsof`).

Evidence: `shot-1-panel-only.png`, `shot-1b-panel-only-two-terminals.png`, `shot-4b-code-tab-beside.png`.

How the product makes the page panel-only (PR-5, replaces the key presses above). The plugin's first versions sent the keys with the `<webview>`'s
`sendInputEvent`; on a truly fresh profile in the container (Obsidian 1.14.5, new `--user-data-dir`, vault without `.server`, licence accepted) the
side bar went away but the panel never opened, four Ctrl+backtick presses included, and the drawer ended on "The VS Code terminal panel did not open
on its own." The earlier panel-only results came from a partition that already held the layout. A read of the page's parts before any action
showed what a fresh profile starts in: side bar 166x291, editor 502x291, panel 0, activity bar, secondary side bar, title bar and
status bar 0, in a 680x299 window (the secondary side bar was 0 there, not open). With the keys switched off, the panel still came up (side bar
166, panel 502, editor 0) once a terminal request ran `newWithCwd`, so it was not panel-only. The plugin-owned extension, which already runs in this page, now runs VS Code's commands
`workbench.action.closeSidebar`, `workbench.action.closeAuxiliaryBar` and `workbench.action.terminal.focus` once per page load, before it takes
any request; the host page only waits for the layout. With that, the same fresh profile reached panel 672x291, every other part 0, within about
two seconds of the first paint, with one shell (in the folder asked for, or the vault root when the drawer was opened by hand). Run with
`evidence/PR-5/coder-7/` (scripts and layout logs).

## S2 Open a terminal at a chosen folder (`cwd_open: extension`)

The command is VS Code's own `workbench.action.terminal.newWithCwd` with `{ "cwd": "<folder>" }`. Typing `cd` is not used.

- From outside the page: a keybinding with `args` written to the browser context's `keybindings.json` (`buildBrowserSeedScript` already carries
  `keybindingsBase64`) works only after the page is reloaded (not live: `openedWithoutReload: false`), and the folder is fixed in the keybinding. Both folders
  below opened in the right place after the reload. It is not a way to open a terminal at a folder chosen at the moment of the click without rewriting the file and reloading.
- Through a small plugin-owned extension: needed for a folder chosen on demand. The plugin writes `request.json` (`{ "id": "<unique>", "cwd": "<folder>" }`, written whole:
  a temp file, then a rename) into the extension's folder, the extension runs `newWithCwd` with it. Its install path is inside the server's own extension dir:
  `<server-data-dir>/extensions/obsidian-vscode-workbench.terminal-at-0.0.1/` (`package.json`, `extension.js`) plus an entry in
  `<server-data-dir>/extensions/extensions.json`. It activated on `onStartupFinished` with no reload. **The version PR-2 should copy is
  `tests/render/terminal-at-extension.cjs`** (the probe installs that file; `tests/integration/terminal-at-extension.test.ts` runs it against a fake `vscode`).

Why there are two versions (the Obsidian container run found this): every extension host the server has watches the same request file. A host stays alive for the
reconnection grace period after its page goes (S3), a Code tab has its own, and so does any other server still running on the same server data dir (the container
run had four servers on one extension folder). Version 1 deleted the file on sight, so a host that could not act, because its page was gone, swallowed the request: the file was
"consumed" and no terminal opened. Version 2 changes three things: a host acts only when its own browser profile carries the setting
`obsidianWorkbench.terminalPage` (the extension contributes it; the terminal page's seeded settings set it to `true`, a Code tab's do not), it deletes the file only after VS Code's command has answered and only if the file still
holds the id it ran (a host whose page is gone gets no answer and leaves the file for the live one), and it runs each id once.

What the probe measured (host run; each folder was asked for in turn, the new shells under the server counted, the shell's working directory read with `lsof`, and `pwd` typed in the terminal):

| extension | server history | asked per folder | spaces | non-ASCII | missing folder |
|---|---|---|---|---|---|
| version 1 | one page, a Code tab beside, page reloaded, reloaded twice 0.4 s apart, destroyed, created again, reloaded (7 extension hosts) | 1 | opened, right folder | opened, right folder | no terminal |
| version 1 | two servers left running on the same extension folder, no reloads | 3 | **opened 2 of 3** (one request taken and lost) | opened 3 of 3 | no terminal |
| version 2 | both histories at once: two other servers on the folder, a Code tab beside, the reloads above | 3 | opened 3 of 3, right folder | opened 3 of 3, right folder | no terminal, 3 of 3 |
| version 2 | fresh server, one page never reloaded | 1 | opened, right folder | opened, right folder | no terminal |

So version 1 does lose a request when other hosts watch the same file (reproduced on the host with leftover servers; it is not the Obsidian container itself that is at fault), and version 2 got all 12 of its requests right (8 terminals opened at the right folder, 4 correctly refused) with that history.
Version 1's loss is intermittent (it depends on which host sees the file first), so the one failure in the table is a floor, not a rate.
Still to be confirmed: the same four-server situation in the Obsidian container (the tester's run, with `container-terminal-check.py terminal-at`: see [Container run](#container-run)); the host's Chrome is not Obsidian. The container result is the next block.

Container result for S2 (tester run 10, Obsidian 1.14.5 in `desktop-warkworth-37`, vault `/config/w37/vault`, extension version 2 installed in the server's own extension dir, evidence `tester10/terminal-at-t10.txt`, `tester10/open-page-t10.txt`). The steps, in the order the helper runs them (see [Container run](#container-run)): `open-page --accept-licence` (a Code tab, then the panel-only `<webview>` in the partition `persist:vscode-workbench-terminal-spike`, which reached the panel-only layout: panel 1016x323, every other part 0 px, and the Code tab's layout unchanged); `terminal-at` (extension installed, the page's settings seeded, the page reloaded with `webview.reload()` from the Obsidian window and painted again); then for each folder, a `request.json` written by rename into the extension dir, and the answer read from the operating system, not the page: a new shell under the pty host, `readlink /proc/<pid>/cwd`, and `pwd | tee <file>` typed into that terminal.

| folder | request file | new shell | shell's cwd (`readlink`) | `pwd` printed |
|---|---|---|---|---|
| `Notes folder with spaces` | taken | yes | `/config/w37/vault/Notes folder with spaces` | the same (typed with `insertText`) |
| `estimaté tïme 文件` | taken | yes | `/config/w37/vault/estimaté tïme 文件` | the same (typed with `insertText`) |
| `folder that does not exist` | taken | **no terminal** (see below) | none | none |

So `cwd_open: extension` now rests on a container run as well as the host run: the folder with spaces and the non-ASCII folder each opened a terminal in the right folder (shot 3: `tester10/shot-3-container-terminal-at-folder-with-spaces.png`, `pwd` visible). The earlier container failure (T1, the request file was never taken) was with version 1 of the extension; version 2 took every request in this run, and the helper FAILs when a leftover serve-web still uses the server data dir (this run had none).

The folder that does not exist: the request file was taken and the page showed "The terminal process failed to launch: Starting directory (cwd) \"/config/w37/vault/folder that does not exist\" does not exist." (`tester10/t10-page-after-missing-folder.png`). The pty host forked a child for it (pid 4727) that failed its `chdir` and exited with 126 at once: it was gone from `ps` and `/proc/4727/cwd` read back as nothing. No terminal was opened. Run 10 of the helper counted that dead child as a new shell and so printed a FAIL for this line (T64); that was the helper's mistake, not the extension's. The helper now counts a new shell only if its cwd reads back and it is still alive, with a readable cwd, a second later, and the line says how many such short-lived children it saw. That change is pinned against a pretend machine (`tests/integration/container-terminal-check.test.ts`, T64) and has not been run in the container yet.

Folders tried (version 2; `pwd` printed what the shell's cwd showed):

- with spaces, `vault/Notes folder with spaces`: terminal opened, shell cwd matched, `pwd` printed `.../vault/Notes folder with spaces` (`shot-3-new-terminal-at-folder.png`).
- non-ASCII, `vault/estimaté tïme 文件`: terminal opened, shell cwd matched, `pwd` printed `.../vault/estimaté tïme 文件`.
- a folder that does not exist: no terminal opened; VS Code showed the notice "The terminal process failed to launch: Starting directory (cwd) \"...\" does not exist.".

PR-2 still has to decide what the plugin does when no host answers (the request file stays in place; this spike adds no retry and no timeout, F9).

Evidence: `shot-3-new-terminal-at-folder.png`, `terminal-spike-result.json` (`s2`).

## S3 Reattach after reload (`reattach: yes`)

Exact test: open a terminal (first `Ctrl+backtick`), type `echo SPIKE-MARK-1; sleep 600`, then (a) `reload()` the page, (b) destroy the page and create it again in the same
browser context, (c) two `reload()` calls 0.4 s apart. After each, the probe read the server's process tree and the terminal's text.

- The same shell process (pid unchanged) and the same `sleep 600` under it were alive after (a), (b) and (c).
- The text `SPIKE-MARK-1` was back in the terminal after (a), (b) and (c): the scrollback came back.
- Two reloads in quick succession left one server and the same number of shells (1 before, 1 after).
- Cost seen: each page connection leaves an extension host (a ~170-190 MB node process) alive after the page is gone. After the S1 and S3 reloads and recreates the server tree held 9 extension hosts.

When terminals do not reattach (a server restart, or a different browser context), the drawer must say so plainly: "Terminals lost: the terminal server was restarted, so the shells that were running in it are gone."
(Measured: after the server was stopped and started again, 4 shells before and 1 new shell after; the old ones were killed with the server.) No workaround was tried and none is proposed here.

Container result for S3 (tester run 10, same Obsidian and server as S2; evidence `tester10/reattach-gp3-two-reloads.txt`, a scratch probe of the tester's, not part of the repo). Steps: in a terminal of the panel-only page, `sleep 600` and `python3 -m http.server 8077` were started (server pid 4182; sleep pid 5280; http.server pid 5311; a GET answered 200); then the page's `<webview>` was reloaded with `webview.reload()` from the Obsidian window; then two more reloads in quick succession.

- After reload 1 the page painted again, `sleep` (pid 5280) and `http.server` (pid 5311) were both still alive, and the GET answered 200 with the same pid.
- After the two quick reloads the page painted; there were 4 shells under the server (pids 4521, 4625, 4665, 4697: the four terminals the S2 steps had opened, none new), one `http.server` on that port, 5 serve-web processes (one tree), the same `sleep` alive and the GET still 200.
- So in a real Obsidian `<webview>`, `reload()` kept the shells, the `sleep 600` and the `http.server`, and two reloads in quick succession left neither a second shell nor a second server. `reattach: yes` now holds for the reload in the container too.
- Not run in the container: destroying the `<webview>` and creating it again, and a hidden (not just reloaded) `<webview>`. Those two are still host-only (Chrome stand-in) results.

Evidence: `shot-2-after-reload.png`.

## S4 Live shells (`live_shells: reliable`)

The shells are the children of the server's `--type=ptyHost` process; their parent is that pty host, one `zsh -il` per terminal. The probe counted them with `ps` (the same
parent walk `descendantsFromPs` in `src/process-utils.ts` does; `tests/integration/process-tree.test.ts` pins the shapes). The count matched the expected one in all four states.
`$WORK` is the scratch folder. Columns: pid, ppid, state, RSS, command.

Idle prompt (second terminal just opened, nothing typed; the first still holds the S3 `sleep 600`):

    1030  87088 S       82M  $WORK<server>/node $WORK<server>/out/bootstrap-fork --type=ptyHost --logs
    1031   1030 Ss       5M  /bin/zsh -il
    3754   1031 S+       1M  sleep 600
    4090   1030 Ss+      5M  /bin/zsh -il

Running command (`sleep 601` typed in the second terminal; the shell has a child):

    1030  87088 S       83M  $WORK<server>/node $WORK<server>/out/bootstrap-fork --type=ptyHost --logs
    1031   1030 Ss       5M  /bin/zsh -il
    3754   1031 S+       1M  sleep 600
    4090   1030 Ss       5M  /bin/zsh -il
    6655   4090 S+       1M  sleep 601

Hung shell (a third terminal; `kill -STOP $$`; `ps` state `T`, still a child of the pty host: the tree alone does not tell it from a live one, the state letter does):

    1030  87088 S       83M  $WORK<server>/node $WORK<server>/out/bootstrap-fork --type=ptyHost --logs
    1031   1030 Ss       5M  /bin/zsh -il
    3754   1031 S+       1M  sleep 600
    4090   1030 Ss       5M  /bin/zsh -il
    6655   4090 S+       1M  sleep 601
    6761   1030 Ts+      5M  /bin/zsh -il

Exited shell (a fourth terminal; `exit 7`): the shell process is gone from the tree (three shells remain, as above). A leftover tab was not seen: the probe's tab count went from
5 to 4 and no exit message was found in the terminal text. So with these settings the process tree and the tab list agreed after `exit 7`; a case where a tab outlives its shell was not produced.

Memory (RSS summed over ps, whole server process tree; and the host page's renderer processes in headless Chrome, which is not Obsidian's renderer):

- Fresh server, one page never reloaded, one shell at an idle prompt: server tree 1010 MB (of which the shell 5 MB), host page 877 MB.
- Fresh server, one page never reloaded, three shells (idle prompt, `python3 -m http.server`, `sleep`): server tree 1052 MB (shells and their children 41 MB), host page 922 MB.
- The same server after the S1 and S3 reloads: server tree 1851 MB with one shell, 2468 MB with three; the growth is the extension hosts that earlier page connections left behind, not the shells.

A shell costs about 5 MB; the memory is the VS Code server (server-main, the extension host, the agent host and its `copilot-runtime`, the file watcher), not the terminal.

## S5 Borrow the source: desk assessment

Desk assessment only. No prototype was built, and nothing was run beyond reading the server folder and `node-pty`'s `package.json`. It states no verdict; the choice is Dan's.

| Question | What was found |
| --- | --- |
| Licence | The VS Code source repository is published under the MIT licence. The built server that `code serve-web` downloads and runs is covered by Microsoft's licence terms: the `LICENSE` file in the server folder begins "MICROSOFT PRE-RELEASE SOFTWARE LICENSE TERMS, MICROSOFT VISUAL STUDIO CODE REMOTE DEVELOPMENT EXTENSIONS" (`product.json` points at `https://go.microsoft.com/fwlink/?LinkID=761088`). Taking source from the repository and building it ourselves would be on the MIT terms; running Microsoft's server is the route the plugin takes today. Not checked here: whether a bundled copy of the terminal code can be redistributed with a plugin. |
| Dependence on the workbench service layer | The terminal in `vs/workbench/contrib/terminal` is written against the workbench's services (instantiation, configuration, theming, storage, remote agent, the pty host connection). Not measured here. Lifting it without the server means supplying or stubbing that layer and a pty host of our own; only xterm.js itself is a plain library (the plugin already has an xterm.js drawer). |
| Native `node-pty` against the no-native-modules rule | The server ships `node-pty` 1.2.0-beta.18 (licence field "MIT") with a native binary: `node_modules/node-pty/build/Release/pty.node`. A server-less terminal needs a pty, so it needs `node-pty` or an equivalent native piece, which the rule rules out; the server route carries the native file in Microsoft's download, not in the plugin. |
| Size and upkeep | The cached server folder is 632 MB on disk (117 MB of it the node binary, 48 MB the compiled `out` folder). The server route costs that download once per VS Code version and no code to maintain. A borrowed terminal would be a fork of an upstream folder that changes every month, kept in step by hand. |
| Memory against the server route | Server route, measured in S4: about 1010 MB for the server tree plus about 877 MB for the page with one shell, and about 5 MB for each further shell. A server-less terminal would have no server tree and no extension hosts; xterm.js plus a pty is expected to be far smaller, but that was not measured. |

## S6 Startup sweep after a simulated force-quit (`sweep: finds_shells`)

The probe runs a stand-in "Obsidian" node process that starts the server the way `src/server.ts` does and records it in a pidfile with the same entry
(`PidEntry` with `match` = the token-file path, `findByMatch: true`, `group: true`). Three terminals are opened in the page: an idle shell, `python3 -m http.server`, and
`nohup sleep ... & disown`. The stand-in is `SIGKILL`ed. Then the plugin's own `sweepOrphans` runs.

What `PidEntry.match` / `findByMatch` does and does not catch: `match` is checked against the wrapper's command line (the token-file path is in it), so a reused pid is spared. With `findByMatch` the sweep also kills every other
process whose command line carries the token-file path, which is how a server whose wrapper already died is still found (the `code-tunnel` process, here). It does not
carry that path on a shell: the shells and the dev server under the pty host have command lines `/bin/zsh -il` and `python3 -m http.server ...`, so they are found only by the walk down the process tree from the wrapper (`descendants`), and only while the tree is still connected.

Scenario A, Obsidian is `SIGKILL`ed and the server survives (it is detached): the server, three interactive shells, the `http.server` (still answering) and the `nohup` process were all alive after the force-quit; after the sweep none of them was
(`killed`: the wrapper; the shells, the dev server and the `nohup` process were reached through the tree because the `nohup` process was still a child of its shell).

Process tree before the force-quit, after it, and after the sweep (processes that are the extension host, agent host, file watcher and their children omitted):

Before:
   19099  19098 Ss       2M  bash <code>/code serve-web --host 127.0.0.1 --port 52115 --connection-token-file $WORK/runt
   19104  19099 S       78M  <code>/Code - Insiders <code>/cli.js serve-web --host 127.0.0.1 --port 52115 --connection-t
   19105  19104 S       15M  <code>/code-tunnel-insiders serve-web --host 127.0.0.1 --port 52115 --connection-token-file
   19106  19105 S        2M  bash $WORK<server>/bin/code-server-insiders --socket-path /tmp/code-insiders-c51dc4b3-260a-
   19128  19106 S      275M  $WORK<server>/node $WORK<server>/out/server-main.js --socket-path /tmp/code-insiders-c51dc4
   19265  19128 S       83M  $WORK<server>/node $WORK<server>/out/bootstrap-fork --type=ptyHost --logsPath $WORK/runtime
   19266  19265 Ss+      5M  /bin/zsh -il
   21759  19265 Ss       5M  /bin/zsh -il
   24268  21759 S+      25M  python3 -m http.server -m http.server 52190 --bi
   24307  19265 Ss+      5M  /bin/zsh -il
   26803  24307 SN       1M  sleep 739

After the force-quit, before the next plugin start:
   19099      1 Ss       2M  bash <code>/code serve-web --host 127.0.0.1 --port 52115 --connection-token-file $WORK/runt
   19104  19099 S       78M  <code>/Code - Insiders <code>/cli.js serve-web --host 127.0.0.1 --port 52115 --connection-t
   19105  19104 S       15M  <code>/code-tunnel-insiders serve-web --host 127.0.0.1 --port 52115 --connection-token-file
   19106  19105 S        2M  bash $WORK<server>/bin/code-server-insiders --socket-path /tmp/code-insiders-c51dc4b3-260a-
   19128  19106 S      275M  $WORK<server>/node $WORK<server>/out/server-main.js --socket-path /tmp/code-insiders-c51dc4
   19265  19128 S       83M  $WORK<server>/node $WORK<server>/out/bootstrap-fork --type=ptyHost --logsPath $WORK/runtime
   19266  19265 Ss+      5M  /bin/zsh -il
   21759  19265 Ss       5M  /bin/zsh -il
   24268  21759 S+      25M  python3 -m http.server -m http.server 52190 --bi
   24307  19265 Ss+      5M  /bin/zsh -il
   26803  24307 SN       1M  sleep 739

After the sweep:
  (nothing)

Scenario B, the server's own process (`server-main`) is killed too, then Obsidian: the shells and the `http.server` were gone once the server process was killed, the wrapper chain was left half alive, and the `nohup` process was re-parented to init (ppid 1):

Before:
   27740  27739 Ss       2M  bash <code>/code serve-web --host 127.0.0.1 --port 52233 --connection-token-file $WORK/runt
   27745  27740 S       78M  <code>/Code - Insiders <code>/cli.js serve-web --host 127.0.0.1 --port 52233 --connection-t
   27746  27745 S       15M  <code>/code-tunnel-insiders serve-web --host 127.0.0.1 --port 52233 --connection-token-file
   27748  27746 S        2M  bash $WORK<server>/bin/code-server-insiders --socket-path /tmp/code-insiders-9949944a-4051-
   27754  27748 S      239M  $WORK<server>/node $WORK<server>/out/server-main.js --socket-path /tmp/code-insiders-994994
   27875  27754 S       83M  $WORK<server>/node $WORK<server>/out/bootstrap-fork --type=ptyHost --logsPath $WORK/runtime
   27878  27875 Ss+      5M  /bin/zsh -il
   30394  27875 Ss       5M  /bin/zsh -il
   33254  30394 S+      24M  python3 -m http.server -m http.server 52304 --bi
   33297  27875 Ss+      6M  /bin/zsh -il
   35811  33297 SN       1M  sleep 783

After:
   27746      1 S       16M  <code>/code-tunnel-insiders serve-web --host 127.0.0.1 --port 52233 --connection-token-file
   35811      1 SN       1M  sleep 783

After the sweep (the sweep reported the wrapper as `gone` and found one straggler by the token-file match, the `code-tunnel` process):
   35811      1 SN       1M  sleep 783

Per process type, what the sweep should do:

- The server: kill (it does).
- Interactive shells: kill (reached through the tree).
- A running `python3 -m http.server` started in a terminal: kill (reached through the tree; in scenario B it died with its shell).
- A `nohup` / `disown` process: it outlived Obsidian and outlived the sweep when its shell was gone (scenario B), as it does in real VS Code. The sweep cannot identify it and should not guess. In scenario A, with the shell still alive, the tree walk killed it too. That difference is a decision for Dan: either leave `nohup` processes alone in both cases (stop the walk at shells that hold them, not possible with the pidfile as it is) or accept that they are killed when their shell is still under the server at the sweep.

Shot 4: `shot-4a-ps-before-force-quit.png` is `ps` run in the page's own terminal (limited to the server's pty host and what is under it) before the force-quit; after the force-quit and after the sweep the
terminals are gone, so there is no page to run `ps` in, and `shot-4c-ps-before-and-after-text.png` draws the three `ps` row sets the probe took as text in a plain page (a render of captured text, not a terminal).
`shot-4b-code-tab-beside.png` is the Code tab beside the page, layout unchanged.

Evidence: the trees above; `tests/integration/orphan-sweep.test.ts` (the fake-server version, with real processes) pins the sweep finding a detached shell and its `http.server` and leaving an unrecorded `nohup` process alone.

## S7 Focus and the Ctrl+backtick bridge (`focus_bridge: yes`, `shared_terminals: shared`)

- Focus: after the panel is shown with `Ctrl+backtick`, VS Code put focus in the terminal's `xterm-helper-textarea`. The script used to move focus there from outside:
  `(() => { const t = document.querySelector('.terminal-wrapper.active .xterm-helper-textarea') || document.querySelector('.xterm-helper-textarea'); if (!t) return 'no terminal'; t.focus(); return document.activeElement === t ? 'focused' : 'not focused'; })()` returned `focused`, and typed text then reached the terminal (`echo FOCUS-OK-$((20+22))` printed `FOCUS-OK-42`).
- Control, without the bridge: `Ctrl+backtick` pressed with focus in the terminal is VS Code's own toggle, and it hid the panel (1392 x 892 to 0 x 0).
- With the bridge: `buildRelayScript(chords, nonce)` from `src/hotkey/hotkey-bridge.ts` (the script the Code tab already gets) run in the page with one chord (`ctrl+backtick`, action `toggle-terminal`). With focus inside the terminal, pressing the chord produced the console line
  `__vscw_key__:{"v":1,"action":"toggle-terminal","n":"<nonce>"}`, which is what the host listens for, and the panel stayed open (VS Code's own toggle did not also fire).
- Shared or separate: a Code tab in the default context, opened its panel with `Ctrl+backtick`: its panel opened (1092 x 292), showed one terminal and started no new shell (shells under the pty host: 4 before, 4 after).
  So `shared_terminals: shared` here means the Code tab attached to a terminal that already existed on that server instead of starting its own. This is one observation with one workspace folder; which terminal it attached to was not identified.

Evidence: `shot-5-focus-and-bridge.png`.

## Golden-path notes (container run first, then the host run; see [Container run](#container-run))

- GP2 in the container (tester run 10, `tester10/terminal-at-t10.txt`): the panel-only `<webview>` in its own partition started one shell under the server, in the vault root (`readlink` of the shell's cwd: `/config/w37/vault`); with two terminals the terminal list sat on the right (entries at x 904 and 904 of a 1024 px page); the second shell also started in the vault root. The licence, download and first-start steps are noted as seen, not built: `open-page --accept-licence` pressed "Accept and download" 0 times in that run because the licence was already accepted in an earlier run.
- GP3 in the container (`tester10/reattach-gp3-two-reloads.txt`): `python3 -m http.server` started in a terminal of the page kept running, with the same pid and answering 200, after a `webview.reload()` and after two more quick reloads. Not tested: a hidden `<webview>`, and destroy and create again.
- GP2 (partly), host run: a panel-only page in its own browser context started one shell, in the vault root, and drew the terminal list on the right once there were two terminals (see S1). Licence, download and first-start: on this machine the server was already cached; the first `serve-web` request answered HTTP 202 while the server downloaded and was not built into anything here.
- GP3 (partly), host run: `sleep 600` kept running through a reload, a destroy and recreate and two quick reloads. `python3 -m http.server` (started in a terminal of the page, on a port the probe picked) was fetched over HTTP at each step and answered with the same pid: with the page open, with the page frozen (`Page.setWebLifecycleState: frozen`, Chrome's stand-in for a hidden webview: timers and rendering stop), after `reload()`, with the page destroyed and no page open, and with the page created again. It also kept running through an Obsidian force-quit (the server outlived it) and was killed by the sweep (S6). A server stop kills every shell, as it should. A hidden Obsidian `<webview>` itself was not tested.

## Container run

Status: **run in the container by the tester; the results are recorded above.** The tester's tenth run (`desktop-warkworth-37`, Obsidian 1.14.5) passed `open-page` (10 PASS, 0 FAIL: Code tab, own partition, panel-only layout, the Code tab's layout unchanged, the plugin's pidfile) and 16 of the 17 checks of `terminal-at`: the reload and repaint, S1, GP2 (one shell in the vault root, the list on the right, the second shell in the vault root), S2 for the folder with spaces and the non-ASCII folder (shell cwd and `pwd`), and the Code tab's layout. The 17th, "a folder that does not exist opens no terminal", failed because the helper counted a short-lived child of the pty host as a terminal (T64, explained under S2); the helper is fixed and pinned against a pretend machine, and that one line has not been run in the container since. `force-quit` (E7, shot 4) is not yet run in the container; its results are the host's. The modes `terminal-at` and `force-quit` were first run on the host against a real `code serve-web` (server commit 206844b5) and headless Chrome, with a Code tab beside the page. How the container helper got there, run by run (each of these was a fault in the helper, none in the plugin): the sixth run found no Code tab (the plugin's open-spike-file command has no file to open in a clean vault, T37), a page that was not panel-only (T37) and no repaint after the reload (T38); the seventh found that the 'exactly one new webview' check counted the Code tab's second webview (T44), that a DOM `click()` does not focus the workbench so the layout keys were swallowed (T45), and that after the reload the helper connected to a Code tab's webview (T46); the eighth found that a press at the window centre lands on the terminal once the panel is open (T50) and that a CDP `Page.reload` on the page's own target closes it (T49); the ninth found the reload still lost the page in the helper while a direct probe kept it (T55) and that the Code-tab guard printed nothing (T56). The helper now hides the bars first, each after a real press inside that bar, opens the panel last after a press on the editor, reloads with `webview.reload()` from the Obsidian window, finds the page by its partition and measures every Code tab. In the tenth run all of that worked in the container.

Why the earlier container attempt could not answer: the S2 extension (`tests/render/terminal-at-extension.cjs`, version 2) acts only in a page whose own settings carry `obsidianWorkbench.terminalPage = true`. A panel-only page built by hand has no such setting, so every host left `request.json` where it was; and the shell's folder was read from the page, which does not show it. `tests/render/container-terminal-check.py` does both properly: it writes the setting into the panel-only webview's own settings through that webview's CDP target (the same merge as `buildBrowserSeedScript`, keeping every other key), installs the extension, writes `request.json` by rename, and reads the answers from the operating system: the new shell's folder is `readlink /proc/<pid>/cwd`, the `pwd` text is written by the shell itself to a file, and the process trees are `ps -ef --forest`.

It needs python3 and the `websockets` package (both in the container; no node). It prints `PASS` / `FAIL` / `INFO` lines, writes them to `<out-dir>/<mode>.txt` (plus a `.json`), and saves screenshots there. Exit code 0: every check held; 1: a check failed; 2: it could not run (the message says why).

Before you start:

- **The plugin must be loaded, and on a vault Obsidian has not been told to trust it is not.** Obsidian opens such a vault with "Do you trust the author of this vault?" (buttons "Browse vault in Restricted Mode" and "Trust author and enable plugins") and loads no plugin until the second one is pressed. Meanwhile `community-plugins.json` and `app.plugins.enabledPlugins` list the plugin, `app.plugins.plugins` has no instance, no command registers and nothing is logged: this is what the third tester run met (T18, `evidence/PR-1/tester3/obs-state.png` shows the prompt). Disable/enable and `loadPlugin` from a script do not get past it. After starting Obsidian run `docker exec $C python3 $H/container-terminal-check.py trust-plugins --cdp http://127.0.0.1:$CDP --out-dir $H/out` (step 1b below): it presses that button through the Obsidian window's CDP target, falls back to `app.plugins.setEnable(true)` and `enablePluginAndSave`, and PASSes only when the plugin has an instance and registered commands and no prompt is showing. The choice is remembered in Obsidian's profile, so a restarted Obsidian (step 5) normally does not ask again; run it again if it does. It trusts only the vault the tester opened in the throwaway container.
- Start from one Obsidian with the vault open and the plugin loaded. Start Obsidian with `--remote-debugging-port=<a free port you pick>` and use that port below as `$CDP`.
- **Nothing in the plugin opens the panel-only page, by design.** This PR changes nothing the user sees, so the plugin has no command or ribbon item for it: "Toggle terminal drawer" opens the old drawer (`src/terminal/*`), and no `code serve-web` starts until a Code tab (or anything else that calls the plugin's `ensureServer()`) asks for it. That is why the third and fourth tester runs found no panel-only page and no server. The `open-page` mode (step 1c) builds both: it asks the plugin for its server, opens a Code tab, and docks a `<webview>` in a partition of its own along the bottom of the Obsidian window. Do not look for a plugin command; run step 1c.
- On a first run the server is downloaded, and Obsidian shows the "VS Code server licence" modal (buttons "Decline" and "Accept and download") the moment the first Code tab or `ensureServer()` asks for the server. Until it is answered nothing starts: no Code tab, no `serve-web`, and step 1c ends with "the plugin's server did not start" (the fifth tester run, T34). This is the plugin's licence step, which this PR does not change. Pass `--accept-licence` to step 1c and the helper presses "Accept and download" for you (a timer in the Obsidian window, only on the modal titled "VS Code server licence", never "Decline"; its output says how often it pressed); the acceptance is then kept in the plugin's data, so later runs need no flag. Without the flag the helper does nothing about the prompt: accept it by hand. The download takes time: give `--wait` enough seconds (it is also how long the plugin's server is given to start; the default is 180).
- Make sure no leftover serve-web uses that server data dir. Every extension host on the server watches the request file, and one with no live page takes it. The helper checks this and prints a FAIL, but stop the strays first: `docker exec desktop-warkworth-37 sh -c "ps -eo pid,ppid,args | grep -- --server-data-dir | grep -v grep"`, then stop only the PIDs you started, by PID.
- For GP2's "one shell started with the panel" use a fresh server: no terminal opened yet beyond the one the panel starts.
- Server pid and data dir come from the plugin's pidfile: `<vault>/.obsidian/plugins/vscode-workbench/.server/pids.json`. If the helper cannot tell which webview is the terminal page, it stops with the list; repeat with `--terminal-target <index or part of the url>`.

Commands (order matters; `C=desktop-warkworth-37`, `H=/config/w37/helper`, `V=<vault folder in the container>`, `PF=<pidfile above>`):

1. `docker exec $C mkdir -p $H` then `docker cp tests/render/container-terminal-check.py $C:$H/` and `docker cp tests/render/terminal-at-extension.cjs $C:$H/` (the helper finds the extension next to itself).
1b. Plugin loaded (T18): `docker exec $C python3 $H/container-terminal-check.py trust-plugins --cdp http://127.0.0.1:$CDP --out-dir $H/out`. PASS: `plugin obsidian-vscode-workbench is loaded (instance and commands present) and no trust prompt is showing`. Then run step 1c (it opens the terminal page and a Code tab) before step 2.
1c. The two pages and the server (T29): `docker exec $C python3 $H/container-terminal-check.py open-page --cdp http://127.0.0.1:$CDP --pidfile $PF --vault $V --out-dir $H/out --accept-licence` (add `--code-file <vault-relative file>` to name the Code tab's file; without it the helper makes `terminal-spike-code-tab.py` in the vault if it is not there, and opens it through the plugin's `openCodeFile` (the plugin's own "Open spike file in Code tab" command opens nothing in a vault that has no code file, which is why the sixth tester run saw no Code tab, T37); `--wait <seconds>` is how long to wait for a first-run download and for the server to start, default 180; raise it on a slow link).
   What it does, in order, all from the Obsidian window's own CDP target: (1) makes the Code tab's file if needed and opens a Code tab, a workbench `<webview>` in the default partition `persist:vscode-workbench`; (2) calls the loaded plugin's `ensureServer()`, so `code serve-web` is started the plugin's way and `pids.json` is written; (3) docks a `<webview>` along the bottom 45% of the window, in the partition `persist:vscode-workbench-terminal-spike` (never the Code tabs' one), loads the server's origin first and, once `dom-ready` fires, writes the two panel-only settings into that partition's own settings with the same merge as `buildBrowserSeedScript`, and the vault folder's Workspace Trust record (the same script as `buildTrustSeedScript`; without it the workbench asks "Do you trust the authors?" in a modal that swallows the key presses, T37), then loads the workbench on the vault folder (the order a Code tab uses); (4) waits until the Code tab's webviews stop changing, then finds the page in the CDP list by its partition (the one webview whose own settings carry `obsidianWorkbench.terminalPage`; a Code tab's partition does not, and a webview that is merely new is not taken for it, T44), waits until it paints, then makes the layout, only what is missing and in this order (T45, T50): a real mouse press inside the side bar and Ctrl+B, a real press inside the secondary side bar and Ctrl+Alt+B, then a real press on the editor (or, if that is not showing, another part that is not the terminal) and Ctrl+backtick, which opens the panel and starts the first shell. The presses go through CDP `Input.dispatchMouseEvent` (a DOM click does not focus the workbench and the keys are swallowed). Each press is inside the part its key acts on, and none is ever at the window centre or on the panel: once the panel is open the centre is the terminal, which takes the focus, and the shell gets Ctrl+B instead of the workbench. Each key is tried up to three times while the layout does not change, each time with a new press in the same part; before each try the page is asked for a modal dialog, a "Yes, I trust" question is answered (the vault is the throwaway one) and any other dialog is only reported with its text and buttons. If a key still does nothing, an INFO line says what the page showed (dialog, focused element, title, text); (5) measures the Code tabs' layout (the webviews in another partition than the page's) before the page was opened and again after its layout was made, and FAILs a Code tab whose side bar, panel or layout changed (T51); (6) reads the pidfile. The connection token is used only inside the Obsidian window: it is in no output of the helper, and CDP target URLs are printed with `tkn=(hidden)`.
   PASS looks like: `a Code tab is open`; `E3: the page is a <webview> in its own partition, not persist:vscode-workbench`; `the webview loaded the server's origin (dom-ready)`; `the panel-only settings (...) were written into that partition's own settings`; `the vault folder's Workspace Trust record was written into that partition`; `exactly one workbench webview target is the page`; `S1: ... every other part measures 0 px and the panel fills the window`; `the plugin's pidfile names the live vscode-server`. It also saves `shot-0-container-page-opened.png`. With `--accept-licence` it also prints `licence prompt: "Accept and download" was pressed N time(s)` (0, with "already accepted", when no prompt appeared); GP2's licence, download and first-start steps are noted as seen from that line and the screenshot, not built. Exit 2 with a plain message if the plugin is not loaded (run step 1b), the server does not start (usually the licence prompt: run again with `--accept-licence`), or no Obsidian window answers. Running it a second time in the same Obsidian window finds the docked page and starts nothing. The docked page stays until Obsidian is restarted; stopping the server stays the plugin's job (unload or quit).
2. GP2, S2, shot 3, S1 (T11/T15, T12/T16; needs step 1c's page and server, and a pidfile naming the live server):
   `docker exec $C python3 $H/container-terminal-check.py terminal-at --cdp http://127.0.0.1:$CDP --pidfile $PF --vault $V --out-dir $H/out`
   PASS looks like: no leftover serve-web; extension installed; the panel-only webview's settings seeded; the page painted again; every other part 0 px; one shell in the vault root by `readlink`; the terminal list on the right with two terminals; the spaces and non-ASCII folders each opened a terminal whose `readlink` and `pwd` are that folder; the missing folder opened none; the Code tab's layout the same before and after.
   What the reload does (T49): after the extension is installed and the setting is seeded, the helper reloads the page the way a webview is reloaded, not through the page's own CDP target (a CDP `Page.reload` on that target closed it in the container, tester run 8). It connects to the Obsidian window's own target, finds the one `<webview>` element whose `partition` attribute is `persist:vscode-workbench-terminal-spike` (the page open-page docked) and calls `webview.reload()` on it. If the window has no such element, or two, or the call raises, the output says so (`the page was not reloaded: ...`), the repaint line FAILs and nothing else is run on the page. Then it waits for the page to paint and finds it again by its partition (the settings it carries), as below. Whether `webview.reload()` keeps the page's CDP target is not known until the tester runs it; the INFO lines say which target survived. Whatever happens, the Code tab's layout is measured before and after, so the T51 line is in the output even when the reload fails.
   If the page does not paint after the reload (T38), the output says which CDP target was reloaded, what the page showed (address with the token hidden, title, readyState, each part's size, the first words of its text), which targets the endpoint lists then, whether the reloaded target is still listed, and what happened on the two ways out the helper tries: a target in the page's partition (found by the seeded settings, never just a new target, T46) is connected to, and, when the reloaded target is still listed, the page is navigated once to its own address. If the reload closed the webview and no target is in that partition, the output says so and the run stops there; it does not go on with a Code tab's webview.
   What the helper adds for T55: before the reload it marks the document on screen, and reads the Obsidian window's own view of the page's `<webview>` element (how many elements carry the partition, their address with the token hidden, loading, crashed, still in the document). A document that still carries the mark after the reload is the old one, and the output says the reload did not happen (or was held back by a 'leave the page?' prompt). When the page does not come back the window is asked again, so the output separates a closed target (the element is still there) from a closed element (`the element is gone from the window`). A target that is still listed under the same id is connected to afresh, because the old connection dies with the old document; a target listed under another id is found by its partition as before. When nothing comes back through a CDP target and the element is still in the window, the window loads the page's address into it again (`webview.loadURL`); if the page paints then, the run goes on, so GP2, S2 and shot 3 are measured, but the repaint line stays a FAIL, because the reload alone did not bring the page back.
   The Code-tab guard of `open-page` (T56): every workbench webview that is not a page of an earlier run is a Code tab (one whose partition cannot be read after three tries is counted too, with a line saying so), its layout is read before the page is opened and again after, and the S1 Code-tab line is always in the output: with no Code tab found, or one that cannot be connected to, it is a FAIL by name. Only `--no-code-tab` skips it.
3. E7 / shot 4, before (T13/T17; needs step 1c's page and server): `docker exec $C python3 $H/container-terminal-check.py force-quit prepare --cdp http://127.0.0.1:$CDP --pidfile $PF --vault $V --out-dir $H/out`
   It opens two terminals (an `http.server` and a `nohup ... & disown` process), checks both are in the server's tree, prints `ps -ef --forest` of that tree, and types a `ps` into the page's terminal for `shot-4a-container-ps-before-force-quit.png`.
4. `docker exec $C pgrep -f -i obsidian` for the main Obsidian pid, then `docker exec $C python3 $H/container-terminal-check.py force-quit kill --out-dir $H/out --obsidian-pid <main pid>`
   It refuses a pid whose command line is not Obsidian. It SIGKILLs only that pid, prints the tree before and after, and PASSes when the server, the shells, the `http.server` (still answering) and the `nohup` process all survived the force-quit.
5. Start Obsidian again (the plugin's startup runs the sweep; the docked page is gone after a restart, which is expected), then `docker exec $C python3 $H/container-terminal-check.py force-quit after --out-dir $H/out`
   PASS: the server is gone, no interactive shell of it is left, the `http.server` no longer answers. The `nohup` process is only reported (INFO), not judged: whether the sweep should kill it is Dan's decision (R2).
6. Attach `$H/out` (`open-page.txt`, `terminal-at.txt`, `force-quit-prepare.txt`, `force-quit-kill.txt`, `force-quit-after.txt` and the `shot-*.png`) with `docker cp $C:$H/out <evidence folder>`.

The helper changes nothing in the plugin. It writes only into the server data dir's `extensions` folder (the extension and its registry entry; other entries are kept) and `$H/out`, and the force-quit `after` run stops by PID the `http.server` and `nohup` process it started, if the sweep left them.
