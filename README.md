# Obsidian VS Code Workbench

Obsidian desktop plugin that opens every text file in a real VS Code editor (via `code serve-web`) with a VS Code-style bottom terminal drawer.

Status: in development (a spike with one ribbon icon and one Code tab, the server lifecycle, the settings tab, and the Code tab opening every text file in the vault; see `docs/spike-decision.md`). Not submitted to the community store.

## Network use

On first use the plugin downloads the VS Code server from Microsoft, after you accept its licence terms. The first Code tab you open shows the licence modal; nothing is downloaded or started until you accept, and declining (or pressing Escape) opens the file in your system's app and asks again next time. The server runs only while you use it: it stops when Obsidian quits (with unsaved Code buffers it first asks you to save them all or discard them, and asks again if something is still unsaved, such as a new file without a name), or after 5 minutes with no visible Code tab and no unsaved buffer, and a server left over from a crash is cleaned up at the next start (a pidfile in the plugin's `.server` folder lists only process ids, never the token). When a start fails, a notice names the reason and any Code tab that was still showing the stopped server's page is closed rather than left blank (a tab with the crash banner stays, so its Restart can try again). If the download fails, the plugin looks up `update.code.visualstudio.com` and opens a TCP connection to its port 443 (no request is sent) to tell an unreachable network from another failure, because `serve-web` itself does not say why. The server is pinned to the installed VS Code build's commit (`--commit-id`), so later starts do not ask Microsoft for a newer one. Apart from that download, the plugin talks to `127.0.0.1`: the local `serve-web` server, bound to loopback with a connection token passed through a mode-0600 token file (never on the command line). The plugin adds no telemetry or analytics, and VS Code telemetry, extension auto-update and update checks, and experiments are switched off. Two kinds of request to Microsoft remain that cannot be switched off: on each load the workbench fetches two small static configuration files from `main.vscode-cdn.net` and sends one marketplace query for the single extension id `github.copilot-chat` (it does not send your installed extensions) (`docs/spike-decision.md`, "Outbound connections").

The first time a Code tab opens, VS Code asks whether to trust the folder; until you do, the Python extensions stay inactive (Restricted Mode).

The ribbon icon opens the active file if Obsidian can open it itself (not Markdown, canvas or base); otherwise it opens the file named by `spikeFile` in the plugin's `data.json` (a vault-relative path, hand-edited), then the built-in spike file. Obsidian has no view for `.py`, so a code file is never the active file.

## Which files open

Nothing is registered by hand. When the plugin starts, and again whenever a file is created or renamed (and when the window regains focus, at most every 30 seconds, for files made outside Obsidian), it walks the vault folder on disk and registers every file extension it finds against the Code tab, in small slices so the window stays responsive. It walks the disk rather than asking Obsidian's file index because, with "Detect all file extensions" off, Obsidian does not list a `.py` or `.zig` file until its extension is registered. The registered set is written to the developer console (`VS Code Workbench: registered extensions (...)`).

- **Hidden:** the contents of `.obsidian`, `.git` and `node_modules` are never scanned or opened.
- **Open as text:** code files, dotfiles, and `svg`, `csv`, `txt` and `json`.
- **Never in a Code tab:** Markdown, canvas and base files, and binaries (images, pdf, archives, audio, video, fonts, executables and the like). Obsidian's own views handle them, and their extensions are never passed to the registration call.
- **Your exclude list** (settings) is never registered.
- **A symlink loop, a broken link or an unreadable folder** is skipped with a console warning; the scan carries on. Links to folders are followed once.
- **Size and binary guard:** a file over 2 MB (2,097,152 bytes opens, one byte more is refused), or with a null byte in its first 8 KB, is refused with a notice and opened in your system's app. A file over the limit is never read; otherwise only the first 8 KB is.
- **Other editors:** if Code Files, VSCode Editor, Code Workbench or any other plugin already owns an extension, this plugin leaves that extension alone and shows a notice naming the owner (one notice per extension per session, listing the extensions that one owner keeps). It only reads the view registry and never changes another plugin's registration or settings. An extension Obsidian itself opens (`svg` is shown by its image viewer) is left alone without a notice. To use Code tabs for a refused extension, turn the other plugin off and reload.
- **One tab per file:** opening a file that already has a Code tab (from the explorer, quick switcher, a link, a split or another pane, even twice in quick succession) focuses that tab instead of adding one.

