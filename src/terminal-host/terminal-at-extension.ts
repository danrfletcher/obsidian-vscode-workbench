/**
 * "New terminal at folder", the plumbing (G8, S2). The PR-1 spike chose the small plugin-owned extension, not a keybinding
 * (docs/terminal-spike.md, `cwd_open: extension`): a keybinding with `args` is fixed when it is written and only applies
 * after a reload, so a folder chosen at the moment of the click needs something inside the page to receive it.
 *
 * The extension is plumbing only and draws nothing (F1). It lives in the server's own extension dir, so nothing of desktop
 * VS Code's is written (F6). The plugin asks it for a terminal by writing one small request file into the extension's
 * `requests` folder (data, never typed text); the extension runs VS Code's own `workbench.action.terminal.newWithCwd` with the
 * folder as its `cwd` argument. No shell is told anything.
 *
 * Differences from the spike's version 2 (tests/render/terminal-at-extension.cjs), which kept one `request.json`: two choices
 * in quick succession (E10) would overwrite each other before the extension read the first. Here each choice is a file of its own,
 * named so that they sort in the order they were made. What the spike found about several extension hosts watching the same
 * folder is kept (the live host is not starved by a host whose page is gone):
 *  - a host acts only when its own browser profile carries `obsidianWorkbench.terminalPage` (the terminal page's does),
 *  - a host deletes a request only after VS Code's command has answered, so a host whose page is gone leaves it for the live one,
 *  - a host runs each request id once.
 *
 * Panel-only (F2, S1): the extension also puts the page in its panel-only layout itself, once per page load and before it takes any
 * request (and again for a request with `panel: true`, made when the panel was closed with the X in the page), with VS Code's own
 * commands: close the side bar, close the secondary side bar, focus the terminal (which opens the
 * panel and starts the page's first shell when there is none). They are commands, not key presses: they need no focus and no
 * key binding, and running them again changes nothing. A command VS Code does not know yet (the workbench is still starting) is
 * asked again after a short wait. The host page only waits for the layout to be panel-only.
 *
 * First use (G2): when the plugin starts the terminal page for the click, VS Code opens a first terminal of its own in the
 * vault root as the panel comes up. A request marked `adoptFirst` then takes that terminal's place: the folder's terminal is
 * made first (the panel is never empty), then the page's own one is closed, so the page ends with exactly one terminal, in the
 * chosen folder. That closes a shell nobody asked for and it is done only when all of this holds, so a terminal the user
 * made or a shell that outlived a page reload is never closed:
 *  - the request says so (the click started the page; a later click, or one made while the page was starting, never does),
 *  - this is the first terminal page this server run has seen (a `page-seen` file, removed at each server start: a page
 *    reloaded or mounted again could be showing shells that were running before),
 *  - it is the first request this page has taken, and exactly one terminal exists once the page's own first one is there.
 *    VS Code lists that terminal in the extension host a moment after the panel makes it, so the request can be read before
 *    it is listed: the extension then waits for it (up to FIRST_TERMINAL_WAIT_MS) before it decides, instead of looking once.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { TERMINAL_PAGE_SETTING } from "./host-url";

/** The PR-1 spike's answer for how a terminal is opened at a chosen folder; a test keeps it equal to the `cwd_open` header of docs/terminal-spike.md. */
export const CWD_OPEN_OPTION = "extension";

export const EXTENSION_PUBLISHER = "obsidian-vscode-workbench";
export const EXTENSION_NAME = "terminal-at";
export const EXTENSION_VERSION = "1.0.0";
export const EXTENSION_ID = `${EXTENSION_PUBLISHER}.${EXTENSION_NAME}`;
export const EXTENSION_DIR_NAME = `${EXTENSION_ID}-${EXTENSION_VERSION}`;
/** The folder (inside the extension's) the requests go to. */
export const REQUESTS_DIR = "requests";
/** The file (in the extension's own folder) that says a terminal page has already been through this server run. */
export const PAGE_SEEN_FILE = "page-seen";

/** VS Code's own commands the extension runs. */
export const NEW_WITH_CWD_COMMAND = "workbench.action.terminal.newWithCwd";
export const NEW_TERMINAL_COMMAND = "workbench.action.terminal.new";
/** The commands that make the page panel-only, in the order they are run. Each is idempotent; none is a toggle. */
export const CLOSE_SIDE_BAR_COMMAND = "workbench.action.closeSidebar";
export const CLOSE_AUXILIARY_BAR_COMMAND = "workbench.action.closeAuxiliaryBar";
export const FOCUS_TERMINAL_COMMAND = "workbench.action.terminal.focus";
export const PANEL_ONLY_COMMANDS = [CLOSE_SIDE_BAR_COMMAND, CLOSE_AUXILIARY_BAR_COMMAND, FOCUS_TERMINAL_COMMAND] as const;

