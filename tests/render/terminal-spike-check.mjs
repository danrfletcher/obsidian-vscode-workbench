/**
 * Throwaway probe for the terminal spike (ticket warkworth-37, PR-1). It measures, on a real `code serve-web`
 * server in a real headless Chrome, the unknowns that docs/terminal-spike.md answers, and writes the numbers to
 * `terminal-spike-result.json` next to the screenshots. Nothing the plugin ships calls this file.
 *
 *   S1  panel-only page: can a workbench page show the terminal panel alone, hold across a reload, a recreated
 *       page and a server restart, in its own browser context (Chrome's stand-in for a second `<webview>`
 *       partition), with a Code tab in the default context unchanged?
 *   S2  a terminal at a chosen folder: a keybinding with `args` (outside the page) against a tiny extension
 *       in the server's own extension dir; a folder with spaces, a non-ASCII one and one that does not exist.
 *   S3  do terminals reattach after `reload()`, after the page is destroyed and recreated, and after two
 *       reloads in quick succession?
 *   S4  the server's process tree for an idle prompt, a running command, a hung shell and an exited shell with
 *       a leftover tab; RSS of the server plus the host page at idle and with three shells.
 *   S6  the startup sweep (`sweepOrphans`, the plugin's own code) after a simulated force-quit: a stand-in
 *       "Obsidian" process starts the server the way src/server.ts does, records it in the pidfile, and is
 *       SIGKILLed.
 *   S7  focus into the terminal and the Ctrl+` bridge (`buildRelayScript`, the Code tab's script) inside the
 *       page; do the drawer's page and a Code tab share terminals?
 * (S5, the borrow-the-source desk assessment, is on paper; this script only measures facts it quotes: the
 * licence file and the native module in the server's own folder.)
 *
 * Not part of `npm test`: it needs a VS Code build with `serve-web`, a cached VS Code server, and Google Chrome.
 * It starts the server through the plugin's `buildServeWebArgs` on 127.0.0.1 with a token file and
 * `--disable-telemetry`, on a free port it picks itself, headless Chrome on a free debugging port, and stops what it
 * started, by PID, at the end. Desktop VS Code's folders are listed before and after.
 *
 *   npm run build   # not needed: the script bundles the plugin modules it uses itself
 *   CLI_DATA_SRC=<a --cli-data-dir holding the server> SERVER_COMMIT=<its commit> npm run check:terminal-spike [outDir]
 *   # or ALLOW_DOWNLOAD=1 to let serve-web fetch the server for the installed build into the scratch folder
 *
 * Env: CODE_CLI, CLI_DATA_SRC, SERVER_COMMIT (default: the installed build's commit), ALLOW_DOWNLOAD=1, CHROME,
 * SERVER_TMPDIR (default /tmp, see the comment at the spawn).
 *
 * Exit codes: 0 all measured and every check held, 1 a check failed, 2 could not run (a missing tool, no server,
 * a page that never painted).
 */
import { build } from "esbuild";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CODE = process.env.CODE_CLI ?? "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CLI_DATA_SRC = process.env.CLI_DATA_SRC;
const ALLOW_DOWNLOAD = process.env.ALLOW_DOWNLOAD === "1";
for (const [name, f] of [["CODE_CLI", CODE], ["CHROME", CHROME]]) {
  if (!f || !fs.existsSync(f)) {
    console.error(`terminal spike needs ${name}${f ? ` (${f} does not exist)` : " (not set)"}`);
    process.exit(2);
  }
}
const [version, installedCommit] = execFileSync(CODE, ["--version"], { encoding: "utf8" }).trim().split("\n");
const commit = process.env.SERVER_COMMIT ?? installedCommit;
const held = CLI_DATA_SRC && fs.existsSync(path.join(CLI_DATA_SRC, "serve-web"))
  ? fs.readdirSync(path.join(CLI_DATA_SRC, "serve-web")).filter((n) => /^[0-9a-f]{40}$/.test(n))
  : [];
const haveServer = held.includes(commit);
if (!haveServer && !ALLOW_DOWNLOAD) {
  console.error(
    `terminal spike cannot run: the installed VS Code (${CODE}) is ${version} (server commit ${installedCommit}), and ` +
      (CLI_DATA_SRC
        ? `CLI_DATA_SRC (${CLI_DATA_SRC}) ${held.length ? `holds a server only for ${held.join(", ")} (set SERVER_COMMIT to use one)` : "holds no cached server"}.`
        : "CLI_DATA_SRC is not set.") +
      `\nSet CLI_DATA_SRC to a --cli-data-dir whose serve-web/ folder holds ${commit}, or set ALLOW_DOWNLOAD=1 to let ` +
      "serve-web download that server from Microsoft into the scratch directory.",
  );
  process.exit(2);
}
const scratchBase = process.env.TMPDIR ?? os.tmpdir();
const work = fs.mkdtempSync(path.join(scratchBase, "terminal-spike-"));
const outDir = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(scratchBase, "terminal-spike-shots-")));
fs.mkdirSync(outDir, { recursive: true });
const IS_MAC = process.platform === "darwin";
const MOD = IS_MAC ? 4 : 2; // CDP modifier bits: 1 alt, 2 ctrl, 4 meta, 8 shift. Cmd on a Mac, Ctrl elsewhere.

// ---------------------------------------------------------------------------------------------------------
// bookkeeping: everything started is recorded by PID and stopped by PID, nothing else
// ---------------------------------------------------------------------------------------------------------
const started = new Set(); // root PIDs this script started
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const log = (...a) => console.log(...a);
const failures = [];
const check = (ok, what, detail) => {
  log(`${ok ? "PASS" : "FAIL"}  ${what}${detail === undefined ? "" : `  (${detail})`}`);
  if (!ok) failures.push(what);
};
const R = { startedAt: new Date().toISOString(), host: `${os.platform()} ${os.release()}`, code: { version, installedCommit, serverCommit: commit } };
let neverPainted = false;

function psRows() {
  const out = execFileSync("ps", ["-axww", "-o", "pid=,ppid=,pgid=,stat=,rss=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
    .map((m) => ({ pid: +m[1], ppid: +m[2], pgid: +m[3], stat: m[4], rss: +m[5], command: m[6] }));
}
function subtree(rows, rootPid) {
  const out = [];
  const walk = (p) => { for (const r of rows) if (r.ppid === p) { out.push(r); walk(r.pid); } };
  const self = rows.find((r) => r.pid === rootPid);
  if (self) out.push(self);
  walk(rootPid);
  return out;
}
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function stopPid(rootPid) {
  const pids = subtree(psRows(), rootPid).map((r) => r.pid);
  for (const p of pids) { try { process.kill(p, "SIGCONT"); process.kill(p, "SIGTERM"); } catch { /* gone */ } }
  for (let i = 0; i < 20 && pids.some(isAlive); i++) await sleep(0.1);
  for (const p of pids) if (isAlive(p)) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
  started.delete(rootPid);
}
function stopAllSync() {
  for (const rootPid of [...started]) {
    const pids = subtree(psRows(), rootPid).map((r) => r.pid);
    for (const p of pids) { try { process.kill(p, "SIGCONT"); process.kill(p, "SIGKILL"); } catch { /* gone */ } }
    started.delete(rootPid);
  }
}
async function stopAll() { for (const p of [...started]) await stopPid(p); }
process.on("exit", stopAllSync);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on("error", reject);
  });
}
const until = async (fn, seconds, what) => {
  for (let i = 0; i < seconds * 2; i++) { const v = await fn(); if (v) return v; await sleep(0.5); }
  throw new Error(`timed out waiting for ${what}`);
};
/** A process command line made short and free of the scratch path, for the tables in the doc. */
const short = (cmd) => cmd.split(work).join("$WORK").replace(/\/[^ ]*\/serve-web\/[0-9a-f]{40}\//g, "<server>/").replace(/\/Applications\/Visual Studio Code\.app\/Contents\/(MacOS|Resources\/app\/(bin|out))\//g, "<code>/").slice(0, 150);
const table = (rows) => rows.map((r) => `${String(r.pid).padStart(6)} ${String(r.ppid).padStart(6)} ${r.stat.padEnd(4)} ${String(Math.round(r.rss / 1024)).padStart(5)}M  ${short(r.command)}`);

// ---------------------------------------------------------------------------------------------------------
// the plugin's own code
// ---------------------------------------------------------------------------------------------------------
await build({
  entryPoints: {
    settings: path.join(root, "src/settings.ts"),
    trust: path.join(root, "src/trust/trust-seed.ts"),
    paths: path.join(root, "src/paths.ts"),
    server: path.join(root, "src/server.ts"),
    pidfile: path.join(root, "src/pidfile.ts"),
    bridge: path.join(root, "src/hotkey/hotkey-bridge.ts"),
  },
  bundle: true, format: "esm", platform: "node", outdir: path.join(work, "plugin"), outExtension: { ".js": ".mjs" }, logLevel: "error",
});
const load = (n) => import(pathToFileURL(path.join(work, `plugin/${n}.mjs`)).href);
const [settings, trust, paths, serverMod, pidfileMod, bridge] = await Promise.all(["settings", "trust", "paths", "server", "pidfile", "bridge"].map(load));

// ---------------------------------------------------------------------------------------------------------
// desktop VS Code must not change (F6): listed before and after
// ---------------------------------------------------------------------------------------------------------
const home = os.homedir();
function desktopListing() {
  const out = {};
  const sum = (f) => { try { return crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 16); } catch { return null; } };
  for (const d of [".vscode", ".vscode-insiders"]) {
    const dir = path.join(home, d);
    let names = [];
    try { names = fs.readdirSync(dir).sort(); } catch { /* none */ }
    out[`~/${d}`] = names;
    out[`~/${d}/extensions/extensions.json`] = sum(path.join(dir, "extensions", "extensions.json"));
    try { out[`~/${d}/extensions (entries)`] = fs.readdirSync(path.join(dir, "extensions")).length; } catch { /* none */ }
  }
  const app = process.platform === "darwin" ? path.join(home, "Library/Application Support") : path.join(home, ".config");
  for (const prod of ["Code", "Code - Insiders"]) {
    for (const f of ["settings.json", "keybindings.json"]) out[`${prod}/User/${f}`] = sum(path.join(app, prod, "User", f));
  }
  return out;
}
const desktopBefore = desktopListing();