### Extensionless files and dotfiles

Obsidian opens files by extension, so `Makefile`, `Dockerfile`, `.env` and `.gitignore` have nothing to register. As a best effort, a click on such a file's row in the file explorer is taken over and opens in a Code tab. If a Code tab cannot open, or the plugin is set to the fallback mode (`"extensionlessMode": "system-app"` in `data.json`), the file opens in your system's app with a notice, never as a blank tab. The limit: this only sees rows Obsidian draws. Obsidian never lists dotfiles, and with "Detect all file extensions" off it does not list extensionless files either, so for those there is no row to click and nothing to intercept (turn "Detect all file extensions" on to see extensionless files).

## Settings

Open Settings, Community plugins, Workbench. Every time the tab opens it rescans, shows "Scanning…", then the list.

- **VS Code instance.** The scan reads `/Applications` and `~/Applications` for VS Code, VS Code Insiders, VSCodium, Antigravity and Antigravity IDE. A build is classified by its bundle identifier (`Info.plist`, else `product.json`), never by its folder name, and is listed only if its command-line tool passes `serve-web --help` (exit 0, output mentions `serve-web`, 5 seconds; run directly, never through a shell). The check starts no server, opens no port and downloads nothing. The default is the newest VS Code build (stable or Insiders, by version number); a build you pick is kept, and if it later disappears or fails its check the tab says why and uses the default until you pick again (the saved choice is not rewritten). Changing the instance while a server runs does not stop it, so unsaved buffers are safe: the change applies the next time the server starts.
- **Custom CLI path.** An absolute path to a VS Code command-line tool. Verify runs the same check; a path that passes is listed as Custom.
- **Excluded file extensions, terminal drawer toggle, shell.** The exclude list is read by the extension scan (see "Which files open"); the toggle and the shell are stored here for the terminal drawer. Extensions are entered without a dot; they are trimmed, lowercased and de-duplicated. An extension added to the list is not registered at the next scan; one that is already registered stays registered until Obsidian reloads. The shell defaults to `$SHELL`, else `/bin/zsh`.
- **Restart server.** Stops the server and starts a fresh one.

A hand-edited `codeCliPath` in `data.json` still overrides the instance chosen in the tab. A corrupt or partial `data.json` falls back to the defaults field by field.

### Your VS Code settings

At each server start the plugin copies the chosen instance's `User/settings.json` and `User/keybindings.json` (from its folder under `~/Library/Application Support`, for example `Code - Insiders`) one way into the plugin's own user-data folder, replacing the previous copy, and writes the workspace excludes on top: `.git`, `.obsidian`, `Attachments`, `node_modules` and `_to_delete` are excluded from `files.watcherExclude` and `search.exclude`, and win over the copied values. Comments and trailing commas in your `settings.json` are accepted; if it is invalid JSON, only the excludes are written and a notice says so. The VS Code server does not read those two files from its data folder, so the same copy is also written into the Code tab's own browser profile when the tab opens (once per server start; the excludes also go into the server's Machine settings, which it does read). Checked on a real server: a copied `editor.fontSize`, a copied keybinding and the excludes all take effect (`npm run check:user-data`). Edits made inside the embedded editor change the copy only and are replaced at the next start. The plugin never writes to, renames, deletes or changes the permissions of another instance's settings, extensions or app bundle, and it creates nothing in your vault outside its own plugin folder. The copy is private to you (mode 0600 in a 0700 folder) because settings can contain secrets.

### Microsoft-only extensions

Some extensions (for example Pylance, C/C++ and the Remote extensions) are licensed for Microsoft's own builds and may refuse to run in VSCodium or the Antigravity builds. The settings tab shows a one-line warning when the selected instance is not a Microsoft build. Nothing is done to work around the licence: choose VS Code or VS Code Insiders to use those extensions.

## Requirements

Desktop Obsidian 1.13.0 or newer, a local vault, and an installed VS Code (`code` with the `serve-web` command).

## Develop

```
npm install
npm run build      # type-check, then bundle to main.js
npm test           # vitest with a coverage report
```

The plugin folder goes in `<vault>/.obsidian/plugins/obsidian-vscode-workbench/` (`main.js` and `manifest.json`). Runtime files (token, server data) live under `.server/` inside it and are git-ignored.
