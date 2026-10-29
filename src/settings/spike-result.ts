import type { SpikeResult } from "./extensions-section";

/**
 * What the extension spike recorded (docs/spike-extensions.md), measured with `npm run check:extensions-spike`
 * on a real `code serve-web` server. Edit it only by re-running the spike and copying the new answers here and
 * into the doc; the Extensions section in settings draws it as it is.
 */
export const SPIKE_RESULT: SpikeResult | null = {
  measuredOn: "2026-10-27",
  vscodeVersion: "1.145.0-insider",
  stablePort: {
    stable: true,
    result:
      "Two starts of the server on one port gave the same origin; after the restart Restricted Mode was not shown and the trust record was unchanged. A start on another port gave a different origin and Restricted Mode came back.",
    decision: "Store one port per vault and try it first; fall back to a free port when it is held.",
  },
  trustRecord: {
    found: true,
    location: "vscode-web-state-db-global-shared / ItemTable / content.trust.model.key",
    result:
      "The Trust click writes this key in the browser's IndexedDB for the server's origin. Its value lists the trusted folders, and each folder's authority is the server's host:port, so a record only matches on the same port.",
    decision: "Seed the record by writing this key, in this format, for the vault folder on the stable port (PR-2).",
  },
  settingsRoute: {
    arrives: true,
    route: "the IndexedDB write of buildBrowserSeedScript (/User/settings.json and /User/keybindings.json)",
    result:
      "Through that write, editor.fontSize 23 arrived (12px to 23px) and a Ctrl+Alt+9 keybinding arrived (the side bar went from 296px to 0px). Placed in the server's User folder or in the Machine settings file, neither arrived.",
    decision: "PR-6 builds on the IndexedDB write of buildBrowserSeedScript.",
  },
  turboConsoleLog: {
    state: "active",
    cause: "Restricted Mode kept it from activating until the folder was trusted",
    result:
      "It is in the workbench's installed list and its commands are in the command palette. The extension host did not activate it before trust and logged its activation after the Trust click. Not enabled, not activated and missing contribution were each ruled out.",
    decision: "Trust is the fix; there is no separate failure to chase.",
  },
};