// ---------------------------------------------------------------------------------------------------------
// fixtures: a vault, and the tiny plugin-owned extension of S2
// ---------------------------------------------------------------------------------------------------------
const vault = path.join(work, "vault");
const FOLDERS = {
  spaces: path.join(vault, "Notes folder with spaces"),
  unicode: path.join(vault, "estimaté tïme 文件"),
  missing: path.join(vault, "folder that does not exist"),
};
fs.mkdirSync(FOLDERS.spaces, { recursive: true });
fs.mkdirSync(FOLDERS.unicode, { recursive: true });
fs.writeFileSync(path.join(vault, "note.md"), "# a note\n");
const EXT_ID = "obsidian-vscode-workbench.terminal-at";
const EXT_DIR_NAME = `${EXT_ID}-0.0.1`;
/** The setting only the terminal page's browser profile carries (see PANEL_SETTINGS): it names the page that may act. */
const TERMINAL_PAGE_SETTING = "obsidianWorkbench.terminalPage";
// Version 1, the first spike run: every extension host that sees request.json reads it, deletes it and acts. Kept as the
// control: measured to hold after page reloads and a Code tab beside, and to lose requests when another server is still running
// on the same server data dir (see measureS2).
const EXT_SOURCE_V1 = `const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
exports.activate = (ctx) => {
  const file = path.join(ctx.extensionPath, "request.json");
  const run = async () => {
    let req;
    try { req = JSON.parse(fs.readFileSync(file, "utf8")); fs.unlinkSync(file); } catch { return; }
    await vscode.commands.executeCommand("workbench.action.terminal.newWithCwd", { cwd: req.cwd });
  };
  fs.watch(ctx.extensionPath, (_event, name) => { if (name === "request.json") run(); });
};
`;
// Version 2, the one PR-2 should copy: tests/render/terminal-at-extension.cjs (its comment says what changed and why).
const EXT_SOURCE_V2 = fs.readFileSync(path.join(root, "tests/render/terminal-at-extension.cjs"), "utf8");
function installExtension(serverData, version = 2) {
  const dir = path.join(serverData, "extensions", EXT_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "terminal-at", publisher: "obsidian-vscode-workbench", version: "0.0.1", engines: { vscode: "^1.80.0" },
    main: "./extension.js", activationEvents: ["onStartupFinished"], extensionKind: ["workspace"],
    contributes: { configuration: { properties: { [TERMINAL_PAGE_SETTING]: { type: "boolean", default: false, description: "The terminal page: the only page whose extension host opens terminals on the plugin's request." } } } },
  }));
  fs.writeFileSync(path.join(dir, "extension.js"), version === 1 ? EXT_SOURCE_V1 : EXT_SOURCE_V2);
  fs.writeFileSync(path.join(serverData, "extensions", "extensions.json"), JSON.stringify([{
    identifier: { id: EXT_ID }, version: "0.0.1", location: { $mid: 1, path: dir, scheme: "file" }, relativeLocation: EXT_DIR_NAME,
    metadata: { installedTimestamp: 1, pinned: true, source: "resource" },
  }]));
  return dir;
}