/**
 * How long the extension waits for the page's own first terminal to appear in the extension host before it goes on without
 * it. VS Code lists a terminal in the extension host a moment after the panel has made it, so the request can be read first (T1).
 */
export const FIRST_TERMINAL_WAIT_MS = 5000;

/** The extension's code, as VS Code's extension host runs it (CommonJS, `vscode` provided by the host). */
export function extensionSource(firstTerminalWaitMs: number): string {
  return `const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

exports.activate = (ctx) => {
  const dir = path.join(ctx.extensionPath, ${JSON.stringify(REQUESTS_DIR)});
  const seen = path.join(ctx.extensionPath, ${JSON.stringify(PAGE_SEEN_FILE)});
  const done = new Set();
  let firstPage;
  const isTerminalPage = () => vscode.workspace.getConfiguration("obsidianWorkbench").get("terminalPage");
  // One panel-only command, asked once. If VS Code refuses it, the user sees an error message, and the commands after it still run.
  const runCommand = async (command) => {
    try { await vscode.commands.executeCommand(command); } catch (e) { vscode.window.showErrorMessage("VS Code Workbench: " + command + " failed: " + (e && e.message ? e.message : e)); }
  };
  // Once per page load, before any request. A page that is not the terminal page (a Code tab) is left alone.
  const panelOnly = async () => {
    if (!isTerminalPage()) return;
    for (const command of ${JSON.stringify(PANEL_ONLY_COMMANDS)}) await runCommand(command);
  };
  const live = () => vscode.window.terminals.filter((t) => t.exitStatus === undefined);
  // The page's own first terminal can be made by VS Code a moment after the request is read, so it is waited for, not looked for once.
  const pageTerminals = () => new Promise((resolve) => {
    if (live().length > 0) return resolve(live());
    let sub;
    const timer = setTimeout(() => { sub.dispose(); resolve([]); }, ${firstTerminalWaitMs});
    sub = vscode.window.onDidOpenTerminal((t) => { clearTimeout(timer); sub.dispose(); const l = live(); resolve(l.length > 0 ? l : [t]); });
  });
  const pass = async () => {
    if (!isTerminalPage()) return;
    if (firstPage === undefined) {
      firstPage = !fs.existsSync(seen);
      try { fs.writeFileSync(seen, ""); } catch { /* not marked: the next page counts as the first too, which only ever closes less */ }
    }
    let names;
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort(); } catch { return; }
    for (const name of names) {
      const file = path.join(dir, name);
      let req;
      try { req = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
      if (!req || typeof req.id !== "string" || done.has(req.id)) continue;
      done.add(req.id);
      // A panel request: the plugin found the panel closed (the X in the page's panel) and wants it back. No terminal is asked for;
      // the focus command opens the panel and starts a shell only when there is none.
      if (req.panel === true) {
        await panelOnly();
        try { fs.unlinkSync(file); } catch { /* already gone */ }
        continue;
      }
      const adopt = req.adoptFirst === true && firstPage;
      firstPage = false;
      const own = adopt ? await pageTerminals() : [];
      if (typeof req.cwd === "string") await vscode.commands.executeCommand(${JSON.stringify(NEW_WITH_CWD_COMMAND)}, { cwd: req.cwd });
      else await vscode.commands.executeCommand(${JSON.stringify(NEW_TERMINAL_COMMAND)});
      if (own.length === 1) own[0].dispose();
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    }
  };
  let chain = Promise.resolve().then(panelOnly).catch(() => undefined);
  const drain = () => { chain = chain.then(pass, pass); };
  fs.mkdirSync(dir, { recursive: true });
  fs.watch(dir, () => drain());
  drain();
};
`;
}

/** The extension's code with the usual wait for the page's first terminal. */
export const EXTENSION_JS = extensionSource(FIRST_TERMINAL_WAIT_MS);

/**
 * The extension's manifest. It contributes one setting, which the terminal page's own profile sets to true.
 *
 * `capabilities.untrustedWorkspaces.supported: true` is required: VS Code does not activate an extension that has a `main`
 * entry and no such declaration while Workspace Trust is on and the folder is not trusted (Restricted Mode). Everything the
 * page's panel-only layout and "New terminal at folder" do runs in this extension, and terminals are allowed in Restricted
 * Mode, so without it a page whose trust record was not seeded (the vault-trust setting is off, or the seed could not be
 * built) would never become panel-only and would not open a terminal at a chosen folder. The extension only runs VS Code's own
 * layout and terminal commands.
 */
