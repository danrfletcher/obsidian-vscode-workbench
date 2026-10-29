# Extension spike (ticket warkworth-36, PR-1)

Four questions that every later PR in this ticket depends on, measured on a real `code serve-web` server in a
real headless Chrome. Measured on 2026-10-27 with the `code` at `/Applications/Visual Studio Code.app` (it reports
`1.145.0-insider`). The same server code path as the plugin is used: `shareExtensions` links Dan's real
`~/.vscode-insiders/extensions` into the server's data dir, `writeMachineSettings` writes the Machine file, and the
settings route uses the plugin's own `buildBrowserSeedScript`.

Everything below comes from one script, which can be run again:

    npm run build
    CLI_DATA_SRC=<a --cli-data-dir that holds the server for the installed build> npm run check:extensions-spike [outDir]
    # or ALLOW_DOWNLOAD=1 to let serve-web fetch that server into the scratch folder

It writes `extension-spike-result.json` and numbered screenshots into `outDir`. It is not part of `npm test`. It
uses a free port it picks itself for every server and Chrome, and stops what it started by PID.

The script asserts the fixture (GP1) from the instance's own files before it starts, and exits with a plain
message if either is false: `~/.vscode-insiders/extensions/extensions.json` lists
`chakrounanas.turbo-console-log` (3.29.0) and it is not in the instance's disabled list, and
`User/globalStorage/storage.json` of `Code - Insiders` has `profileAssociations.workspaces` for
`file:///Users/danfletcher/Documents/Notes` set to `__default__profile__`. Without `sqlite3` or without the
instance folder it exits with a plain message too.

The desktop instance is read only (F1). Before and after, the script checksums and lists `extensions.json`,
`User/settings.json`, `User/keybindings.json` and everything under `User/globalStorage` (77 entries), and the
two listings were identical. The one `state.vscdb` it reads (for the disabled-extensions list) is read from a temp
copy with `sqlite3 -readonly`.

## Stable port

**Result.** Yes. The server was started on a free port, Restricted Mode was ended by hand, and the server was
stopped. It was started again on the same port with a new connection token and opened in the same Chrome profile:
the origin was the same (`http://127.0.0.1:<port>`), Restricted Mode was not shown, and the trust record was
byte-for-byte unchanged. A third start on another port gave another origin and Restricted Mode came back. The
connection token is not part of the origin, so a new token on each start does no harm.

**Measured by.** `npm run check:extensions-spike`, section "Q1" (log lines `restart on the same port` and
`start on another port`; screenshots `05-after-restart-same-port.png`, `06-other-port.png`).

**Decision.** Keep one port per vault in `data.json` (`stablePort`, read through `readSettings`, 1024 to 65535
only) and try it first at every start (`pickPort` in `src/server.ts`). When something holds it, use a free port for
that start, keep the stored value, and say so in settings. A stored port is never allowed to stop a start.
Because the trust record names the port (next section), a start on a fallback port shows Restricted Mode again.

## Trust record

**Result.** Found by diffing every IndexedDB store of the origin before and after the Trust click:

    database      vscode-web-state-db-global-shared
    object store  ItemTable
    key           content.trust.model.key
    value         a JSON string

Sample, with the machine-specific parts redacted:

    {"uriTrustInfo":[{"uri":{"$mid":1,"path":"<vault folder>","scheme":"vscode-remote","authority":"127.0.0.1:<port>"},"trusted":true}]}

The record is stored per browser origin (IndexedDB), so it lives in the Code tab's browser profile
(`persist:vscode-workbench`), not on disk next to the server. The folder URI has scheme `vscode-remote` and the
server's `host:port` as its authority, so a record only matches a server on the same port. The desktop instance's
own `state.vscdb` has no `content.trust.model.key` row, so the desktop trust state is not the same store and is
not read for this. A separate key, `extensions.trustedPublishers` in `vscode-web-state-db-global`, holds publisher
trust and is not Workspace Trust.