// ---------------------------------------------------------------------------------------------------------
// the server: started the way src/server.ts starts it (buildServeWebArgs, token file, detached)
// ---------------------------------------------------------------------------------------------------------
const runtimes = new Map();
function prepareRuntime(name, extVersion = 2) {
  const runtime = path.join(work, `runtime-${name}`);
  const serverData = path.join(runtime, "server-data");
  fs.mkdirSync(serverData, { recursive: true });
  settings.writeMachineSettings(serverData, { dark: true });
  const cliData = path.join(runtime, "cli-data");
  if (haveServer) fs.cpSync(CLI_DATA_SRC, cliData, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
  else fs.mkdirSync(cliData, { recursive: true }); // ALLOW_DOWNLOAD: serve-web fetches the server into here
  const extDir = installExtension(serverData, extVersion);
  const tokenFile = path.join(runtime, "token");
  const rt = { name, runtime, serverData, cliData, tokenFile, extDir };
  runtimes.set(name, rt);
  return rt;
}
function serverArgs(rt, port) {
  return serverMod.buildServeWebArgs({ port, tokenFile: rt.tokenFile, serverDataDir: rt.serverData, cliDataDir: rt.cliData, acceptLicense: true, disableTelemetry: true, commitId: commit });
}
const SERVER_ENV = {
  ...process.env,
  // The server listens on a unix socket `<TMPDIR>/code-insiders-<uuid>`; macOS caps socket paths at 104 characters and
  // a scratch dir is longer than that, so the server (and only the server) gets a short TMPDIR.
  TMPDIR: process.env.SERVER_TMPDIR ?? "/tmp",
};
async function awaitServer(port, token, logFile) {
  let answered = 0;
  for (let i = 0; i < (haveServer ? 60 : 400); i++) {
    answered = await fetch(`http://127.0.0.1:${port}/?tkn=${token}`, { redirect: "manual", signal: AbortSignal.timeout(3000) }).then((r) => r.status, () => 0);
    if (answered === 302 || answered === 200) break;
    if (answered >= 500) break;
    await sleep(1);
  }
  if (answered !== 302 && answered !== 200) {
    console.error(`the server did not come up (answered ${answered}; see ${logFile})`);
    process.exit(2);
  }
}
/** Start a server straight from this script (detached, own process group, like the plugin). */
async function startServer(rt, port) {
  const token = serverMod.createTokenFile(rt.tokenFile);
  const logFile = path.join(work, `server-${rt.name}.log`);
  const child = spawn(CODE, serverArgs(rt, port), { detached: true, stdio: ["ignore", fs.openSync(logFile, "w"), "ignore"], env: SERVER_ENV });
  started.add(child.pid);
  log(`[${rt.name}] server wrapper pid ${child.pid} on 127.0.0.1:${port}`);
  await awaitServer(port, token, logFile);
  await sleep(3);
  return { ...rt, port, token, pid: child.pid, origin: `http://127.0.0.1:${port}` };
}

// ---------------------------------------------------------------------------------------------------------
// one browser, many contexts (a context is Chrome's own separate profile: the stand-in for a webview partition)
// ---------------------------------------------------------------------------------------------------------
async function startChrome(name) {
  const cdpPort = await freePort();
  const dir = path.join(work, "chrome-" + name);
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${dir}`, "--no-first-run", "--disable-background-networking", "about:blank"], { stdio: "ignore" });
  started.add(chrome.pid);
  const ver = await until(() => fetch(`http://127.0.0.1:${cdpPort}/json/version`).then((r) => r.json(), () => null), 30, "Chrome's debugging port");
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pend = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) pend.get(d.id)(d);
    else for (const l of listeners) l(d);
  };
  const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const br = { pid: chrome.pid, send };
  br.newContext = async () => (await send("Target.createBrowserContext", { disposeOnDetach: false })).result.browserContextId;
  br.rendererPids = async () => ((await send("SystemInfo.getProcessInfo")).result?.processInfo ?? []).filter((p) => p.type === "renderer").map((p) => p.id);
  br.newPage = async (contextId, url = "about:blank") => {
    const targetId = (await send("Target.createTarget", { url, ...(contextId ? { browserContextId: contextId } : {}) })).result.targetId;
    const sessionId = (await send("Target.attachToTarget", { targetId, flatten: true })).result.sessionId;
    const p = (method, params) => send(method, params, sessionId);
    await p("Page.enable");
    await p("Runtime.enable");
    await p("Emulation.setFocusEmulationEnabled", { enabled: true });
    await p("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    const page = { targetId, send: p, dialogs: [], logs: [] };
    listeners.push((d) => {
      if (d.sessionId !== sessionId) return;
      // A page with a running terminal asks "leave the page?" on reload. A webview has no dialog UI: the host has to answer.
      if (d.method === "Page.javascriptDialogOpening") { page.dialogs.push(d.params.type); p("Page.handleJavaScriptDialog", { accept: true }); }
      if (d.method === "Runtime.consoleAPICalled") page.logs.push(d.params.args.map((a) => a.value ?? a.description).join(" "));
    });
    page.ev = async (e) => {
      const r = (await p("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result;
      return r?.result?.value ?? (r?.exceptionDetails ? `ERROR ${r.exceptionDetails.exception?.description}` : undefined);
    };
    page.key = async (k, code, vk, modifiers = 0) => { for (const type of ["rawKeyDown", "keyUp"]) await p("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, modifiers }); };
    // xterm.js reads key events, not insertText: one keyDown (with its text) and keyUp per character.
    page.enter = async () => { await p("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }); await p("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }); };
    page.type = async (text) => { for (const ch of text) { await p("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch }); await p("Input.dispatchKeyEvent", { type: "keyUp", key: ch }); } };
    page.run = async (cmd) => { await page.type(cmd); await page.enter(); };
    page.shot = async (file) => {
      const s = await p("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(outDir, file), Buffer.from(s.result.data, "base64"));
      log(`  screenshot ${path.join(outDir, file)}`);
    };
    page.goto = (u) => p("Page.navigate", { url: u });
    page.reload = () => p("Page.reload", { ignoreCache: false });
    page.close = () => Promise.race([send("Target.closeTarget", { targetId }), sleep(5)]);
    return page;
  };
  br.close = async () => { try { ws.close(); } catch { /* gone */ } await stopPid(chrome.pid); };
  return br;
}

// ---------------------------------------------------------------------------------------------------------
// the workbench page
// ---------------------------------------------------------------------------------------------------------
/**
 * What the terminal page needs on top of the plugin's own Code tab settings (src/settings.ts):
 *  - `workbench.panel.opensMaximized: always`: opening the panel hides the editor area (the one setting that gets
 *    close to a panel-only layout; microsoft/vscode#34442),
 *  - `obsidianWorkbench.terminalPage: true`: the plugin-owned extension of S2 opens terminals only in the page whose
 *    browser profile carries it (a Code tab does not),
 *  - the two settings below are for this probe only: they make the terminal text readable from the page (the DOM
 *    renderer, and the screen-reader tree) so `pwd` can be seen; they change nothing visible.
 */
const PANEL_SETTINGS = { "workbench.panel.opensMaximized": "always", [TERMINAL_PAGE_SETTING]: true };
const PROBE_ONLY_SETTINGS = { "terminal.integrated.gpuAcceleration": "off", "editor.accessibilitySupport": "on", "terminal.integrated.tabs.hideForOneTerminal": false };
const PARTS = [".part.titlebar", ".part.activitybar", ".part.sidebar", ".part.auxiliarybar", ".part.editor", ".part.panel", ".part.statusbar"];
const LAYOUT = `(() => { const r = { win: [innerWidth, innerHeight] }; for (const sel of ${JSON.stringify(PARTS)}) { const e = document.querySelector(sel); const b = e && e.getBoundingClientRect(); r[sel.slice(6)] = e ? [Math.round(b.width), Math.round(b.height)] : null; } return JSON.stringify(r); })()`;
const layout = async (page) => JSON.parse(await page.ev(LAYOUT));
const hidden = (v) => v === null || v[0] === 0 || v[1] === 0;
const fmt = (l) => PARTS.map((s) => `${s.slice(6)} ${l[s.slice(6)] === null ? "none" : l[s.slice(6)].join("x")}`).join(", ");

/** Seed the browser profile (settings, trust record) on the server's origin, then load the workbench. */
async function openWorkbench(br, ctx, srv, { extra = {}, folder = vault, dark = true } = {}) {
  const page = await br.newPage(ctx, `${srv.origin}/manifest.json?tkn=${srv.token}`);
  await sleep(1);
  const base = { ...settings.workbenchOverlay({ dark }), ...settings.BROWSER_APP_SETTINGS, "workbench.startupEditor": "none", ...extra };
  const seeded = await page.ev(settings.buildBrowserSeedScript(base));
  const trusted = await page.ev(trust.buildTrustSeedScript({ origin: srv.origin, folderUri: paths.buildFileUri(srv.origin, folder), heldPorts: [srv.port] }));
  await page.goto(`${srv.origin}/?tkn=${srv.token}&folder=${encodeURIComponent(folder)}`);
  await waitPainted(page);
  return { page, seeded, trusted };
}
async function waitPainted(page) {
  try {
    await until(async () => (await page.ev("[...document.querySelectorAll('.part.statusbar, .part.editor, .part.panel')].some((e) => e.offsetWidth > 0)")) === true, 120, "the workbench to paint");
  } catch { neverPainted = true; throw new Error("the page did not paint"); }
  await sleep(4);
}
const KEY = {
  toggleTerminal: (page) => page.key("`", "Backquote", 192, 2), // Ctrl+`
  newTerminal: (page) => page.key("`", "Backquote", 192, 2 | 8), // Ctrl+Shift+`
  toggleSideBar: (page) => page.key("b", "KeyB", 66, MOD), // Cmd/Ctrl+B
};
/** Open the terminal panel and hide the side bar: the two key presses the panel-only page needs, once. */
async function makePanelOnly(page) {
  await page.ev("document.body.click()");
  await KEY.toggleTerminal(page);
  await sleep(5);
  await KEY.toggleSideBar(page);
  await sleep(2);
}
const panelOnly = (l) => PARTS.filter((s) => s !== ".part.panel").every((s) => hidden(l[s.slice(6)])) && l.panel !== null && l.panel[0] >= l.win[0] - 16 && l.panel[1] >= l.win[1] - 16;
const TAB_LABELS = `JSON.stringify([...document.querySelectorAll('.terminal-tabs-entry')].map(e => e.innerText.replace(/\\s+/g, ' ').trim()))`;
const tabs = async (page) => JSON.parse((await page.ev(TAB_LABELS)) || "[]");
const TERM_TEXT = `(document.querySelector('.terminal-wrapper.active .xterm-rows')?.innerText || document.querySelector('.xterm-rows')?.innerText || '').replace(/\\u00a0/g, ' ')`;
const termText = async (page) => (await page.ev(TERM_TEXT)) ?? "";

/** The shells under the server wrapper: the children of the pty host that are a shell. */
const SHELL_RE = /\/(zsh|bash|sh|dash|fish)( |$)/;
function serverView(srv) {
  const rows = psRows();
  const tree = subtree(rows, srv.pid);
  const ptyHost = tree.find((r) => /--type=ptyHost/.test(r.command));
  const shells = ptyHost ? tree.filter((r) => r.ppid === ptyHost.pid && SHELL_RE.test(r.command)) : [];
  return { rows, tree, ptyHost, shells };
}
const cwdOf = (pid) => {
  try {
    const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
    return out.split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? null;
  } catch { return null; }
};
const rssOf = (rows) => rows.reduce((a, r) => a + r.rss, 0);
const mb = (kb) => Math.round(kb / 1024);


/** RSS of the server's whole process tree and of the renderers that were not there before the page was opened. */
function measureMemory(srv, rendererNow, rendererBefore, note) {
  const rows = psRows();
  const v = serverView(srv);
  const host = rows.filter((r) => rendererNow.includes(r.pid) && !rendererBefore.includes(r.pid)).reduce((a, r) => a + r.rss, 0);
  const inShells = new Set(v.shells.flatMap((x) => subtree(rows, x.pid).map((r) => r.pid)));
  return { note, shells: v.shells.length, serverTreeMB: mb(rssOf(v.tree)), ofWhichShellsMB: mb(rssOf(v.tree.filter((r) => inShells.has(r.pid)))), hostPageMB: mb(host), extensionHosts: v.tree.filter((r) => /type=extensionHost/.test(r.command)).length };
}

const extHostCount = (srv) => subtree(psRows(), srv.pid).filter((r) => /type=extensionHost/.test(r.command)).length;
/** The plugin's side of the file route: write request.json into the extension's folder, whole or not at all (write, then rename). */
function writeRequest(rt, req) {
  const tmp = path.join(rt.runtime, `request-${req.id ?? "x"}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(req));
  fs.renameSync(tmp, path.join(rt.extDir, "request.json"));
}
/**
 * Ask for a terminal at each of the three folders through the extension, and record what the server and the page did.
 * `shotAs` takes the screenshot of the first (the folder with spaces) with `pwd` visible.
 */
async function askForFolders(rt, srv, page, tag, shotAs, rounds = 1) {
  const all = [];
  for (let round = 1; round <= rounds; round++) {
    const out = {};
    for (const key of ["spaces", "unicode", "missing"]) {
      const known = serverView(srv).shells.map((x) => x.pid);
      // a leftover request must not decide the result
      fs.rmSync(path.join(rt.extDir, "request.json"), { force: true });
      writeRequest(rt, { id: `${tag}-${round}-${key}-${Date.now()}`, cwd: FOLDERS[key] });
      await sleep(6);
      const fresh = serverView(srv).shells.filter((x) => !known.includes(x.pid));
      const toast = await page.ev(`[...document.querySelectorAll('.notifications-toasts .notification-toast')].map(e => e.innerText.replace(/\\s+/g, ' ')).join(' | ')`);
      const entry = { requested: FOLDERS[key].replace(work, "$WORK"), requestFileTaken: !fs.existsSync(path.join(rt.extDir, "request.json")), newShells: fresh.length, terminalOpened: fresh.length > 0, shellCwd: fresh[0] ? cwdOf(fresh[0].pid) : null, notice: toast ?? "" };
      if (fresh[0]) {
        await page.ev("document.querySelector('.terminal-wrapper.active .xterm-helper-textarea')?.focus()");
        await page.run("pwd");
        await sleep(2);
        entry.pwdPrinted = (await termText(page)).replace(/\s+/g, " ").trim().slice(-200);
        if (key === "spaces" && round === 1 && shotAs) await page.shot(shotAs);
      }
      entry.matchesFolder = !!entry.shellCwd && fs.existsSync(FOLDERS[key]) && fs.realpathSync(entry.shellCwd) === fs.realpathSync(FOLDERS[key]);
      out[key] = entry;
      log(`extension route (${tag}, round ${round}), ${key}:`, JSON.stringify(entry));
    }
    all.push(out);
  }
  // per folder: how many requests, how many opened a terminal in the right folder
  const summary = {};
  for (const key of ["spaces", "unicode", "missing"]) summary[key] = { asked: all.length, openedAtFolder: all.filter((r) => r[key].matchesFolder).length, openedAny: all.filter((r) => r[key].terminalOpened).length };
  return { rounds: all, summary };
}
/**
 * One S2 server: a terminal page in its own browser context, optionally with a Code tab beside it (default context) and a
 * history of page reloads, a recreated page and quick double reloads first. Every page connection leaves an extension host
 * alive for the reconnection grace period (measured in S3), so after that history there are several hosts watching the
 * request file and only one belongs to the page on screen. This is the state the Obsidian container run was in.
 */
async function s2Scenario(br, { version, churned, leftover = 0, rounds = 1, tag, shotAs, measureIdle }) {
  const rt = prepareRuntime(tag, version);
  // Servers that an earlier start left running on the same server data dir (what a plugin start after a force-quit finds before
  // its sweep, and what the Obsidian container run had: four servers, one extension folder). Each had a page; the page is gone.
  const leftovers = [];
  for (let i = 0; i < leftover; i++) {
    const old = await startServer(rt, await freePort());
    const oldCtx = await br.newContext();
    const { page: oldPage } = await openWorkbench(br, oldCtx, old, { extra: { ...PANEL_SETTINGS, ...PROBE_ONLY_SETTINGS } });
    await makePanelOnly(oldPage);
    await oldPage.close();
    leftovers.push(old);
  }
  const srv = await startServer(rt, await freePort());
  const rendererBefore = await br.rendererPids();
  const ctx = await br.newContext();
  const termUrl = `${srv.origin}/?tkn=${srv.token}&folder=${encodeURIComponent(vault)}`;
  let { page } = await openWorkbench(br, ctx, srv, { extra: { ...PANEL_SETTINGS, ...PROBE_ONLY_SETTINGS } });
  await makePanelOnly(page);
  await sleep(3);
  if (measureIdle) R.memory = { ...(R.memory ?? {}), idleFresh: measureMemory(srv, await br.rendererPids(), rendererBefore, "a fresh server, one page never reloaded, one shell at an idle prompt") };
  const info = { extensionVersion: version, churned, leftoverServers: leftover, extensionHostsAtStart: extHostCount(srv) };
  info.extensionHostsOnLeftoverServers = leftovers.map((o) => extHostCount(o));
  let codeTab = null;
  if (churned) {
    codeTab = (await openWorkbench(br, undefined, srv, { extra: { "terminal.integrated.tabs.hideForOneTerminal": false } })).page;
    const back = async () => { await sleep(2); await waitPainted(page); };
    await page.reload(); await back();
    await page.reload(); await sleep(0.4); await page.reload(); await back();
    await page.close(); await sleep(2);
    page = await br.newPage(ctx, termUrl); await waitPainted(page);
    await page.reload(); await back();
    info.history = "a Code tab beside; the terminal page reloaded, reloaded twice 0.4 s apart, destroyed and created again, reloaded";
  }
  info.extensionHostsBeforeRequests = extHostCount(srv);
  info.shellsBeforeRequests = serverView(srv).shells.length;
  info.layoutBeforeRequests = fmt(await layout(page));
  const asked = await askForFolders(rt, srv, page, tag, shotAs, rounds);
  info.rounds = asked.rounds;
  info.summary = asked.summary;
  info.works = ["spaces", "unicode"].every((k) => asked.summary[k].openedAtFolder === asked.summary[k].asked) && asked.summary.missing.openedAny === 0;
  return { info, rt, srv, page, codeTab, ctx, leftovers };
}

/**
 * S2. Two ways to open a terminal at a chosen folder were tried: a keybinding with `args` (from outside the page) and the
 * plugin-owned extension reading a request file. The extension is tried on a fresh server whose page was never reloaded, and
 * on one that has had reloads and a Code tab beside, which is where the first version of it lost requests.
 */
async function measureS2(br) {
  const s2 = { routes: {}, folders: {} };
  const done = async (sc) => { await sc.page.close(); await sc.codeTab?.close(); await stopPid(sc.srv.pid); for (const o of sc.leftovers) await stopPid(o.pid); };
  // 1. the extension, version 1 (the first spike run): the control. First on a server that has had page reloads and a Code tab beside...
  const v1c = await s2Scenario(br, { version: 1, churned: true, tag: "c1" });
  s2.v1AfterPageReloads = v1c.info;
  await done(v1c);
  // ...then on a server that shares its extension folder with two servers an earlier start left running.
  const v1l = await s2Scenario(br, { version: 1, churned: false, leftover: 2, rounds: 3, tag: "c1l" });
  s2.v1WithLeftoverServers = v1l.info;
  await done(v1l);
  // 2. the extension, version 2, with both histories at once
  const v2 = await s2Scenario(br, { version: 2, churned: true, leftover: 2, rounds: 3, tag: "c2", shotAs: "shot-3-new-terminal-at-folder.png" });
  s2.v2WithLeftoverServersAndReloads = v2.info;
  s2.extensionInsideServerExtensionDir = path.resolve(v2.rt.extDir).startsWith(path.resolve(v2.rt.serverData, "extensions") + path.sep);
  s2.extensionInstallPath = `<server-data-dir>/extensions/${EXT_DIR_NAME}/ (package.json, extension.js) plus an entry in <server-data-dir>/extensions/extensions.json`;
  await done(v2);
  // 3. version 2 on a fresh server, one page never reloaded; then the keybinding route on the same page
  const fresh = await s2Scenario(br, { version: 2, churned: false, tag: "c3", measureIdle: true });
  s2.v2Fresh = fresh.info;
  const { rt, srv, page } = fresh;
  const chordFor = { spaces: ["1", "Digit1", 49], unicode: ["2", "Digit2", 50], missing: ["3", "Digit3", 51] };
  const kb = Object.keys(FOLDERS).map((k) => ({ key: `ctrl+alt+${chordFor[k][0]}`, command: "workbench.action.terminal.newWithCwd", args: { cwd: FOLDERS[k] } }));
  const copy = { id: "kb-" + Date.now(), settings: { ...settings.BROWSER_APP_SETTINGS, ...PANEL_SETTINGS, ...PROBE_ONLY_SETTINGS }, keybindingsBase64: Buffer.from(JSON.stringify(kb)).toString("base64") };
  s2.routes.keybinding = { written: await page.ev(settings.buildBrowserSeedScript(settings.BROWSER_APP_SETTINGS, copy)) };
  const press = async (which) => {
    await page.ev("document.body.click()");
    const known = serverView(srv).shells.map((x) => x.pid);
    await page.key(...chordFor[which], 3);
    await sleep(4);
    return serverView(srv).shells.filter((x) => !known.includes(x.pid));
  };
  s2.routes.keybinding.openedWithoutReload = (await press("spaces")).length > 0;
  await page.reload();
  await sleep(2);
  await waitPainted(page);
  const out = {};
  for (const which of ["spaces", "unicode", "missing"]) {
    const found = await press(which);
    out[which] = { opened: found.length > 0, cwd: found[0] ? cwdOf(found[0].pid) : null };
    out[which].matchesFolder = !!out[which].cwd && fs.existsSync(FOLDERS[which]) && fs.realpathSync(out[which].cwd) === fs.realpathSync(FOLDERS[which]);
  }
  s2.routes.keybinding.afterReload = out;
  log("keybinding route:", JSON.stringify(s2.routes.keybinding));
  const extWorks = s2.v2WithLeftoverServersAndReloads.works && s2.v2Fresh.works;
  const kbWorks = out.spaces.matchesFolder && out.unicode.matchesFolder;
  R.cwd_open = kbWorks && s2.routes.keybinding.openedWithoutReload ? "outside_page" : extWorks ? "extension" : "not_possible";
  s2.verdict = R.cwd_open;
  check(s2.extensionInsideServerExtensionDir, "S2: the extension lives inside the server's own extension dir");
  check(s2.v2WithLeftoverServersAndReloads.works, "S2: with two servers left running on the same extension folder, page reloads and a Code tab beside, the extension opens a terminal at the folder with spaces and the non-ASCII one, and none for the missing one", JSON.stringify(s2.v2WithLeftoverServersAndReloads.summary));
  check(s2.v2Fresh.works, "S2: on a fresh server the extension opens a terminal at the folder with spaces and the non-ASCII one, and none for the missing one");
  await page.close();
  await stopPid(srv.pid);
  R.s2 = s2;
}

// =========================================================================================================
// run
// =========================================================================================================
const port = await freePort();
const A = prepareRuntime("a");
const chromeA = await startChrome("a");
let srvA;
try {
  srvA = await startServer(A, port);
  const SRV_TREE_AT_START = serverView(srvA).tree;

  // ---- F3 / F4: how the server was started ----------------------------------------------------------
  const args = serverArgs(A, port);
  check(args.includes("--host") && args[args.indexOf("--host") + 1] === "127.0.0.1", "F3/F4: the server is started through buildServeWebArgs on 127.0.0.1");
  check(args.includes("--connection-token-file") && args.includes("--disable-telemetry"), "F3/F4: ...with --connection-token-file and --disable-telemetry");
  check(!SRV_TREE_AT_START.some((r) => r.command.includes(srvA.token)) && !args.some((a) => a.includes(srvA.token)), "F4: the token appears in no process argument");
  let listen = "";
  try { listen = execFileSync("lsof", ["-nP", "-a", "-p", SRV_TREE_AT_START.map((r) => r.pid).join(","), "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8" }); } catch { /* none */ }
  const listeners = listen.split("\n").slice(1).filter(Boolean).map((l) => l.split(/\s+/).find((c) => /:\d+$/.test(c) || /:\d+\b/.test(c)) ?? l);
  R.f4 = { listeners };
  check(listeners.length > 0 && listeners.every((l) => l.startsWith("127.0.0.1:")), "F4: lsof shows only loopback TCP listeners for the server tree", listeners.join(", "));

  // ---- the Code tab, in the default context, before anything else (S1: it must not change) ---------------------
  const codeCtxPage = await openWorkbench(chromeA, undefined, srvA, { extra: { "terminal.integrated.tabs.hideForOneTerminal": false } }); // the plugin's own Code tab settings only
  const codeTab = codeCtxPage.page;
  const codeBefore = await layout(codeTab);
  log("Code tab before:", fmt(codeBefore));

  // S2 starts several servers and pages of its own; they get a Chrome of their own, closed before S1 and S3 go on, so that this
  // browser and the Code tab above are not carrying their memory.
  const chromeS2 = await startChrome("s2");
  await measureS2(chromeS2);
  await chromeS2.close();

  // ---- S1: the panel-only page, in its own context --------------------------------------------------------------
  const rendererBefore = await chromeA.rendererPids();
  const ctxTerm = await chromeA.newContext();
  const opened = await openWorkbench(chromeA, ctxTerm, srvA, { extra: { ...PANEL_SETTINGS, ...PROBE_ONLY_SETTINGS } });
  let term = opened.page;
  const rendererNew = (await chromeA.rendererPids()).filter((p) => !rendererBefore.includes(p));
  const beforeKeys = await layout(term);
  log("terminal page, before the two key presses:", fmt(beforeKeys));
  await makePanelOnly(term);
  const lay1 = await layout(term);
  log("terminal page, panel-only:", fmt(lay1));
  const t1 = await tabs(term);
  const s1 = {
    seeded: opened.seeded, trusted: opened.trusted, beforeKeys, afterKeys: lay1, tabsAfter: t1,
    measured: panelOnly(lay1),
    hiddenParts: PARTS.filter((s) => s !== ".part.panel" && hidden(lay1[s.slice(6)])).map((s) => s.slice(6)),
    panelHeaderTabs: await term.ev(`JSON.stringify([...document.querySelectorAll('.part.panel .composite-bar .action-label')].map(e => e.getAttribute('aria-label') || e.innerText).filter(Boolean))`),
  };
  // GP2: the one shell that started is in the vault root (the folder the page was opened on); where the terminal list is drawn
  const gp2 = {};
  const entryRects = async () => JSON.parse((await term.ev(`JSON.stringify([...document.querySelectorAll('.terminal-tabs-entry')].map(e => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; }).filter(r => r[2] > 0 && r[3] > 0))`)) ?? "[]");
  gp2.window = lay1.win;
  const gp2Shells = serverView(srvA).shells;
  gp2.shellsStarted = gp2Shells.length;
  gp2.firstShellCwd = gp2Shells[0] ? cwdOf(gp2Shells[0].pid) : null;
  gp2.firstShellInVaultRoot = !!gp2.firstShellCwd && fs.realpathSync(gp2.firstShellCwd) === fs.realpathSync(vault);
  // VS Code draws the list only from the second terminal on (hideForOneTerminal, set to false in this page's settings, did not change that)
  gp2.listEntriesWithOneTerminal = (await entryRects()).length;
  await term.shot("shot-1-panel-only.png");
  await KEY.newTerminal(term); await sleep(4);
  await term.shot("shot-1b-panel-only-two-terminals.png");
  gp2.listEntriesWithTwoTerminals = await entryRects();
  gp2.listOnRight = gp2.listEntriesWithTwoTerminals.length >= 2 && gp2.listEntriesWithTwoTerminals.every((r) => r[0] > lay1.win[0] / 2);
  const gp2After = serverView(srvA).shells.filter((x) => !gp2Shells.some((y) => y.pid === x.pid));
  gp2.secondShellCwd = gp2After[0] ? cwdOf(gp2After[0].pid) : null;
  gp2.secondShellInVaultRoot = !!gp2.secondShellCwd && fs.realpathSync(gp2.secondShellCwd) === fs.realpathSync(vault);
  s1.gp2 = gp2;
  check(gp2.shellsStarted === 1 && gp2.firstShellInVaultRoot, "GP2: one shell started with the panel, and its working directory is the vault root", `${gp2.shellsStarted} shell(s), cwd ${gp2.firstShellCwd?.replace(work, "$WORK")}`);
  check(gp2.listOnRight, "GP2: with two terminals the terminal list sits on the right of the panel-only page", `${gp2.listEntriesWithOneTerminal} list entries with one terminal; with two, entries at x ${gp2.listEntriesWithTwoTerminals.map((r) => r[0]).join(", ")} of ${gp2.window[0]}`);
  check(opened.seeded === "seeded" && opened.trusted === "seeded", "the browser profile of the terminal page was seeded (settings and trust record)", `${opened.seeded}, ${opened.trusted}`);
  check(s1.measured, "S1: with the panel open, every other workbench part measures 0 px and the panel fills the window", fmt(lay1));

  // Reload: the layout holds without pressing anything again?
  async function reloadTo(page) {
    await page.reload();
    await sleep(2);
    await waitPainted(page);
  }
  await reloadTo(term);
  const lay2 = await layout(term);
  s1.afterReload = lay2;
  s1.reloadHolds = panelOnly(lay2);
  s1.reloadDialogs = [...term.dialogs];
  check(s1.reloadHolds, "S1: the panel-only layout holds after reload() with no key press", fmt(lay2));
  // Destroy the page, create it again in the same context.
  await term.close();
  await sleep(1);
  term = await chromeA.newPage(ctxTerm, `${srvA.origin}/?tkn=${srvA.token}&folder=${encodeURIComponent(vault)}`);
  await waitPainted(term);
  const lay3 = await layout(term);
  s1.afterRecreate = lay3;
  s1.recreateHolds = panelOnly(lay3);
  check(s1.recreateHolds, "S1: the panel-only layout holds when the page is destroyed and created again in the same partition", fmt(lay3));

  // A Code tab in the default context after all of this.
  await codeTab.reload();
  await sleep(2);
  await waitPainted(codeTab);
  const codeAfter = await layout(codeTab);
  log("Code tab after:", fmt(codeAfter));
  s1.codeTab = { before: codeBefore, after: codeAfter, unchanged: JSON.stringify(codeBefore) === JSON.stringify(codeAfter) };
  check(s1.codeTab.unchanged, "S1: a Code tab in the default partition has the same sidebar, panel and layout before and after", `${fmt(codeBefore)} | ${fmt(codeAfter)}`);
  check(codeBefore.panel === null || hidden(codeBefore.panel), "S1: ...and its panel is closed (the panel state the terminal page changed in its own partition)");
  R.s1 = s1;

  // ---- memory at idle: the server and the host page, no shell yet ----------------------------------------------------
  const termRows = () => psRows();
  let rendererNowPids = rendererNew;
  const rendererRss = (rows) => rows.filter((r) => rendererNowPids.includes(r.pid)).reduce((a, r) => a + r.rss, 0);
  const idleView = serverView(srvA);
  const idleRows = termRows();
  R.memory = { ...(R.memory ?? {}), afterReloadsIdle: { serverTreeMB: mb(rssOf(idleView.tree)), hostPageMB: mb(rendererRss(idleRows)), shells: idleView.shells.length, note: "the terminal page is loaded; its terminal panel shows no shell yet or one" } };

  // ---- S3: do terminals reattach? ---------------------------------------------------------------------------------
  // The page has one terminal now (the first Ctrl+` started it). Mark it and run something that outlives a reload.
  await term.ev("document.querySelector('.xterm-helper-textarea')?.focus()");
  await term.run("echo SPIKE-MARK-1; sleep 600");
  await sleep(3);
  const before = serverView(srvA);
  const sleeper = before.tree.find((r) => /sleep 600/.test(r.command));
  const shellOfSleeper = sleeper ? before.shells.find((s) => s.pid === sleeper.ppid) : null;
  const tabsBefore = await tabs(term);
  const s3 = { shellsBefore: before.shells.map((s) => s.pid), sleepPid: sleeper?.pid ?? null, shellPid: shellOfSleeper?.pid ?? null, tabsBefore };
  check(!!sleeper && !!shellOfSleeper, "S3: setup: `sleep 600` runs in a shell under the server's pty host", sleeper ? `sleep ${sleeper.pid} in shell ${shellOfSleeper?.pid}` : "no sleep found");
  const snap = async (page) => {
    const v = serverView(srvA);
    return {
      shells: v.shells.map((s) => s.pid), sleepAlive: !!sleeper && isAlive(sleeper.pid) && v.tree.some((r) => r.pid === sleeper.pid),
      sleepStillInSameShell: !!sleeper && v.tree.some((r) => r.pid === sleeper.pid && r.ppid === shellOfSleeper?.pid),
      tabs: await tabs(page), markSeen: (await termText(page)).includes("SPIKE-MARK-1"),
      servers: subtree(psRows(), srvA.pid).filter((r) => /out\/server-main\.js/.test(r.command)).length,
      extensionHosts: subtree(psRows(), srvA.pid).filter((r) => /type=extensionHost/.test(r.command)).length,
    };
  };
  s3.dialogsBefore = term.dialogs.length;
  await reloadTo(term);
  s3.afterReload = await snap(term);
  s3.reloadDialogs = term.dialogs.slice(s3.dialogsBefore);
  await term.shot("shot-2-after-reload.png");
  // destroy and recreate the page
  await term.close();
  await sleep(2);
  term = await chromeA.newPage(ctxTerm, `${srvA.origin}/?tkn=${srvA.token}&folder=${encodeURIComponent(vault)}`);
  await waitPainted(term);
  s3.afterRecreate = await snap(term);
  // two reloads in quick succession
  const shellsBeforeDouble = serverView(srvA).shells.length;
  await term.reload();
  await sleep(0.4);
  await term.reload();
  await sleep(2);
  await waitPainted(term);
  s3.afterDoubleReload = await snap(term);
  s3.shellsBeforeDouble = shellsBeforeDouble;
  const same = (s) => JSON.stringify(s.shells) === JSON.stringify(s3.shellsBefore) && s.sleepStillInSameShell;
  s3.shellAndSleepSurvive = { reload: same(s3.afterReload), recreate: same(s3.afterRecreate), doubleReload: same(s3.afterDoubleReload) };
  s3.scrollbackBack = { reload: s3.afterReload.markSeen, recreate: s3.afterRecreate.markSeen, doubleReload: s3.afterDoubleReload.markSeen };
  const sameShell = Object.values(s3.shellAndSleepSurvive).every(Boolean);
  const scrollback = Object.values(s3.scrollbackBack).every(Boolean);
  R.reattach = sameShell && scrollback ? "yes" : sameShell || Object.values(s3.scrollbackBack).some(Boolean) ? "partial" : "no";
  s3.verdict = R.reattach;
  check(s3.afterDoubleReload.servers === 1 && s3.afterDoubleReload.shells.length === s3.shellsBefore.length, "S3: two reloads in quick succession leave one server and the same number of shells", `servers ${s3.afterDoubleReload.servers}, shells ${s3.afterDoubleReload.shells.length} (was ${s3.shellsBefore.length})`);
  R.s3 = s3;

  // ---- GP3: a dev server in a terminal keeps running while the page is frozen (a stand-in for hidden), reloaded, destroyed ----
  const gp3 = {};
  const devPort = await freePort();
  await KEY.newTerminal(term); await sleep(4);
  await term.run(`python3 -m http.server ${devPort} --bind 127.0.0.1`);
  await sleep(3);
  const devRow = () => psRows().find((r) => /http\.server/.test(r.command) && r.command.includes(String(devPort)));
  const devAnswers = async () => (await fetch(`http://127.0.0.1:${devPort}/`, { signal: AbortSignal.timeout(2000) }).then((r) => r.status, () => 0)) === 200;
  const dev0 = devRow();
  if (dev0) started.add(dev0.pid); // started through the terminal by this script: stopped by PID at the end if it is still there
  const devNow = async (what) => ({ what, answers: await devAnswers(), samePid: !!dev0 && devRow()?.pid === dev0.pid });
  gp3.before = await devNow("running, page open");
  await term.send("Page.setWebLifecycleState", { state: "frozen" });
  await sleep(3);
  gp3.pageFrozen = await devNow("page frozen (a stand-in for the webview being hidden: Chrome stops the page's timers and rendering)");
  await term.send("Page.setWebLifecycleState", { state: "active" });
  await sleep(1);
  await reloadTo(term);
  gp3.afterReload = await devNow("after reload()");
  await term.close();
  await sleep(2);
  gp3.pageDestroyed = await devNow("page destroyed, none open");
  term = await chromeA.newPage(ctxTerm, `${srvA.origin}/?tkn=${srvA.token}&folder=${encodeURIComponent(vault)}`);
  await waitPainted(term);
  gp3.afterRecreate = await devNow("page created again");
  gp3.port = devPort;
  gp3.holds = [gp3.before, gp3.pageFrozen, gp3.afterReload, gp3.pageDestroyed, gp3.afterRecreate].every((x) => x.answers && x.samePid);
  check(gp3.holds, "GP3: `python3 -m http.server` keeps answering, as the same process, while the page is frozen, reloaded, destroyed and created again", JSON.stringify([gp3.before, gp3.pageFrozen, gp3.afterReload, gp3.pageDestroyed, gp3.afterRecreate].map((x) => `${x.answers ? "up" : "DOWN"}${x.samePid ? "" : " (other pid)"}`)));
  R.gp3 = gp3;

  // ---- S4: live shells from the process tree -------------------------------------------------------------------------------
  const s4 = { states: {} };
  const treeOf = (srv) => table(serverView(srv).tree);
  async function state(name, expectLive, note) {
    await sleep(2);
    const v = serverView(srvA);
    const live = v.shells.filter((s) => !s.stat.startsWith("Z"));
    s4.states[name] = { note, expectedLiveShells: expectLive, liveShellsFound: live.length, tabs: (await tabs(term)).length, tree: table(v.tree) };
    log(`S4 ${name}: tree shows ${live.length} live shell(s), expected ${expectLive}; tabs ${s4.states[name].tabs}`);
  }
  // Everything so far (the S2 terminals and the S3 terminal) are shells too; count from here relative to this baseline.
  const baselineShells = serverView(srvA).shells.length;
  s4.baselineShells = baselineShells;
  // idle prompt: a new terminal that is left alone
  await KEY.newTerminal(term);
  await sleep(4);
  await state("idle prompt", baselineShells + 1, "a new terminal, nothing typed");
  // running command
  await term.run("sleep 601");
  await sleep(2);
  await state("running command", baselineShells + 1, "`sleep 601` in that terminal: the shell is live and has a child");
  const runningTree = serverView(srvA).tree;
  const sleeper601 = runningTree.find((r) => /sleep 601/.test(r.command));
  s4.states["running command"].childOfShell = !!sleeper601 && serverView(srvA).shells.some((s) => s.pid === sleeper601.ppid);
  // memory with three shells (the S3 shell, the S2 ones and these are all running): measured here, not on the idle prompt
  // hung shell: a shell that stopped itself
  await KEY.newTerminal(term);
  await sleep(4);
  await term.run("kill -STOP $$");
  await sleep(2);
  const stopped = serverView(srvA).shells.filter((s) => s.stat.startsWith("T"));
  await state("hung shell", baselineShells + 2, `the shell stopped itself (\`kill -STOP $$\`); ps state T for pid ${stopped.map((s) => s.pid).join(",")}`);
  s4.states["hung shell"].stoppedShellFound = stopped.length === 1;
  // exited shell with a leftover tab
  await KEY.newTerminal(term);
  await sleep(4);
  const tabsBeforeExit = (await tabs(term)).length;
  await term.run("exit 7");
  await sleep(3);
  await state("exited shell", baselineShells + 2, "`exit 7` typed: the shell process is gone");
  s4.states["exited shell"].tabsBeforeExit = tabsBeforeExit;
  s4.states["exited shell"].leftoverTab = (await tabs(term)).length === tabsBeforeExit;
  s4.states["exited shell"].exitMessage = ((await termText(term)).match(/terminated with exit code: ?\d+/) ?? [""])[0];
  s4.allMatch = Object.values(s4.states).every((s) => s.liveShellsFound === s.expectedLiveShells);
  // The leftover tab after `exit 7` is recorded (it is what the later PRs' "is a shell live" check must not rely on), not part of the verdict.
  R.live_shells = s4.allMatch && s4.states["hung shell"].stoppedShellFound && s4.states["running command"].childOfShell ? "reliable" : "unreliable";
  s4.verdict = R.live_shells;
  // memory: server plus host page with the shells above (three or more shells are running)
  const mem3 = serverView(srvA);
  rendererNowPids = (await chromeA.rendererPids()).filter((p) => !rendererBefore.includes(p));
  const rowsNow = psRows();
  R.memory.afterReloadsWithShells = {
    shells: mem3.shells.length, serverTreeMB: mb(rssOf(mem3.tree)), serverWithoutShellsMB: mb(rssOf(mem3.tree.filter((r) => !mem3.shells.some((s) => subtree(rowsNow, s.pid).some((x) => x.pid === r.pid))))),
    hostPageMB: mb(rendererRss(rowsNow)),
  };
  check(s4.allMatch, "S4: the live-shell count read from the process tree matches the expected one in all four states");
  R.s4 = s4;

  // ---- S7: focus and the Ctrl+` bridge, and shared terminals ------------------------------------------------------------------
  const s7 = {};
  await term.ev("document.body.click()");
  await KEY.newTerminal(term); await sleep(4); // the active terminal so far is the S4 shell that stopped itself
  await KEY.toggleTerminal(term); await sleep(1.5); // hide
  await KEY.toggleTerminal(term); await sleep(2.5); // show again: where did focus go?
  s7.focusAfterShowByChord = await term.ev(`document.activeElement?.className?.toString() || document.activeElement?.tagName`);
  await term.ev("document.body.blur(); document.activeElement && document.activeElement.blur && document.activeElement.blur()");
  const FOCUS_SCRIPT = "(() => { const t = document.querySelector('.terminal-wrapper.active .xterm-helper-textarea') || document.querySelector('.xterm-helper-textarea'); if (!t) return 'no terminal'; t.focus(); return document.activeElement === t ? 'focused' : 'not focused'; })()";
  s7.focusScript = FOCUS_SCRIPT;
  s7.focusScriptResult = await term.ev(FOCUS_SCRIPT);
  await term.run("echo FOCUS-OK-$((20+22))");
  await sleep(2);
  s7.typedTextReachedTerminal = (await termText(term)).includes("FOCUS-OK-42");
  const chordCfg = { chords: [{ action: "toggle-terminal", ctrl: true, meta: false, alt: false, shift: false, key: "`", code: "Backquote" }] };
  // control: without the bridge, Ctrl+` inside the terminal is VS Code's own toggle (it hides the panel)
  const panelBefore = (await layout(term)).panel;
  await KEY.toggleTerminal(term); await sleep(2);
  const panelAfterControl = (await layout(term)).panel;
  s7.controlWithoutBridge = { panelBefore, panelAfter: panelAfterControl, vscodeToggledItself: hidden(panelAfterControl) && !hidden(panelBefore) };
  await KEY.toggleTerminal(term); await sleep(3); // bring it back
  await term.ev(FOCUS_SCRIPT);
  const nonce = crypto.randomBytes(8).toString("hex");
  const relay = bridge.buildRelayScript(chordCfg, nonce);
  s7.script = "buildRelayScript(chords, nonce) from src/hotkey/hotkey-bridge.ts: the script the Code tab already receives, with one chord {ctrl+`, action toggle-terminal}";
  s7.scriptRan = await term.ev(relay + "; 'ran'");
  term.logs.length = 0;
  const activeBefore = await term.ev(`document.activeElement?.className?.toString()`);
  await KEY.toggleTerminal(term); await sleep(2);
  const lines = term.logs.filter((l) => l.startsWith(bridge.KEY_MESSAGE_PREFIX));
  const panelAfterBridge = (await layout(term)).panel;
  s7.withBridge = {
    focusWasInside: /xterm-helper-textarea/.test(activeBefore ?? ""), activeElementBefore: activeBefore,
    consoleLines: lines.map((l) => l.replace(nonce, "<nonce>")),
    bridgeSawChord: lines.some((l) => l.includes('"action":"toggle-terminal"') && l.includes(nonce)),
    panelStillOpen: !hidden(panelAfterBridge) && panelAfterBridge[0] > 0,
  };
  R.focus_bridge = s7.focusScriptResult === "focused" && s7.typedTextReachedTerminal && s7.withBridge.focusWasInside && s7.withBridge.bridgeSawChord && s7.withBridge.panelStillOpen ? "yes" : "no";
  s7.verdict = R.focus_bridge;
  await term.shot("shot-5-focus-and-bridge.png");

  // shared or separate: a Code tab in the default partition opens its own panel
  const termTabsNow = await tabs(term);
  const shellsNow = serverView(srvA).shells.map((s) => s.pid);
  await codeTab.ev("document.body.click()");
  await KEY.toggleTerminal(codeTab);
  await sleep(6);
  const codeTabs = await tabs(codeTab);
  const shellsAfterCode = serverView(srvA).shells.map((s) => s.pid);
  const codePanel = (await layout(codeTab)).panel;
  const codeWrappers = await codeTab.ev(`document.querySelectorAll('.part.panel .terminal-wrapper').length`);
  s7.shared = { codePanelSize: codePanel, codeTabTerminalWrappers: codeWrappers, terminalPageTabs: termTabsNow.length, codeTabTabs: codeTabs.length, codeTabLabels: codeTabs, shellsBefore: shellsNow.length, shellsAfterCodeTabPanel: shellsAfterCode.length };
  // A Code tab that opens its panel and starts no new shell while it shows a terminal shares the page's pty host terminals.
  R.shared_terminals = codeWrappers > 0 && shellsAfterCode.length <= shellsNow.length ? "shared" : "separate";
  s7.shared.verdict = R.shared_terminals;
  R.s7 = s7;
  await codeTab.shot("shot-4b-code-tab-beside.png");

  // ---- S1 again: a server restart (same port, new token) ------------------------------------------------------------------
  const restartInfo = { shellsBeforeRestart: serverView(srvA).shells.length };
  await stopPid(srvA.pid);
  await sleep(1);
  const srvA2 = await startServer(A, port);
  srvA.pid = srvA2.pid; srvA.token = srvA2.token;
  await term.goto(`${srvA2.origin}/?tkn=${srvA2.token}&folder=${encodeURIComponent(vault)}`);
  await sleep(2);
  await waitPainted(term);
  const lay4 = await layout(term);
  restartInfo.layoutAfterRestart = lay4;
  restartInfo.holds = panelOnly(lay4);
  restartInfo.shellsAfterRestart = serverView(srvA).shells.length;
  restartInfo.tabsAfterRestart = (await tabs(term)).length;
  R.s1.serverRestart = restartInfo;
  check(restartInfo.holds, "S1: the panel-only layout holds after the server is stopped and started again on the same port", fmt(lay4));

  await term.close();
  await codeTab.close();
  await chromeA.close();
  await stopPid(srvA.pid);

  // ---- S6 / E7: force-quit and the next start's sweep -------------------------------------------------------------------------------
  R.sweep_data = await forceQuitScenario();
  R.sweep = R.sweep_data.verdict;

  // ---- S5 facts ---------------------------------------------------------------------------------------------------------------------
  const serverDir = path.join(A.cliData, "serve-web", commit);
  const du = (p) => { try { return execFileSync("du", ["-sk", p], { encoding: "utf8" }).split("\t")[0] * 1; } catch { return null; } };
  const ptyDir = path.join(serverDir, "node_modules", "node-pty");
  const natives = [];
  const walk = (d) => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.node$/.test(e.name)) natives.push(path.relative(serverDir, p)); } } catch { /* none */ } };
  walk(ptyDir);
  const licenceHead = (() => { try { return fs.readFileSync(path.join(serverDir, "LICENSE"), "utf8").split("\n").slice(0, 4).join(" ").trim(); } catch { return null; } })();
  const product = (() => { try { return JSON.parse(fs.readFileSync(path.join(serverDir, "product.json"), "utf8")); } catch { return {}; } })();
  const nodePtyPkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(ptyDir, "package.json"), "utf8")); } catch { return {}; } })();
  R.s5facts = {
    serverFolderMB: mb(du(serverDir) ?? 0), outFolderMB: mb(du(path.join(serverDir, "out")) ?? 0), nodeBinaryMB: mb(du(path.join(serverDir, "node")) ?? 0),
    nodePty: { version: nodePtyPkg.version ?? null, license: nodePtyPkg.license ?? null, nativeFiles: natives },
    licenceFileHead: licenceHead, productLicenseUrl: product.licenseUrl ?? null, productNameLong: product.nameLong ?? null,
  };

  // ---- F6 ----------------------------------------------------------------------------------------------------------------------------
  const desktopAfter = desktopListing();
  const changed = Object.keys(desktopBefore).filter((k) => JSON.stringify(desktopBefore[k]) !== JSON.stringify(desktopAfter[k]));
  R.f6 = { before: desktopBefore, changed };
  check(changed.length === 0, "F6: the desktop VS Code folders and settings listed before and after are identical", changed.join(", ") || "no change");
} catch (e) {
  console.error(neverPainted ? `a page never painted: ${e.message}` : `terminal spike could not finish: ${e.stack ?? e}`);
  await stopAll();
  process.exit(neverPainted ? 2 : 2);
}