export function extensionManifest(): Record<string, unknown> {
  return {
    name: EXTENSION_NAME,
    publisher: EXTENSION_PUBLISHER,
    version: EXTENSION_VERSION,
    engines: { vscode: "^1.80.0" },
    main: "./extension.js",
    activationEvents: ["onStartupFinished"],
    extensionKind: ["workspace"],
    capabilities: { untrustedWorkspaces: { supported: true } },
    contributes: {
      configuration: {
        properties: {
          [TERMINAL_PAGE_SETTING]: {
            type: "boolean",
            default: false,
            description: "The terminal page: the only page whose extension host opens terminals on the plugin's request.",
          },
        },
      },
    },
  };
}

/** `<server data dir>/extensions/<extension folder>`. */
export function extensionDir(serverDataDir: string): string {
  return path.join(serverDataDir, "extensions", EXTENSION_DIR_NAME);
}

/**
 * Put the extension in the server's own extension dir and list it in that dir's `extensions.json`, keeping the other entries
 * (the shared ones `shareExtensions` has just written). Every start does this: the files are rewritten, an older version of
 * this extension is removed, and requests left from an earlier run are cleared so a terminal is never opened from a stale one;
 * so is the `page-seen` mark.
 * Writes only under `serverDataDir`.
 */
export function installTerminalAtExtension(serverDataDir: string): void {
  const root = path.join(serverDataDir, "extensions");
  const dir = extensionDir(serverDataDir);
  fs.mkdirSync(root, { recursive: true });
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith(`${EXTENSION_ID}-`) && name !== EXTENSION_DIR_NAME) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
  fs.rmSync(path.join(dir, REQUESTS_DIR), { recursive: true, force: true });
  fs.rmSync(path.join(dir, PAGE_SEEN_FILE), { force: true }); // a new server run has no page yet, and no shells from an earlier one
  fs.mkdirSync(path.join(dir, REQUESTS_DIR), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(extensionManifest()));
  fs.writeFileSync(path.join(dir, "extension.js"), EXTENSION_JS);

  const listFile = path.join(root, "extensions.json");
  let entries: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(listFile, "utf8"));
    if (Array.isArray(parsed)) entries = parsed;
  } catch {
    /* no list, or one that is not JSON: start from an empty one */
  }
  entries = entries.filter((e) => (e as { identifier?: { id?: unknown } } | null)?.identifier?.id !== EXTENSION_ID);
  entries.push({
    identifier: { id: EXTENSION_ID },
    version: EXTENSION_VERSION,
    location: { $mid: 1, path: dir, scheme: "file" },
    relativeLocation: EXTENSION_DIR_NAME,
    metadata: { installedTimestamp: 1, pinned: true, source: "resource" },
  });
  fs.writeFileSync(listFile, JSON.stringify(entries));
}

export interface TerminalRequest {
  /** The folder as a path: passed to VS Code as the `cwd` argument. Absent: VS Code's own default start folder. */
  cwd: string | null;
  /** The request is not for a terminal: it puts the page back in its panel-only layout (see `requestPanel`). `cwd` is then null. */
  panel?: boolean;
  /** The click that made this request also started the terminal page: take the place of the page's own first terminal (see the top of this file). */
  adoptFirst?: boolean;
}

let sequence = 0;

/**
 * Ask the extension for one terminal. The file is written whole under a name the extension ignores and then renamed into place,
 * so the extension never reads half of it; its name sorts after every earlier request.
 * Returns the request id.
 */
export function writeTerminalRequest(serverDataDir: string, request: TerminalRequest, now: () => number = Date.now): string {
  const requests = path.join(extensionDir(serverDataDir), REQUESTS_DIR);
  fs.mkdirSync(requests, { recursive: true });
  const id = randomBytes(8).toString("hex");
  const name = `${String(now()).padStart(15, "0")}-${String(sequence++).padStart(6, "0")}-${id}`;
  const body: { id: string; cwd?: string; adoptFirst?: true; panel?: true } = { id };
  if (request.panel === true) body.panel = true;
  if (request.cwd !== null) body.cwd = request.cwd;
  if (request.adoptFirst === true) body.adoptFirst = true;
  const temp = path.join(requests, `.${name}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(body));
  fs.renameSync(temp, path.join(requests, `${name}.json`));
  return id;
}

/**
 * Ask the extension to put the page back in its panel-only layout, after the panel was closed from inside the page (the X in
 * VS Code's panel). It runs the same commands as at page load. Returns the request id.
 */
export function requestPanel(serverDataDir: string, now: () => number = Date.now): string {
  return writeTerminalRequest(serverDataDir, { cwd: null, panel: true }, now);
}
