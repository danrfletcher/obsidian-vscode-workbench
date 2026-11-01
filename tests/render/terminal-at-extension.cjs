// The plugin-owned extension of the terminal spike (ticket warkworth-37, PR-1, S2): opens a terminal at a folder chosen when
// the plugin asks. Plumbing only, no terminal UI. The probe (terminal-spike-check.mjs) installs this file as `extension.js`
// into <server-data-dir>/extensions/obsidian-vscode-workbench.terminal-at-0.0.1/, and tests/integration/terminal-at-extension.test.ts
// runs it against a fake `vscode`.
//
// The plugin writes `request.json` ({ "id": "<unique>", "cwd": "<folder>" }) into this extension's own folder.
//
// Every extension host the server has sees that file: the one of the page on screen, the ones that closed pages left behind for
// the reconnection grace period, those of a Code tab, and those of any other server started on the same server data dir and
// still running (the Obsidian container run had four). The first version deleted the file on sight, so a host that could not
// act (its page was gone) swallowed the request: a terminal that was asked for did not open. So:
//  - a host acts only when its own browser profile carries `obsidianWorkbench.terminalPage` (the terminal page's does, a Code
//    tab's does not),
//  - a host deletes the file only after VS Code's command has answered, and only if the file still holds the id it ran. A host
//    whose page is gone gets no answer, so it leaves the file for the live one,
//  - a host runs each id once.
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

exports.activate = (ctx) => {
  const file = path.join(ctx.extensionPath, "request.json");
  let last = "";
  const run = async () => {
    if (!vscode.workspace.getConfiguration("obsidianWorkbench").get("terminalPage")) return;
    let req;
    try { req = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return; }
    if (typeof req.id !== "string" || req.id === last) return;
    last = req.id;
    await vscode.commands.executeCommand("workbench.action.terminal.newWithCwd", { cwd: req.cwd });
    try { if (JSON.parse(fs.readFileSync(file, "utf8")).id === req.id) fs.unlinkSync(file); } catch { /* already gone */ }
  };
  fs.watch(ctx.extensionPath, (_event, name) => { if (name === "request.json") run(); });
};
