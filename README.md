# Obsidian VS Code Workbench

Obsidian desktop plugin that opens every text file in a real VS Code editor (via `code serve-web`) with a VS Code-style bottom terminal drawer.

Status: in development (PR-1 is the spike: one ribbon icon, one Code tab, see `docs/spike-decision.md`). Not submitted to the community store.

## Network use

On first use the plugin downloads the VS Code server from Microsoft, after you accept its licence terms. (In the spike the licence flag is a hard-coded dev constant; the licence modal arrives in PR-2.) The server is pinned to the installed VS Code build's commit (`--commit-id`), so later starts do not ask Microsoft for a newer one. Apart from that download, the plugin talks to `127.0.0.1`: the local `serve-web` server, bound to loopback with a connection token passed through a mode-0600 token file (never on the command line). The plugin adds no telemetry or analytics, and VS Code telemetry, extension auto-update and update checks, and experiments are switched off. Two kinds of request to Microsoft remain that cannot be switched off: on each load the workbench fetches two small static configuration files from `main.vscode-cdn.net` and sends one marketplace query for the single extension id `github.copilot-chat` (it does not send your installed extensions) (`docs/spike-decision.md`, "Outbound connections").

The first time a Code tab opens, VS Code asks whether to trust the folder; until you do, the Python extensions stay inactive (Restricted Mode).

The ribbon icon opens the active file if Obsidian can open it itself (not Markdown, canvas or base); otherwise it opens the file named by `spikeFile` in the plugin's `data.json` (a vault-relative path, hand-edited), then the built-in spike file. Obsidian has no view for `.py`, so a code file is never the active file.

## Requirements

Desktop Obsidian 1.13.0 or newer, a local vault, and an installed VS Code (`code` with the `serve-web` command).

## Develop

```
npm install
npm run build      # type-check, then bundle to main.js
npm test           # vitest with a coverage report
```

The plugin folder goes in `<vault>/.obsidian/plugins/obsidian-vscode-workbench/` (`main.js` and `manifest.json`). Runtime files (token, server data) live under `.server/` inside it and are git-ignored.