**Measured by.** `npm run check:extensions-spike`, section "Q2" (line `trust record:`; screenshot
`03-after-trust.png`). If a future VS Code writes no key with `trust` in its name, the script records the record as
not found and the settings section shows "not found".

**Decision.** PR-2 may seed this key, in this format, for the vault folder on the stable port. It must write it
only through the browser profile (like `buildBrowserSeedScript`), and only with Dan's trust of that folder.

## Settings and keybindings route

**Result.** One route works. A scratch "mirrored profile" (a folder under the script's scratch dir, never the
real profile) had `settings.json` with `editor.fontSize: 23` and `keybindings.json` with
`ctrl+alt+9 -> workbench.action.toggleSidebarVisibility`. Each candidate route got its own server and Chrome
profile, and the effect was read from the page:

| Route | editor.fontSize (default 12px) | Ctrl+Alt+9 (side bar width) |
| --- | --- | --- |
| IndexedDB write of `buildBrowserSeedScript` (`WORKBENCH_SETTINGS_KEY` `/User/settings.json`, `/User/keybindings.json`) | 23px, arrived | 296px to 0px, arrived |
| Server User folder (`<server-data-dir>/data/User/settings.json`, `keybindings.json`) | 12px, did not arrive | 296px to 296px, did not arrive |
| Server Machine file (`<server-data-dir>/data/Machine/settings.json`) | 12px, did not arrive | no machine keybindings file |

**Measured by.** `npm run check:extensions-spike`, section "Q3" (lines `route indexeddb`, `route server-user`,
`route machine`). The font size is the computed style of a rendered editor line; the keybinding is a real key
event followed by the side bar's width.

**Decision.** PR-6 builds on the existing IndexedDB write (`buildBrowserSeedScript` with a copy of the mirrored
profile's settings and keybindings). It is not a STOP. If a later run finds that no route works, the script's
decision line says `STOP`, the settings section shows the stop text, and the profile settings work is not built
until Dan is asked.

## Turbo Console Log

**Result.** On a real server that shares the real Insiders extensions folder, Turbo Console Log is in the
workbench's installed list (`@installed`), its commands are in the command palette (for example "Turbo Console
Log: Insert console log message"), and it is active after the folder is trusted:

    ExtensionService#_doActivateExtension ChakrounAnas.turbo-console-log, startup: false, activationEvent: 'onStartupFinished'

Candidate causes, tested in turn:

- Restricted Mode: this is the cause. Before the Trust click the banner was shown and the extension host log had
  no activation line for it; after the click the extension host restarted and logged the line above.
- Not enabled: ruled out. Not in the instance's disabled list (read from a temp copy of `state.vscdb`), and shown
  in the installed list.
- Not activated in the web extension host: ruled out after trust (the activation line above; no error or warning
  line mentions it). `serve-web` runs extensions in a Node extension host, not the browser one.
- Missing contribution: ruled out. Its commands are in the command palette.

The extension never failed after trust in this fixture, so there is no separate finding. Nothing was edited,
installed or enabled, and no Microsoft-only extension was worked around.

**Measured by.** `npm run check:extensions-spike`, section "Q4" (the `Q4 candidates:` block and the
`Turbo Console Log:` line; screenshots `02-restricted-mode-before-trust.png`, `03-after-trust.png`,
`04-installed-extensions.png`).

**Decision.** Trust is the fix. Once PR-2 seeds the trust record on the stable port, the extension starts without
a click. If it does not activate after trust on Dan's machine, run the script again and read its Q4 block: the
cause comes from the extension host log, not from a guess.

## What the script does not do

It does not seed trust, add a toggle, look up profiles, read disabled lists for any use but the fixture assertion,
rebuild symlinks, mirror settings, or list the full state: those are PR-2 to PR-7. It starts no file watcher and
reads the instance's state once, on demand.