// ---------------------------------------------------------------------------------------------------------
// S6: the stand-in "Obsidian" (a node process) starts the server the way src/server.ts does and records it in
// the pidfile; the probe SIGKILLs it; the sweep is the plugin's own `sweepOrphans`.
// ---------------------------------------------------------------------------------------------------------
async function forceQuitScenario() {
  const data = { scenarios: {} };
  for (const scenario of ["obsidian-sigkill", "server-process-killed"]) {
    const rt = prepareRuntime("b-" + scenario);
    const srvPort = await freePort();
    serverMod.createTokenFile(rt.tokenFile);
    const token = fs.readFileSync(rt.tokenFile, "utf8").trim();
    const pidfile = path.join(rt.runtime, "pids.json");
    const info = path.join(rt.runtime, "standin.json");
    const standin = path.join(rt.runtime, "standin.mjs");
    fs.writeFileSync(standin, `import { spawn } from "node:child_process";
import fs from "node:fs";
const cfg = JSON.parse(process.env.STANDIN_CFG);
const { PidFile } = await import(cfg.pidfileModule);
const child = spawn(cfg.code, cfg.args, { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: cfg.tmp } });
child.stdout.on("data", () => {}); child.stderr.on("data", () => {});
// the same record src/server.ts makes
new PidFile(cfg.pidfile).add({ pid: child.pid, label: "vscode-server", match: cfg.tokenFile, findByMatch: true, workspace: cfg.workspace, group: true, startedAt: Date.now() });
fs.writeFileSync(cfg.info, JSON.stringify({ standin: process.pid, server: child.pid }));
setInterval(() => {}, 1000);
`);
    const cfg = { code: CODE, args: serverArgs(rt, srvPort), tmp: SERVER_ENV.TMPDIR, pidfileModule: pathToFileURL(path.join(work, "plugin/pidfile.mjs")).href, pidfile, tokenFile: rt.tokenFile, workspace: vault, info };
    const host = spawn(process.execPath, [standin], { stdio: "ignore", env: { ...process.env, STANDIN_CFG: JSON.stringify(cfg) } });
    started.add(host.pid);
    const ids = await until(() => { try { return JSON.parse(fs.readFileSync(info, "utf8")); } catch { return null; } }, 20, "the stand-in to start the server");
    started.add(ids.server);
    await awaitServer(srvPort, token, "(stand-in server)");
    await sleep(3);
    const srv = { ...rt, port: srvPort, token, pid: ids.server, origin: `http://127.0.0.1:${srvPort}` };

    const br = await startChrome("b-" + scenario);
    const rendererBeforeB = await br.rendererPids();
    const ctx = await br.newContext();
    const { page } = await openWorkbench(br, ctx, srv, { extra: { ...PANEL_SETTINGS, ...PROBE_ONLY_SETTINGS } });
    await makePanelOnly(page); // terminal 1: an interactive shell at an idle prompt
    const httpPort = await freePort();
    const nohupMark = `sleep ${700 + Math.floor(Math.random() * 90)}`;
    await KEY.newTerminal(page); await sleep(4);
    await page.run(`python3 -m http.server ${httpPort} --bind 127.0.0.1`); // terminal 2: a dev server
    await sleep(3);
    await KEY.newTerminal(page); await sleep(4);
    await page.run(`nohup ${nohupMark} >/dev/null 2>&1 & disown`); // terminal 3: a detached process
    await sleep(3);
    const httpAnswers = async () => fetch(`http://127.0.0.1:${httpPort}/`, { signal: AbortSignal.timeout(2000) }).then((r) => r.status, () => 0);
    const nohupRow = () => psRows().find((r) => r.command.includes(nohupMark) && !r.command.includes("nohup "));
    const nohupBefore = nohupRow();
    if (nohupBefore) started.add(nohupBefore.pid); // started by this script (through the terminal): stopped by PID at the end
    const view0 = serverView(srv);
    if (scenario === "obsidian-sigkill") {
      // Shot 4a: `ps` run in the page's own terminal, before the force-quit
      await page.ev("document.querySelector('.terminal-wrapper.active .xterm-helper-textarea')?.focus()");
      // only this server's own tree (the pty host and everything under it), picked by pid, so that nothing else on the machine is shown
      const ownPids = (view0.ptyHost ? subtree(psRows(), view0.ptyHost.pid) : []).map((r) => r.pid);
      await page.run(`ps -axww -o pid,ppid,stat,command | grep -E '^ *(${ownPids.join("|")}) ' | cut -c1-170`);
      await sleep(3);
      await page.shot("shot-4a-ps-before-force-quit.png");
      data.psTextInTerminal = (await termText(page)).split("\n").map((l) => l.trimEnd()).filter(Boolean).map((l) => l.split(work).join("$WORK")).slice(-14);
    }
    const state = async (label) => {
      const rows = psRows();
      const wrapper = rows.find((r) => r.pid === srv.pid);
      const v = serverView({ pid: srv.pid });
      return {
        label,
        serverWrapperAlive: !!wrapper,
        serverProcessesAlive: rows.filter((r) => r.command.includes(rt.tokenFile)).length,
        interactiveShellsAlive: view0.shells.filter((s) => rows.some((r) => r.pid === s.pid)).length,
        httpServerAnswers: (await httpAnswers()) === 200,
        nohupProcessAlive: !!nohupRow(),
        nohupParent: nohupRow()?.ppid ?? null,
        treeUnderServer: table(v.tree),
        shellsUnderServer: v.shells.length,
      };
    };
    if (scenario === "obsidian-sigkill") R.memory = { ...(R.memory ?? {}), threeShellsFresh: measureMemory(srv, await br.rendererPids(), rendererBeforeB, "a fresh server, one page never reloaded, three shells (an idle prompt, an http.server, a sleep)") };
    const beforeQuit = await state("before the force-quit");
    beforeQuit.tree = table(view0.tree);
    beforeQuit.nohupRow = nohupBefore ? table([nohupBefore])[0] : null;
    beforeQuit.shellsStarted = view0.shells.length;
    if (scenario === "obsidian-sigkill") {
      process.kill(ids.standin, "SIGKILL"); // Obsidian is force-quit
    } else {
      const serverMain = view0.tree.find((r) => /server-main/.test(r.command));
      data.killedServerMain = serverMain ? serverMain.pid : null;
      if (serverMain) process.kill(serverMain.pid, "SIGKILL"); // only the server process dies
      process.kill(ids.standin, "SIGKILL");
    }
    await sleep(4);
    started.delete(host.pid);
    const afterQuit = await state("after the force-quit, before the next start");
    afterQuit.treeAfterQuit = table(psRows().filter((r) => r.command.includes(rt.tokenFile) || view0.tree.some((t) => t.pid === r.pid) || (nohupBefore && r.pid === nohupBefore.pid)));
    // the next plugin start
    const sweep = await pidfileMod.sweepOrphans(pidfile);
    await sleep(1.5);
    const afterSweep = await state("after the next start's sweep");
    afterSweep.treeAfterSweep = table(psRows().filter((r) => r.command.includes(rt.tokenFile) || view0.tree.some((t) => t.pid === r.pid) || (nohupBefore && r.pid === nohupBefore.pid)));
    if (scenario === "obsidian-sigkill") {
      // Shot 4c: after the force-quit and after the sweep the server's terminals are gone, so there is no page to run `ps` in: the
      // same `ps` rows the probe took, drawn as text in a plain page. This is a render of captured text, not a terminal.
      const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      const block = (title, rows) => `<h3>${esc(title)}</h3><pre>${rows.length ? rows.map(esc).join("\n") : "(nothing)"}</pre>`;
      const html = `<body style="background:#1e1e1e;color:#ddd;font:13px Menlo,monospace;padding:12px"><h2>ps rows (pid ppid state rss command) taken by the probe: this is text, not a terminal</h2>` +
        block("before the force-quit", beforeQuit.tree) + block("after the force-quit, before the next start", afterQuit.treeAfterQuit) + block("after the next start's sweep", afterSweep.treeAfterSweep);
      const textPage = await br.newPage(undefined, "data:text/html;charset=utf-8," + encodeURIComponent(html));
      await sleep(1);
      await textPage.shot("shot-4c-ps-before-and-after-text.png");
      await textPage.close();
    }
    const entry = (e) => ({ pid: e.pid, label: e.label });
    const sweepResult = { killed: sweep.killed.map(entry), gone: sweep.gone.map(entry), reused: sweep.reused.map(entry), stragglers: sweep.stragglers, corrupt: sweep.corrupt };
    data.scenarios[scenario] = { beforeQuit, afterQuit, sweepResult, afterSweep };
    await br.close();
    // clean up what survived: the nohup process (started through the terminal by this script), and anything of ours left
    if (nohupBefore && isAlive(nohupBefore.pid)) await stopPid(nohupBefore.pid);
    for (const r of psRows().filter((r) => r.command.includes(rt.tokenFile))) if (isAlive(r.pid)) { try { process.kill(r.pid, "SIGKILL"); } catch { /* gone */ } }
    started.delete(ids.server);
    started.delete(nohupBefore?.pid);
    log(`S6 ${scenario}:`, JSON.stringify({ afterQuit: { server: afterQuit.serverWrapperAlive, shells: afterQuit.interactiveShellsAlive, http: afterQuit.httpServerAnswers, nohup: afterQuit.nohupProcessAlive }, sweep: sweepResult, afterSweep: { server: afterSweep.serverProcessesAlive, shells: afterSweep.interactiveShellsAlive, http: afterSweep.httpServerAnswers, nohup: afterSweep.nohupProcessAlive } }));
  }
  const s1 = data.scenarios["obsidian-sigkill"];
  const shellsFound = s1.afterQuit.interactiveShellsAlive > 0 && s1.afterSweep.interactiveShellsAlive === 0;
  const httpFound = s1.afterQuit.httpServerAnswers && !s1.afterSweep.httpServerAnswers;
  const serverFound = s1.afterQuit.serverProcessesAlive > 0 && s1.afterSweep.serverProcessesAlive === 0;
  data.survivedForceQuit = { server: s1.afterQuit.serverProcessesAlive > 0, interactiveShell: s1.afterQuit.interactiveShellsAlive > 0, httpServer: s1.afterQuit.httpServerAnswers, nohupDisown: s1.afterQuit.nohupProcessAlive };
  data.survivedSweep = { server: s1.afterSweep.serverProcessesAlive > 0, interactiveShell: s1.afterSweep.interactiveShellsAlive > 0, httpServer: s1.afterSweep.httpServerAnswers, nohupDisown: s1.afterSweep.nohupProcessAlive };
  data.verdict = serverFound && shellsFound && httpFound ? "finds_shells" : serverFound && (shellsFound || httpFound) ? "partial" : "misses_shells";
  return data;
}

// =========================================================================================================
// report
// =========================================================================================================
await stopAll();
R.checks = { failed: failures };
R.frontMatter = {
  panel_only: R.s1.measured && R.s1.reloadHolds && R.s1.recreateHolds ? "works" : "fails",
  reattach: R.reattach, sweep: R.sweep, cwd_open: R.cwd_open, live_shells: R.live_shells, focus_bridge: R.focus_bridge, shared_terminals: R.shared_terminals,
};
fs.writeFileSync(path.join(outDir, "terminal-spike-result.json"), JSON.stringify(R, null, 2));
log(`\nfront matter: ${JSON.stringify(R.frontMatter)}`);
log(`result: ${path.join(outDir, "terminal-spike-result.json")}\nscreenshots: ${outDir}`);
fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
