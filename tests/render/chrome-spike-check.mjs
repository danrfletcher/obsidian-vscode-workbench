/**
 * The chrome spike (PR-1 of "Code tab shows just the editor"): measures, on one real VS Code web server, the five
 * questions S1 to S5 of docs/spike-chrome.md and prints them as a table.
 *
 *   S1  which route hides each part of the workbench (side bar, secondary side bar, activity bar, status bar, title
 *       bar, panel, VS Code tab strip, breadcrumb row), tried in this order: Zen Mode (fullScreen off,
 *       silentNotifications false, centerLayout false, hideLineNumbers false), `workbench.editor.showTabs: none`,
 *       `breadcrumbs.enabled: false`, other settings, saved layout state, then a page script. Each route is applied
 *       on top of the plugin's own settings and measured from computed layout (getBoundingClientRect). EVERY route is
 *       then measured again after a reload of the same profile and on a copy of a profile that already holds saved
 *       layout state (the side bar, panel and secondary side bar opened and saved), not only the best combination.
 *   S2  can a file opened from inside the editor be caught (Go to Definition, Cmd+P), and what does VS Code do with
 *       no tab strip; how does a line number travel, how is an already-open editor moved to a line.
 *   S3  can Cmd/Ctrl B, J, K Z and W be disabled with keybinding `-command` entries, do the two bridged chords
 *       still reach the page script of src/hotkey/hotkey-bridge.ts, and do the entries survive the keybinding seed.
 *   S4  does the full workbench show before hiding applies (timestamped frames), is a palette command that reveals a
 *       bar undone.
 *   S5  which signal says "this editor holds unsaved edits" with the tab strip hidden.
 *
 * Not part of `npm test`: it needs a VS Code build with `serve-web`, a cached VS Code server for that build and
 * Google Chrome. It starts `serve-web` on a free loopback port and headless Chrome on free debugging ports, drives the
 * page over the DevTools protocol (Runtime.evaluate, Input.dispatchKeyEvent, console messages: never fetch, a
 * WebSocket of its own or a new port), and stops what it started, by PID, at the end.
 *
 *   npm run check:chrome-spike [outDir]
 *
 * Env: CODE_CLI (the build's `code` script), CLI_DATA_SRC (a --cli-data-dir that already holds the server for that
 * build; cloned into the scratch dir, never written to), ALLOW_DOWNLOAD=1 (let serve-web download the server for the
 * installed build into the scratch dir; CLI_DATA_SAVE=<dir> keeps it for the next run), COMMIT_ID and VERSION_LABEL (measure another build's cached server through this
 * launcher), CHROME, SERVER_TMPDIR (default /tmp, see the comment at the spawn),
 * BUILD_LABEL (names the files and screenshots, default the build's version), ONLY (a comma list of S1,S2,S3,S4,S5 to
 * run a part), VIEWPORT (default 1000x700, about the size of an Obsidian pane).
 *
 * Writes into outDir: chrome-spike-<label>.json (every measurement), PR-1-S1-<label>.png ... PR-1-S5-<label>.png (dirty state) and PR-1-S5-<label>-saved.png.
 *
 * Exit codes (as check:workbench): 0 every question was answered and the side bar can be hidden on this build,
 * 1 a check failed (a question gave no answer, the side bar cannot be hidden by any route, a non-loopback connection
 * or a new host was seen, a desktop VS Code file changed), 2 the check could not run (a missing tool, no server for
 * the build, a server that answers with an error, a page that never painted).
 */
import { build } from "esbuild";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BREADCRUMBS_OFF, CLOSE_ACTIVE_CHORD, CLOSE_OTHERS_CHORD, DISABLE_ENTRIES, EDITOR_NOW, FLASH_RECORDER, GOTO_LINE_SYNTHETIC, LAYOUT_DUMP, LAYOUT_SEED, MEASURE, OTHER, PAGE_CLOSE_SCRIPT, PAGE_CSS_SCRIPT, PART_NAMES, READY, S2_WATCH, TABS_NONE, USER_CLOSE_CHORDS, ZEN,
} from "./chrome-spike-scripts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CODE = process.env.CODE_CLI ?? "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CLI_DATA_SRC = process.env.CLI_DATA_SRC;
const ALLOW_DOWNLOAD = process.env.ALLOW_DOWNLOAD === "1";
const ONLY = (process.env.ONLY ?? "S1,S2,S3,S4,S5").split(",").map((s) => s.trim());
const [VW, VH] = (process.env.VIEWPORT ?? "1000x700").split("x").map(Number);
for (const [name, f] of [["CODE_CLI", CODE], ["CHROME", CHROME]]) {
  if (!f || !fs.existsSync(f)) {
    console.error(`chrome spike needs ${name}${f ? ` (${f} does not exist)` : " (not set)"}`);
    process.exit(2);
  }
}
const [hostVersion, hostCommit] = execFileSync(CODE, ["--version"], { encoding: "utf8" }).trim().split("\n");
// COMMIT_ID / VERSION_LABEL measure another build's server through the same launcher (one `code` can serve any cached commit).
const commit = process.env.COMMIT_ID ?? hostCommit;
const version = process.env.VERSION_LABEL ?? hostVersion;
const label = process.env.BUILD_LABEL ?? version;
const held = CLI_DATA_SRC && fs.existsSync(path.join(CLI_DATA_SRC, "serve-web"))
  ? fs.readdirSync(path.join(CLI_DATA_SRC, "serve-web")).filter((n) => /^[0-9a-f]{40}$/.test(n))
  : [];
const haveServer = held.includes(commit);
if (!haveServer && !ALLOW_DOWNLOAD) {
  console.error(
    `chrome spike cannot run: the installed VS Code (${CODE}) is ${version} (server commit ${commit}), and ` +
      (CLI_DATA_SRC
        ? `CLI_DATA_SRC (${CLI_DATA_SRC}) ${held.length ? `holds a server only for ${held.join(", ")}` : "holds no cached server"}.`
        : "CLI_DATA_SRC is not set.") +
      `\nSet CLI_DATA_SRC to a --cli-data-dir whose serve-web/ folder holds ${commit}, or set ALLOW_DOWNLOAD=1 to let ` +
      "serve-web download that server from Microsoft into the scratch directory.",
  );
  process.exit(2);
}

const IS_MAC = process.platform === "darwin";
const MOD = IS_MAC ? 4 : 2; // Cmd on a Mac, Ctrl elsewhere (CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8)
const CTRL = 2, SHIFT = 8, ALT = 1;
const KEYS = { b: 66, j: 74, k: 75, z: 90, w: 87, o: 79, p: 80, g: 71, s: 83, f12: 123, f1: 112, esc: 27, enter: 13, backtick: 192, left: 37, right: 39, home: 36, end: 35, "1": 49, "2": 50, "3": 51, "4": 52, "5": 53 };

const work = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "chrome-spike-"));
const outDir = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "chrome-spike-shots-")));
fs.mkdirSync(outDir, { recursive: true });

const started = []; // every PID this script started or found listening on its own port; stopped at the end, nothing else is
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const failures = [];
const check = (ok, what, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail === undefined ? "" : `  (${detail})`}`);
  if (!ok) failures.push(what);
};

function psRows() {
  return execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
}
function descendants(pid) {
  const rows = psRows();
  const out = [];
  const walk = (p) => {
    for (const [c, pp] of rows) if (pp === p) { walk(c); out.push(c); }
  };
  walk(pid);
  return out;
}
function stopPid(root_) {
  for (const pid of [...descendants(root_), root_]) {
    try { process.kill(pid); } catch { /* already gone */ }
  }
  const i = started.indexOf(root_);
  if (i >= 0) started.splice(i, 1);
}
function stopAll() {
  for (const p of [...started]) stopPid(p);
}
process.on("exit", stopAll);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));
// A probe that cannot finish is "could not run" (exit 2), after the exit handler has stopped what it started.
for (const ev of ["uncaughtException", "unhandledRejection"]) process.on(ev, (e) => { console.error(`chrome spike could not finish: ${e?.stack ?? e}`); process.exit(2); });

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

// The plugin's own code, bundled for node.
await build({
  entryPoints: {
    settings: path.join(root, "src/settings.ts"),
    "dirty-script": path.join(root, "src/dirty-script.ts"),
    "hotkey-bridge": path.join(root, "src/hotkey/hotkey-bridge.ts"),
    paths: path.join(root, "src/paths.ts"),
    "chrome-settings": path.join(root, "src/chrome-settings.ts"),
    "trust-seed": path.join(root, "src/trust/trust-seed.ts"),
  },
  bundle: true, format: "esm", platform: "node", outdir: path.join(work, "plugin"), outExtension: { ".js": ".mjs" }, logLevel: "error",
});
const load = (n) => import(pathToFileURL(path.join(work, `plugin/${n}.mjs`)).href);
const settings = await load("settings");
const { DIRTY_SCRIPT, fileDirtyScript } = await load("dirty-script");
const bridge = await load("hotkey-bridge");
const paths = await load("paths");
const { chromeSettings } = await load("chrome-settings");
const { buildTrustSeedScript } = await load("trust-seed");

// --- F1: the real desktop VS Code files, before ------------------------------------------------------
const REAL_FILES = [];
for (const app of ["Code - Insiders", "Code"]) {
  for (const f of ["settings.json", "keybindings.json"]) REAL_FILES.push(path.join(os.homedir(), "Library/Application Support", app, "User", f));
}
for (const dir of [".vscode-insiders", ".vscode"]) REAL_FILES.push(path.join(os.homedir(), dir, "extensions/extensions.json"));
const sum = (f) => (fs.existsSync(f) ? createHash("sha256").update(fs.readFileSync(f)).digest("hex") : "absent");
const realBefore = Object.fromEntries(REAL_FILES.map((f) => [f, sum(f)]));

// --- fixtures ----------------------------------------------------------------------------------------
const vault = path.join(work, "vault");
fs.mkdirSync(vault, { recursive: true });
fs.writeFileSync(path.join(vault, "a.js"), 'import { helper } from "./b.js";\n\nconst x = helper(1);\nconsole.log(x);\n');
fs.writeFileSync(path.join(vault, "b.js"), "// b.js\n\n\n\nexport function helper(n) {\n  return n + 1;\n}\n");
fs.writeFileSync(path.join(vault, "c.txt"), "plain text file\nline two\n");
fs.writeFileSync(path.join(vault, "link.md"), "See [the helper](./b.js#L5) for details.\n");

// --- the server --------------------------------------------------------------------------------------
const runtime = path.join(work, "runtime");
const serverData = path.join(runtime, "server-data");
fs.mkdirSync(serverData, { recursive: true });
const cliData = path.join(runtime, "cli-data");
if (haveServer) fs.cpSync(CLI_DATA_SRC, cliData, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
else fs.mkdirSync(cliData, { recursive: true });
const token = "tok" + "x".repeat(24);
const tokenFile = path.join(runtime, "token");
fs.writeFileSync(tokenFile, token, { mode: 0o600 });
const port = await freePort();
const server = spawn(
  CODE,
  ["serve-web", "--host", "127.0.0.1", "--port", String(port), "--connection-token-file", tokenFile, "--server-data-dir", serverData, "--cli-data-dir", cliData, "--disable-telemetry", "--commit-id", commit, "--accept-server-license-terms"],
  {
    stdio: ["ignore", fs.openSync(path.join(work, "server.log"), "w"), "ignore"],
    // The server listens on a unix socket `<TMPDIR>/code-insiders-<uuid>`; macOS caps socket paths at 104 characters
    // and a scratch dir is longer than that, so the server (and only the server) gets a short TMPDIR.
    env: { ...process.env, TMPDIR: process.env.SERVER_TMPDIR ?? "/tmp" },
  },
);
started.push(server.pid);
console.log(`[server] ${version} (${commit.slice(0, 10)}) pid ${server.pid} on 127.0.0.1:${port}`);
let answered;
for (let i = 0; ; i++) {
  answered = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.status, () => 0);
  if (answered === 403 || answered === 302 || answered === 200) break; // 202 is "downloading"
  if (i === (haveServer ? 60 : 400)) { console.error(`server did not come up (answered ${answered}; see ${path.join(work, "server.log")})`); process.exit(2); }
  await sleep(1);
}
// The launcher hands the work to child processes that leave its process group: record whoever listens on OUR port
// (and its ancestors up to init), so the end-of-run stop reaches them by PID.
function recordListeners() {
  let pids = [];
  try { pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number); } catch { /* none */ }
  const rows = new Map(psRows());
  for (const p of pids) {
    for (let q = p; q > 1 && q !== process.pid; q = rows.get(q) ?? 0) if (!started.includes(q)) started.push(q);
  }
}
recordListeners();
await sleep(3);
const serverTree = () => [...new Set(started.flatMap((p) => [p, ...descendants(p)]))];

// --- the browser -------------------------------------------------------------------------------------
const KNOWN_HOSTS = new Set(["127.0.0.1", "main.vscode-cdn.net", "marketplace.visualstudio.com"]);
const hostsSeen = new Set();
const consoleLog = []; // every console line of every page, with a timestamp

async function browser(name, opts = {}) {
  const cdpPort = await freePort();
  const profile = opts.profileDir ?? path.join(work, "chrome-" + name);
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-background-networking", "about:blank"], { stdio: "ignore" });
  started.push(chrome.pid);
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(0.5);
    page = (await fetch(`http://127.0.0.1:${cdpPort}/json`).then((r) => r.json(), () => [])).find((t) => t.type === "page");
  }
  if (!page) throw new Error("Chrome did not start");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  let timeouts = 0;
  const pend = new Map();
  const handlers = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) pend.get(d.id)(d);
    else if (d.method) for (const h of handlers.get(d.method) ?? []) h(d.params);
  };
  const on = (method, fn) => handlers.set(method, [...(handlers.get(method) ?? []), fn]);
  // A DevTools call that never answers (a page that navigates away mid-evaluation) must not hang the whole probe.
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id;
    const timer = setTimeout(() => {
      pend.delete(i);
      if (++timeouts >= 3) throw new Error(`the page stopped answering (${method}); a dialog may be open`);
      res({ error: { message: `timeout: ${method}` } });
    }, 30000);
    pend.set(i, (d) => { clearTimeout(timer); timeouts = 0; res(d); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async (e) => {
    const r = (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result;
    if (r?.exceptionDetails) return { __error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
    return r?.result?.value;
  };
  const logs = [];
  on("Runtime.consoleAPICalled", (p) => {
    const text = (p.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
    logs.push({ t: Date.now(), text });
    consoleLog.push({ browser: name, t: Date.now(), text });
  });
  // A native dialog (the workbench's "leave site?" prompt on a reload) blocks every other call: accept it and record it.
  on("Page.javascriptDialogOpening", (p) => {
    results.dialogs.push({ browser: name, type: p.type, message: p.message });
    void send("Page.handleJavaScriptDialog", { accept: true });
  });
  on("Network.requestWillBeSent", (p) => {
    try { const h = new URL(p.request.url).hostname; if (h) hostsSeen.add(h); } catch { /* data: urls and the like */ }
  });
  const key = async (k, code, vk, modifiers = 0) => {
    for (const type of ["rawKeyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, modifiers });
  };
  const chord = async (name_, modifiers = 0) => {
    const n = name_.toLowerCase();
    const k = KEYS[n];
    const code = n === "backtick" ? "Backquote" : /^[a-z]$/.test(n) ? "Key" + n.toUpperCase() : /^[0-9]$/.test(n) ? "Digit" + n : n === "f12" ? "F12" : n === "f1" ? "F1" : n === "esc" ? "Escape" : n === "enter" ? "Enter" : n === "home" ? "Home" : n === "end" ? "End" : n === "right" ? "ArrowRight" : n === "left" ? "ArrowLeft" : n;
    const keyName = n === "backtick" ? "`" : n === "esc" ? "Escape" : n === "enter" ? "Enter" : n === "f12" ? "F12" : n === "f1" ? "F1" : n === "home" ? "Home" : n === "end" ? "End" : n === "right" ? "ArrowRight" : n === "left" ? "ArrowLeft" : n;
    await key(keyName, code, k, modifiers);
  };
  const shot = async (file) => {
    const s = await send("Page.captureScreenshot", { format: "png" });
    if (!s.result) return null;
    fs.writeFileSync(path.join(outDir, file), Buffer.from(s.result.data, "base64"));
    return file;
  };
  const palette = async (command) => {
    await chord("f1");
    await sleep(0.8);
    await send("Input.insertText", { text: command });
    await sleep(0.8);
    await chord("enter");
    await sleep(1.2);
  };
  const navigate = async (url) => {
    await send("Page.navigate", { url });
  };
  // Puts the caret in the visible editor's input area (a headless page starts with no focus in the editor).
  const focusEditor = async () => ev(`(() => { const t = [...document.querySelectorAll('.monaco-editor textarea.inputarea')].find((e) => { const r = e.getBoundingClientRect(); return true; }); if (!t) return false; t.focus(); return document.activeElement === t; })()`);
  // Types text into the visible editor like a user: click into it, then insert; read the line back and retry, because a
  // headless page often has no focus in the editor on the first try. Returns whether the text is in the editor.
  const typeInEditor = async (text) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const box = await ev(`(() => { const e = [...document.querySelectorAll('.monaco-editor .view-lines')].find((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; }); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + 10) }; })()`);
      if (box && !box.__error) {
        for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
      }
      await sleep(0.5);
      await focusEditor();
      await send("Input.insertText", { text });
      await sleep(1);
      const typed = await ev(`(() => { const e = document.querySelector('.monaco-editor .view-lines'); return !!e && e.innerText.includes(${JSON.stringify(text)}); })()`);
      if (typed === true) return true;
      if (process.env.DEBUG_TYPE) console.log("DEBUG typeInEditor", attempt, JSON.stringify({ box, typed, active: await ev(`document.activeElement && document.activeElement.className`), dialog: await ev(`(document.querySelector('.monaco-dialog-box')||{}).innerText`), text: await ev(`(document.querySelector('.monaco-editor .view-lines')||{}).innerText`) }));
    }
    return false;
  };
  // The editors VS Code holds in the group, read from the "Show All Editors" quick pick (the tab strip is the only other place that lists them).
  const listEditors = async (withMarks = false) => {
    await chord("f1");
    await sleep(0.8);
    await send("Input.insertText", { text: "Show All Editors By Appearance" });
    await sleep(1);
    await chord("enter");
    await sleep(1.2);
    const rows = await ev(`[...document.querySelectorAll('.quick-input-list .monaco-list-row')].map((r) => ({ label: (r.getAttribute('aria-label') || r.innerText).replace(/\\s+/g, ' ').trim(), marked: /dirty|unsaved|\\u25cf|modified/i.test(r.outerHTML) }))`);
    await chord("esc");
    await sleep(0.4);
    await chord("esc");
    await sleep(0.4);
    const list = Array.isArray(rows) ? rows : [];
    return withMarks ? list : list.map((r) => r.label);
  };
  // Loads a url and waits until an editor has painted.
  const load = async (url, settle = 3) => {
    await send("Page.navigate", { url });
    for (let i = 0; i < 60; i++) {
      await sleep(0.5);
      if ((await ev(READY)) === true) break;
    }
    await sleep(settle);
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Emulation.setDeviceMetricsOverride", { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
  const close = () => {
    try { ws.close(); } catch { /* closed */ }
    stopPid(chrome.pid);
  };
  return { send, ev, key, chord, shot, palette, navigate, focusEditor, typeInEditor, listEditors, load, on, logs, close, profile, pid: chrome.pid };
}

// --- settings of the routes --------------------------------------------------------------------------
const OVERLAY = { ...chromeSettings() }; // what the plugin writes today

let runNo = 0;
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

/**
 * One load of the workbench in a fresh (or given) browser profile.
 * spec: { name, settings, keybindings (array appended after `userKeybindings`), userKeybindings (array the user's copy holds),
 *         layoutRows, file, payload (a full URI override), enterZen, pageScript, flash, profileDir, keepOpen, copyId }
 */
async function session(spec) {
  const name = `${++runNo}-${spec.name}`;
  console.log(`  .. load ${name}`);
  const machine = { ...OVERLAY, "workbench.colorTheme": "Light Modern", ...(spec.settings ?? {}) };
  // The Machine file is regenerated by the plugin's own writer, then the route's keys are laid over it.
  const machineFile = settings.writeMachineSettings(serverData, { dark: false });
  fs.writeFileSync(machineFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(machineFile, "utf8")), ...(spec.settings ?? {}) }, null, 2));
  const b = await browser(name, { profileDir: spec.profileDir });
  if (spec.flash) await b.send("Page.addScriptToEvaluateOnNewDocument", { source: FLASH_RECORDER });
  // 1. the server's bare origin, so the seed can write the browser profile's IndexedDB (as the Code tab does)
  await b.navigate(`http://127.0.0.1:${port}/`);
  await sleep(1.5);
  const kb = [...(spec.userKeybindings ?? []), ...(spec.keybindings ?? [])];
  const copy = { id: spec.copyId ?? `probe-${name}`, settings: spec.userSettings ?? {}, keybindingsBase64: kb.length ? b64(JSON.stringify(kb)) : null };
  const seeded = await b.ev(settings.buildBrowserSeedScript({ ...settings.BROWSER_APP_SETTINGS, ...machine }, copy));
  let layoutN = null;
  if (spec.layoutRows) layoutN = await b.ev(LAYOUT_SEED(spec.layoutRows));
  // The vault folder's Workspace Trust record, as the plugin's trust seed writes it when `trustVaultFolder` is on (R2: Go to
  // Definition is asked for in a trusted workspace as well as the untrusted default).
  let trustOutcome = null;
  if (spec.trust) {
    const origin = `http://127.0.0.1:${port}`;
    trustOutcome = await b.ev(buildTrustSeedScript({ origin, folderUri: paths.buildFileUri(origin, vault), heldPorts: [] }));
  }
  // 2. the workbench itself
  const file = spec.file ?? "a.js";
  const uri = spec.payload ?? paths.buildFileUri(`http://127.0.0.1:${port}`, path.join(vault, file));
  const url = `http://127.0.0.1:${port}/?tkn=${token}&folder=${encodeURIComponent(vault)}${spec.noPayload ? "" : `&payload=${encodeURIComponent(JSON.stringify([["openFile", uri]]))}`}`;
  const t0 = Date.now();
  await b.navigate(url);
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    await sleep(0.5);
    ready = (await b.ev(READY)) === true;
  }
  const readyMs = Date.now() - t0;
  if (!ready) {
    await b.shot(`debug-${name}.png`);
    b.close();
    return { name, ready: false, seeded, readyMs };
  }
  await sleep(1.5);
  // A modal dialog (the S4 palette run opens the panel, which asks to create a terminal: "Do you trust the authors...",
  // and the server keeps that terminal for the next load) takes the focus from the editor. Close it, and say so.
  const dialog = await b.ev(`(() => { const d = document.querySelector('.monaco-dialog-box'); if (!d) return null; const t = d.innerText.replace(/\\s+/g, ' ').trim(); const c = [...d.querySelectorAll('a.monaco-button')].find((x) => /^Cancel$/.test(x.innerText.trim())); if (c) c.click(); return t; })()`);
  if (dialog) { results.notes.push(`${name}: a VS Code dialog was open on load and was cancelled: ${dialog.slice(0, 160)}`); await sleep(0.5); }
  const ctx = { b, name, seeded, layoutN, readyMs, url, trustOutcome };
  if (spec.relay) await b.ev(spec.relay);
  if (spec.enterZen) await b.palette("View: Toggle Zen Mode");
  if (spec.pageScript) ctx.pageScriptResult = await b.ev(spec.pageScript);
  await sleep(spec.settleSeconds ?? 2);
  ctx.measure = await b.ev(MEASURE);
  return ctx;
}

const hiddenParts = (m) => PART_NAMES.filter((p) => !m.parts[p].shown);
const px = (m, p) => `${m.parts[p].w}x${m.parts[p].h}${m.parts[p].shown ? "" : m.parts[p].focusable > 0 ? " (0px, focusable)" : ""}`;
const summary = (m) => PART_NAMES.map((p) => `${p} ${px(m, p)}`).join("; ");
const results = { build: label, version, commit, platform: process.platform, viewport: `${VW}x${VH}`, hostsSeen: [], dialogs: [], s1: {}, s2: {}, s3: {}, s4: {}, s5: {}, notes: [] };
let neverPainted = false;
const notRendered = (what) => { neverPainted = true; check(false, `${what}: the page did not render (does the server match the build, ${commit}?)`); };

// =====================================================================================================
// S1
// =====================================================================================================
let bestSpec = null;
if (ONLY.includes("S1")) {
  console.log("\n== S1: which route hides each part ==");
  const routes = [
    { id: "R0 plugin settings (today)", spec: { name: "r0" } },
    { id: "R1 Zen Mode", spec: { name: "r1-zen", settings: ZEN, enterZen: true, userKeybindings: [], keybindings: DISABLE_ENTRIES.filter((e) => /toggleZenMode|exitZenMode/.test(e.command)) } },
    { id: "R2 showTabs none", spec: { name: "r2-tabs", settings: TABS_NONE } },
    { id: "R3 breadcrumbs.enabled false", spec: { name: "r3-crumbs", settings: BREADCRUMBS_OFF } },
    { id: "R4 other settings", spec: { name: "r4-other", settings: OTHER } },
  ];
  results.s1.routes = {};
  // Every route is measured three times: on a fresh profile, again after a reload of that profile (page-script routes run
  // their script again, as the plugin would on every load, and are also measured before the script runs), and on a copy of a
  // profile that already holds saved layout state.
  const waitReady = async (b, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      await sleep(0.5);
      if ((await b.ev(READY)) === true) return true;
    }
    return false;
  };
  const reloadMeasure = async (s, spec) => {
    await s.b.navigate(s.url);
    if (!(await waitReady(s.b))) return { ready: false };
    await sleep(spec.enterZen ? 10 : 6); // Zen is not entered again: `zenMode.restore` has to bring it back by itself
    const out = { ready: true };
    if (spec.pageScript) {
      const before = await s.b.ev(MEASURE);
      out.beforeScript = { parts: before.parts, hidden: hiddenParts(before) };
      await s.b.ev(spec.pageScript);
      await sleep(3);
    }
    const m = await s.b.ev(MEASURE);
    return { ...out, parts: m.parts, editor: m.editor, hidden: hiddenParts(m) };
  };
  const priorDir = path.join(work, "chrome-prior");
  let priorState = null; // null: not made yet; true: made; false: it did not render
  const ensurePrior = async () => {
    if (priorState !== null) return priorState;
    // A profile that already shows everything: the baseline settings, then the secondary side bar and the panel opened and saved.
    const prior = await session({ name: "prior-state", profileDir: priorDir });
    priorState = prior.ready !== false;
    if (priorState) {
      for (const c of ["View: Toggle Secondary Side Bar Visibility", "View: Toggle Panel Visibility"]) await prior.b.palette(c);
      await sleep(2);
      const m = await prior.b.ev(MEASURE);
      results.s1.priorState = { parts: m.parts, editor: m.editor, hidden: hiddenParts(m) };
      console.log(`[prior state saved] hidden: ${hiddenParts(m).join(", ") || "none"} | ${summary(m)}`);
      prior.b.close();
    }
    return priorState;
  };
  let savedNo = 0;
  const onSavedProfile = async (id, spec) => {
    if (!(await ensurePrior())) return null;
    const copy = path.join(work, `chrome-saved-${++savedNo}`);
    fs.cpSync(priorDir, copy, { recursive: true, filter: (f) => !path.basename(f).startsWith("Singleton") });
    const s = await session({ ...spec, name: `${spec.name}-saved`, profileDir: copy, settleSeconds: Math.max(spec.settleSeconds ?? 2, 3) });
    if (s.ready === false) { notRendered(`S1 ${id} on a profile with saved layout`); return { ready: false }; }
    const m = s.measure;
    console.log(`[${id}: profile with saved layout] hidden: ${hiddenParts(m).join(", ") || "none"} | ${summary(m)}`);
    s.b.close();
    return { ready: true, parts: m.parts, editor: m.editor, hidden: hiddenParts(m) };
  };
  // Records the reload and saved-profile measurements of a route whose first-load session is `s`; closes `s`.
  const repeatRoute = async (id, spec, s) => {
    const rel = await reloadMeasure(s, spec);
    results.s1.routes[id].afterReload = rel;
    console.log(`[${id}: after reload] ${rel.ready ? `hidden: ${rel.hidden.join(", ") || "none"} | ${summary(rel)}${rel.beforeScript ? ` | before the page script ran again, hidden: ${rel.beforeScript.hidden.join(", ") || "none"}` : ""}` : "the page did not render"}`);
    s.b.close();
    results.s1.routes[id].savedProfile = await onSavedProfile(id, spec);
  };
  for (const r of routes) {
    const s = await session(r.spec);
    if (!s.ready && s.ready !== undefined) { notRendered(`S1 ${r.id}`); continue; }
    await s.b.shot(`debug-S1-${r.spec.name}.png`);
    results.s1.routes[r.id] = { parts: s.measure.parts, editor: s.measure.editor, hidden: hiddenParts(s.measure), lineNumbers: s.measure.lineNumbers, centered: s.measure.centered, classes: s.measure.workbenchClasses, toasts: s.measure.toasts, seeded: s.seeded };
    console.log(`[${r.id}] hidden: ${hiddenParts(s.measure).join(", ") || "none"} | editor ${s.measure.editor.w}x${s.measure.editor.h} | line numbers ${s.measure.lineNumbers} centered ${s.measure.centered} | ${summary(s.measure)}`);
    await repeatRoute(r.id, r.spec, s);
  }

  // R5: saved layout state. The parts are closed with the seeded close chords (the palette cannot be trusted to pick the
  // right "Close ..." entry), then the workbench's state database is dumped and replayed into a brand new profile.
  const closeSpec = { name: "r5-discover", userKeybindings: [], keybindings: USER_CLOSE_CHORDS, pageScript: PAGE_CLOSE_SCRIPT(false) };
  {
    const s = await session(closeSpec);
    if (!s.ready && s.ready !== undefined) notRendered("S1 layout discovery");
    else {
      await sleep(2);
      const closed = await s.b.ev(MEASURE);
      const rows = await s.b.ev(LAYOUT_DUMP);
      results.s1.layoutKeys = (rows ?? []).map((r) => ({ db: r.db.replace(/-[0-9a-f]{8,}$/, "-<workspace>"), key: r.key, value: typeof r.value === "string" ? r.value.slice(0, 80) : r.value }));
      results.s1.layoutRows = rows;
      console.log(`[R5 layout state] closed with the close chords: hidden ${hiddenParts(closed).join(", ")}; ${rows?.length ?? 0} layout-looking keys in IndexedDB`);
      const R5 = "R5 layout state: parts closed with the close chords";
      results.s1.routes[R5] = { parts: closed.parts, editor: closed.editor, hidden: hiddenParts(closed) };
      // 5a: the same profile after a reload, with no page script
      await s.b.navigate(s.url);
      await sleep(12);
      const reloaded = await s.b.ev(MEASURE);
      results.s1.routes["R5a layout state, same profile after reload (no script)"] = { parts: reloaded.parts, editor: reloaded.editor, hidden: hiddenParts(reloaded) };
      results.s1.routes[R5].afterReload = { ready: true, parts: reloaded.parts, editor: reloaded.editor, hidden: hiddenParts(reloaded) };
      console.log(`[R5a same profile, reload] hidden: ${hiddenParts(reloaded).join(", ")} | ${summary(reloaded)}`);
      s.b.close();
      // the same discovery route on a copy of the profile that already holds saved layout state
      results.s1.routes[R5].savedProfile = await onSavedProfile(R5, closeSpec);
      // 5b: the keys written into a brand new profile before the workbench loads
      if (rows?.length) {
        const spec5b = { name: "r5-seed", layoutRows: rows };
        const s2 = await session(spec5b);
        if (!s2.ready && s2.ready !== undefined) notRendered("S1 layout seed");
        else {
          const R5B = "R5b layout state written into a fresh profile";
          results.s1.routes[R5B] = { parts: s2.measure.parts, editor: s2.measure.editor, hidden: hiddenParts(s2.measure), keysWritten: s2.layoutN };
          console.log(`[R5b fresh profile, keys written] hidden: ${hiddenParts(s2.measure).join(", ")} | ${summary(s2.measure)}`);
          await repeatRoute(R5B, spec5b, s2);
        }
      }
    }
  }

  // R6: page script. 6a presses the close commands through seeded chords; 6b hides with CSS.
  {
    const spec6a = { name: "r6a-close", userKeybindings: [], keybindings: USER_CLOSE_CHORDS.concat([CLOSE_OTHERS_CHORD]), pageScript: PAGE_CLOSE_SCRIPT(false) };
    const s = await session(spec6a);
    if (!s.ready && s.ready !== undefined) notRendered("S1 page script");
    else {
      const R6A = "R6a page script: close commands via seeded chords";
      results.s1.routes[R6A] = { parts: s.measure.parts, editor: s.measure.editor, hidden: hiddenParts(s.measure), pressed: s.pageScriptResult };
      console.log(`[R6a close commands] pressed ${s.pageScriptResult} chords; hidden: ${hiddenParts(s.measure).join(", ")} | ${summary(s.measure)}`);
      await repeatRoute(R6A, spec6a, s);
    }
    const spec6b = { name: "r6b-css", pageScript: PAGE_CSS_SCRIPT };
    const s2 = await session(spec6b);
    if (!s2.ready && s2.ready !== undefined) notRendered("S1 CSS");
    else {
      const R6B = "R6b page script: CSS display none";
      results.s1.routes[R6B] = { parts: s2.measure.parts, editor: s2.measure.editor, hidden: hiddenParts(s2.measure) };
      console.log(`[R6b CSS] hidden: ${hiddenParts(s2.measure).join(", ")} | editor ${s2.measure.editor.w}x${s2.measure.editor.h} | ${summary(s2.measure)}`);
      await repeatRoute(R6B, spec6b, s2);
    }
  }

  // The settings routes together (R2 + R3 + R4): what settings alone achieve.
  const SETTINGS_ALL = { ...TABS_NONE, ...BREADCRUMBS_OFF, ...OTHER };
  {
    const spec234 = { name: "r234", settings: SETTINGS_ALL };
    const s = await session(spec234);
    if (!s.ready && s.ready !== undefined) notRendered("S1 settings together");
    else {
      const R234 = "R2+R3+R4 settings together";
      results.s1.routes[R234] = { parts: s.measure.parts, editor: s.measure.editor, hidden: hiddenParts(s.measure) };
      console.log(`[R2+R3+R4 together] hidden: ${hiddenParts(s.measure).join(", ")} | ${summary(s.measure)}`);
      await repeatRoute(R234, spec234, s);
    }
  }
  // The best combination: all the settings, the saved layout state when it hid the side bar, and the page script that
  // presses the close commands (kept as the last route, with a watcher that closes a part that comes back).
  bestSpec = { name: "best", settings: { ...SETTINGS_ALL }, userKeybindings: [], keybindings: [], layoutRows: null, pageScript: null };
  const use = ["R2 showTabs none", "R3 breadcrumbs.enabled false", "R4 other settings"];
  if ((results.s1.routes["R5b layout state written into a fresh profile"]?.hidden ?? []).includes("sideBar")) {
    bestSpec.layoutRows = results.s1.layoutRows;
    use.push("R5b layout state written into a fresh profile");
  }
  bestSpec.keybindings = USER_CLOSE_CHORDS.concat([CLOSE_OTHERS_CHORD], DISABLE_ENTRIES);
  bestSpec.pageScript = PAGE_CLOSE_SCRIPT(true);
  use.push("R6a page script: close commands via seeded chords, with a watcher");
  results.s1.best = { routes: use };
  console.log(`\n[best combination] ${use.join(" + ")}`);

  // Measured: first load, after a reload, and on a profile that already holds saved layout state.
  const first = await session({ ...bestSpec, name: "best-first", settleSeconds: 3 });
  if (!first.ready && first.ready !== undefined) notRendered("S1 best route");
  else {
    results.s1.best.first = { parts: first.measure.parts, editor: first.measure.editor, hidden: hiddenParts(first.measure) };
    console.log(`[best: first load] hidden: ${hiddenParts(first.measure).join(", ") || "none"} | ${summary(first.measure)} | editor ${first.measure.editor.w}x${first.measure.editor.h}`);
    const re = await reloadMeasure(first, bestSpec);
    results.s1.best.afterReload = re;
    console.log(`[best: after reload] hidden: ${re.hidden?.join(", ") || "none"}`);
    first.profile && (results.s1.best.profileDir = "scratch");
    first.b.close();
    // The picture of the best route is taken in a trusted workspace, as a Code tab is (the plugin's `trustVaultFolder` writes the trust
    // record): the untrusted scratch profile of the sessions above shows a "Restricted Mode" banner that a Code tab does not.
    {
      const t = await session({ ...bestSpec, name: "best-trusted", trust: true, settleSeconds: 3 });
      if (t.ready === false) notRendered("S1 best route (trusted workspace)");
      else {
        results.s1.best.trusted = { parts: t.measure.parts, editor: t.measure.editor, hidden: hiddenParts(t.measure) };
        console.log(`[best: trusted workspace, as a Code tab is] hidden: ${hiddenParts(t.measure).join(", ") || "none"} | ${summary(t.measure)} | editor ${t.measure.editor.w}x${t.measure.editor.h}`);
        await t.b.shot(`PR-1-S1-${label}.png`);
        t.b.close();
      }
    }
    // The best route on a copy of the profile that already shows everything (side bar, panel and secondary side bar opened and saved).
    results.s1.best.savedProfile = await onSavedProfile("best", bestSpec);
  }
  recordListeners();
  const sideHidden = ["first", "afterReload", "savedProfile"].map((k) => results.s1.best[k]?.hidden?.includes("sideBar"));
  results.s1.sideBarHideable = sideHidden.some((v) => v === true) || Object.values(results.s1.routes).some((r) => r.hidden?.includes("sideBar"));
  check(results.s1.sideBarHideable, `S1: the side bar can be hidden by some route on ${label}`, `best route: first load ${sideHidden[0]}, after reload ${sideHidden[1]}, saved profile ${sideHidden[2]}`);
}

fs.writeFileSync(path.join(outDir, `chrome-spike-${label}.json`), JSON.stringify(results, null, 2));
if (!bestSpec) bestSpec = { name: "best", settings: { ...TABS_NONE, ...BREADCRUMBS_OFF, ...OTHER }, keybindings: USER_CLOSE_CHORDS.concat([CLOSE_OTHERS_CHORD], DISABLE_ENTRIES), userKeybindings: [], pageScript: PAGE_CLOSE_SCRIPT(true) };

// =====================================================================================================
// S2
// =====================================================================================================
const s2events = (b) => b.logs.filter((l) => l.text.startsWith("__s2__:")).map((l) => JSON.parse(l.text.slice(7)));

// R2: Go to Definition on `helper` in a.js (line 3). The JS/TS language service starts after the editor paints, so a first F12
// can find no provider: put the caret on the symbol once, then press F12 again every few seconds until the open editor's
// file changes or `maxSeconds` pass. Reports how many presses it took, how long, and what the editor showed before and after.
async function goToDefinition(b, { maxSeconds = 120, pollSeconds = 6 } = {}) {
  await b.focusEditor();
  await b.chord("g", CTRL);
  await sleep(0.8);
  await b.send("Input.insertText", { text: "3" });
  await b.chord("enter");
  await sleep(0.8);
  await b.chord("home");
  for (let i = 0; i < 10; i++) await b.chord("right");
  const beforeDef = await b.ev(EDITOR_NOW);
  const t0 = Date.now();
  let attempts = 0;
  let afterDef = beforeDef;
  while ((Date.now() - t0) / 1000 < maxSeconds) {
    attempts++;
    await b.chord("f12");
    for (let i = 0; i < pollSeconds * 2; i++) {
      await sleep(0.5);
      afterDef = await b.ev(EDITOR_NOW);
      if (afterDef?.uri && afterDef.uri !== beforeDef?.uri) break;
    }
    if (afterDef?.uri && afterDef.uri !== beforeDef?.uri) break;
  }
  await sleep(1);
  afterDef = await b.ev(EDITOR_NOW);
  return { beforeDef, afterDef, opened: !!afterDef?.uri && afterDef.uri !== beforeDef?.uri, attempts, seconds: Math.round((Date.now() - t0) / 100) / 10 };
}
if (ONLY.includes("S2")) {
  console.log("\n== S2: opening files from the editor ==");
  const spec = { ...bestSpec, name: "s2", trust: true, pageScript: null, keybindings: [...bestSpec.keybindings, CLOSE_ACTIVE_CHORD] };
  const s = await session(spec);
  if (s.ready === false) notRendered("S2");
  else {
    const b = s.b;
    await b.ev(PAGE_CLOSE_SCRIPT(true));
    await b.ev(S2_WATCH);
    const start = await b.ev(EDITOR_NOW);
    // Go to Definition on `helper` (line 3, column 11): Ctrl+G 3, Home, 10 x Right, F12, asked again until a definition
    // provider answers (R2: the language service is not ready on the first press). This session is a trusted workspace, as
    // a Code tab is with the plugin's default `trustVaultFolder: true`.
    const def = await goToDefinition(b, { maxSeconds: 120 });
    const { afterDef, opened: defOpened } = def;
    results.s2.goToDefinition = { start, ...def, events: s2events(b), trust: "trusted (trust seed written, as trustVaultFolder true does)", trustOutcome: s.trustOutcome };
    console.log(`[Go to Definition, trusted workspace] ${defOpened ? `opened ${afterDef.uri} at line ${afterDef.line} after ${def.attempts} press(es), ${def.seconds} s` : `did not leave the first file after ${def.attempts} press(es), ${def.seconds} s`}; page script saw ${JSON.stringify(s2events(b))}`);
    // The same question in a workspace nobody trusted (trustVaultFolder false): kept as the comparison that explains the R2 finding.
    {
      const u = await session({ ...spec, name: "s2-def-untrusted", trust: false, profileDir: path.join(work, "chrome-def-untrusted") });
      if (u.ready === false) notRendered("S2 Go to Definition (untrusted)");
      else {
        await u.b.ev(PAGE_CLOSE_SCRIPT(true));
        await u.b.ev(S2_WATCH);
        const startU = await u.b.ev(EDITOR_NOW);
        const defU = await goToDefinition(u.b, { maxSeconds: 60 });
        results.s2.goToDefinitionUntrusted = { start: startU, ...defU, events: s2events(u.b), trust: "untrusted (no trust seed)" };
        console.log(`[Go to Definition, untrusted workspace] ${defU.opened ? `opened ${defU.afterDef.uri} at line ${defU.afterDef.line}` : `did not leave the first file after ${defU.attempts} press(es), ${defU.seconds} s`}`);
        u.b.close();
      }
    }
    if (defOpened) {
      // Put the first file back (the close-active-editor chord), so the quick open run below starts from a.js as before.
      await b.chord("5", CTRL | ALT | SHIFT);
      await sleep(1.5);
      const back = await b.ev(EDITOR_NOW);
      results.s2.goToDefinition.returned = { afterClose: back, firstBack: back?.uri === start?.uri };
      console.log(`[Go to Definition, put back] ${back?.uri?.split("/").pop()} (first file back ${back?.uri === start?.uri})`);
    }
    // The first file again, then Cmd+P quick open to c.txt.
    const sa = await b.ev(EDITOR_NOW);
    await b.chord("p", MOD);
    await sleep(1);
    await b.send("Input.insertText", { text: "c.txt" });
    await sleep(1.2);
    await b.chord("enter");
    await sleep(3);
    const afterQuick = await b.ev(EDITOR_NOW);
    const heldAfterQuick = await b.listEditors();
    results.s2.quickOpen = { before: sa, after: afterQuick, changed: afterQuick?.uri !== sa?.uri, events: s2events(b), editorsHeld: heldAfterQuick };
    console.log(`[Cmd+P quick open] ${sa?.uri?.split("/").pop()} -> ${afterQuick?.uri?.split("/").pop()}; editors VS Code holds in the group now: ${JSON.stringify(heldAfterQuick)}`);
    // Putting the first tab back after the after-the-fact catch: close the editor that quick open just opened. The first
    // file's editor is still held behind it, so it should come back at the cursor line it had (Q8: the first tab keeps its cursor).
    await b.chord("5", CTRL | ALT | SHIFT);
    await sleep(1.5);
    const afterClose = await b.ev(EDITOR_NOW);
    results.s2.closeNewEditor = { firstBefore: sa, afterClose, firstBack: afterClose?.uri === sa?.uri, cursorKept: afterClose?.uri === sa?.uri && afterClose?.line === sa?.line, editorsHeld: await b.listEditors() };
    console.log(`[close the new editor] active file ${afterClose?.uri?.split("/").pop()} at line ${afterClose?.line} (the first file was at line ${sa?.line}): first file back ${results.s2.closeNewEditor.firstBack}, cursor kept ${results.s2.closeNewEditor.cursorKept}; editors held now ${JSON.stringify(results.s2.closeNewEditor.editorsHeld)}`);
    // A link in the editor: "Open Link" on a markdown link to b.js at line 5.
    await b.chord("p", MOD);
    await sleep(1);
    await b.send("Input.insertText", { text: "link.md" });
    await sleep(1.2);
    await b.chord("enter");
    await sleep(2.5);
    await b.chord("g", CTRL);
    await sleep(0.6);
    await b.send("Input.insertText", { text: "1" });
    await b.chord("enter");
    await sleep(0.6);
    await b.chord("home");
    for (let i = 0; i < 20; i++) await b.chord("right");
    const beforeLink = await b.ev(EDITOR_NOW);
    await b.palette("Open Link");
    await sleep(3);
    const afterLink = await b.ev(EDITOR_NOW);
    results.s2.openLink = { before: beforeLink, after: afterLink, opened: afterLink?.uri !== beforeLink?.uri, events: s2events(b) };
    await b.shot(`PR-1-S2-${label}.png`); // the second file (b.js at line 5), opened from the editor, before the "previous editor" command below moves back
    console.log(`[Open Link on a markdown link to b.js#L5] ${beforeLink?.uri?.split("/").pop()} -> ${afterLink?.uri?.split("/").pop()} line ${afterLink?.line}`);
    // What VS Code did with the previous editors (hidden strip): the quick pick list, and the "previous editor" command.
    const held = await b.listEditors();
    await b.palette("Open Previous Editor in Group");
    await sleep(1.5);
    const back = await b.ev(EDITOR_NOW);
    results.s2.previousEditorStillOpen = { editorsHeld: held, after: back, returned: back?.uri !== afterLink?.uri };
    console.log(`[previous editors] held ${JSON.stringify(held)}; after "previous editor" the open file is ${back?.uri?.split("/").pop()} (${back?.uri !== afterLink?.uri ? "an earlier editor is still open behind the visible one" : "no earlier editor to return to"})`);
    b.close();
  }
  // The editors VS Code keeps with the strip hidden, with and without preview mode, and how a restored previous editor
  // is closed on load: a profile that holds two open editors is reloaded with only one file in the payload.
  {
    results.s2.editorCount = {};
    for (const [tag, preview] of [["enablePreview false", false], ["enablePreview true (VS Code default)", true]]) {
      const c = await session({ name: "s2-held", settings: { ...bestSpec.settings, "workbench.editor.enablePreview": preview }, userKeybindings: [], keybindings: [CLOSE_OTHERS_CHORD, ...DISABLE_ENTRIES.filter((e) => !/closeActiveEditor/.test(e.command))], profileDir: path.join(work, `chrome-held-${preview}`) });
      if (c.ready === false) continue;
      const b = c.b;
      await b.focusEditor();
      await b.chord("p", MOD);
      await sleep(1);
      await b.send("Input.insertText", { text: "c.txt" });
      await sleep(1.2);
      await b.chord("enter");
      await sleep(3);
      const two = await b.listEditors();
      // the seeded close-others chord, pressed by the page script with both editors open
      await b.ev(`(() => { const t = document.activeElement || document.body; const o = { key: '4', code: 'Digit4', keyCode: 52, which: 52, ctrlKey: true, altKey: true, shiftKey: true, bubbles: true, cancelable: true }; t.dispatchEvent(new KeyboardEvent('keydown', o)); t.dispatchEvent(new KeyboardEvent('keyup', o)); return true; })()`);
      await sleep(1.5);
      const afterChordWithTwo = await b.listEditors();
      // reload with only b.js in the payload: does VS Code bring the earlier editors back?
      const only = paths.buildFileUri(`http://127.0.0.1:${port}`, path.join(vault, "b.js"));
      await b.load(c.url.replace(/&payload=[^&]*/, `&payload=${encodeURIComponent(JSON.stringify([["openFile", only]]))}`), 4);
      const restored = await b.listEditors();
      await b.ev(PAGE_CLOSE_SCRIPT(false));
      await b.ev(`(() => { const t = document.activeElement || document.body; const o = { key: '4', code: 'Digit4', keyCode: 52, which: 52, ctrlKey: true, altKey: true, shiftKey: true, bubbles: true, cancelable: true }; t.dispatchEvent(new KeyboardEvent('keydown', o)); t.dispatchEvent(new KeyboardEvent('keyup', o)); return true; })()`);
      await sleep(1.5);
      const closed = await b.listEditors();
      results.s2.editorCount[tag] = { afterQuickOpen: two, afterCloseOthersChordWithTwoOpen: afterChordWithTwo, afterReloadWithOneFile: restored, afterCloseOthersChord: closed, activeAfter: await b.ev(EDITOR_NOW) };
      console.log(`[hidden strip, ${tag}] after a second file is opened: ${JSON.stringify(two)}; after the close-others chord with both open: ${JSON.stringify(afterChordWithTwo)}; after a reload with b.js in the payload: ${JSON.stringify(restored)}; after the close-others chord: ${JSON.stringify(closed)}`);
      b.close();
    }
  }
  // Line travel: payload fragments, and moving an already-open editor with synthetic events only.
  {
    const variants = ["#5", "#L5", ":5"];
    results.s2.lineInUri = {};
    for (const v of variants) {
      const base = paths.buildFileUri(`http://127.0.0.1:${port}`, path.join(vault, "b.js"));
      const l = await session({ name: "s2-line", settings: bestSpec.settings, userKeybindings: [], keybindings: DISABLE_ENTRIES, payload: base + v, file: "b.js" });
      if (l.ready === false) { results.s2.lineInUri[v] = "page did not render"; continue; }
      const now = await l.b.ev(EDITOR_NOW);
      results.s2.lineInUri[v] = { uri: now?.uri, line: now?.line };
      console.log(`[openFile payload "${v}"] opens ${now?.uri?.split("/").pop()} with the cursor on line ${now?.line}`);
      l.b.close();
    }
    const g = await session({ name: "s2-goto", settings: bestSpec.settings, userKeybindings: [], keybindings: DISABLE_ENTRIES, file: "b.js" });
    if (g.ready !== false) {
      const before = await g.b.ev(EDITOR_NOW);
      const sent = await g.b.ev(GOTO_LINE_SYNTHETIC(7));
      const after = await g.b.ev(EDITOR_NOW);
      results.s2.gotoLineSynthetic = { before, sent, after, moved: after?.line === 7 };
      console.log(`[already-open editor moved to line 7 by synthetic Ctrl+G] ${sent}; line ${before?.line} -> ${after?.line}`);
      g.b.close();
    }
  }
  // Go to Definition counts only when it opened another file AND the page script reported that file at the line the editor showed.
  const gtd = results.s2.goToDefinition;
  const gtdSeen = !!gtd?.opened && (gtd.events ?? []).some((e) => e.uri === gtd.afterDef?.uri && e.line === gtd.afterDef?.line);
  results.s2.goToDefinitionSeenByPageScript = gtdSeen;
  results.s2.interceptable = !!results.s2.quickOpen?.changed && gtdSeen;
  check(results.s2.quickOpen !== undefined, "S2: Cmd+P quick open and Go to Definition were run and read back");
  check(gtdSeen, "S2: Go to Definition opened a file in a trusted workspace and the page script reported its URI and line", gtd ? `${gtd.opened ? `${gtd.afterDef?.uri?.split("/").pop()} line ${gtd.afterDef?.line}` : "no file opened"} after ${gtd.attempts} press(es)` : "not run");
}

// =====================================================================================================
// S3
// =====================================================================================================
const CHORD_TESTS = [
  { name: "Cmd/Ctrl+B", press: async (b) => b.chord("b", MOD), effect: `(() => { const e = document.querySelector('.part.sidebar'); const r = e && e.getBoundingClientRect(); return r ? r.width > 0 : false; })()`, label: "side bar shown" },
  { name: "Cmd/Ctrl+J", press: async (b) => b.chord("j", MOD), effect: `(() => { const e = document.querySelector('.part.panel'); const r = e && e.getBoundingClientRect(); return r ? r.width > 0 && r.height > 0 : false; })()`, label: "panel shown" },
  { name: "Cmd/Ctrl+K Z", press: async (b) => { await b.chord("k", MOD); await sleep(0.3); await b.chord("z"); }, effect: `(() => { const e = document.querySelector('.part.statusbar'); const r = e && e.getBoundingClientRect(); const wb = document.querySelector('.monaco-workbench'); return wb && wb.classList.contains('zen-mode') || !(r && r.width > 0) && !!document.querySelector('.part.editor'); })()`, label: "Zen Mode on" },
  { name: "Cmd/Ctrl+W", press: async (b) => b.chord("w", MOD), effect: `(() => !document.querySelector('.monaco-editor[data-uri]'))()`, label: "editor closed" },
];
if (ONLY.includes("S3")) {
  console.log("\n== S3: chords ==");
  results.s3.chords = {};
  const state = (b) => b.ev(`(() => ({ side: (() => { const e = document.querySelector('.part.sidebar'); const r = e && e.getBoundingClientRect(); return !!r && r.width > 0; })(), panel: (() => { const e = document.querySelector('.part.panel'); const r = e && e.getBoundingClientRect(); return !!r && r.width > 0 && r.height > 0; })(), zen: !!document.querySelector('.monaco-workbench.zen-mode'), editor: !!document.querySelector('.monaco-editor[data-uri]'), status: (() => { const e = document.querySelector('.part.statusbar'); const r = e && e.getBoundingClientRect(); return !!r && r.width > 0; })() }))()`);
  for (const mode of ["control (no removal entries)", "removal entries"]) {
    for (const t of CHORD_TESTS) {
      const s = await session({ name: `s3-${t.name.replace(/\W/g, "")}-${mode.startsWith("control") ? "c" : "r"}`, userKeybindings: [], keybindings: mode.startsWith("control") ? [] : DISABLE_ENTRIES, settings: { "workbench.statusBar.visible": true } });
      if (s.ready === false) { notRendered(`S3 ${t.name}`); continue; }
      const before = await state(s.b);
      await t.press(s.b);
      await sleep(1.5);
      const after = await state(s.b);
      const changed = JSON.stringify(before) !== JSON.stringify(after);
      results.s3.chords[`${t.name} | ${mode}`] = { before, after, changed };
      console.log(`[${t.name}, ${mode}] ${changed ? "changed the page" : "nothing happened"}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
      s.b.close();
    }
  }
  // The picture for S3: the best route (every part hidden), then all four chords pressed in a row, then the page. Nothing appears.
  {
    const s = await session({ ...bestSpec, name: "s3-picture", pageScript: PAGE_CLOSE_SCRIPT(false), trust: true, settleSeconds: 3 }); // no watcher: only the removal entries can keep a part away
    if (s.ready === false) notRendered("S3 picture");
    else {
      const before = await s.b.ev(MEASURE);
      for (const t of CHORD_TESTS) { await t.press(s.b); await sleep(1.2); }
      const after = await s.b.ev(MEASURE);
      const editorStill = await s.b.ev(`!!document.querySelector('.monaco-editor[data-uri]')`);
      results.s3.afterAllFourChords = { hiddenBefore: hiddenParts(before), hiddenAfter: hiddenParts(after), editorStillOpen: editorStill };
      console.log(`[best route, then Cmd/Ctrl+B, J, K Z and W] hidden before: ${hiddenParts(before).join(", ") || "none"}; after: ${hiddenParts(after).join(", ") || "none"}; editor still open ${editorStill}`);
      check(hiddenParts(after).length === PART_NAMES.length && editorStill === true, "S3: after all four chords on the best route every part is still hidden and the editor is open", `hidden after: ${hiddenParts(after).length}/${PART_NAMES.length}`);
      await s.b.shot(`PR-1-S3-${label}.png`);
      s.b.close();
    }
  }
  // Bridged chords still reach the page script, with the removal entries in place.
  {
    const config = { chords: [
      { action: "toggle-terminal", ctrl: true, meta: false, alt: false, shift: false, key: "`", code: "Backquote" },
      { action: "open-switcher", ctrl: !IS_MAC, meta: IS_MAC, alt: false, shift: false, key: "o", code: "KeyO" },
    ] };
    const s = await session({ name: "s3-bridge", userKeybindings: [], keybindings: DISABLE_ENTRIES, relay: bridge.buildRelayScript(config, "probe-nonce") });
    if (s.ready === false) notRendered("S3 bridge");
    else {
      await s.b.chord("backtick", CTRL);
      await sleep(0.5);
      await s.b.chord("o", MOD);
      await sleep(0.8);
      const seen = s.b.logs.filter((l) => l.text.startsWith(bridge.KEY_MESSAGE_PREFIX)).map((l) => JSON.parse(l.text.slice(bridge.KEY_MESSAGE_PREFIX.length)).action);
      results.s3.bridged = { actions: seen, expected: ["toggle-terminal", "open-switcher"] };
      console.log(`[bridged chords with the removal entries in place] page script reported: ${seen.join(", ") || "nothing"}`);
      check(seen.includes("toggle-terminal") && seen.includes("open-switcher"), "S3: both bridged chords still reach the page script");
      s.b.close();
    }
  }
  // Survival: the user's copy binds Cmd+B itself; the removal entries come after it. A new copy id replaces the file.
  {
    const mine = IS_MAC ? "cmd+b" : "ctrl+b";
    const userBinds = [{ key: mine, command: "workbench.action.toggleSidebarVisibility" }];
    const withEntries = await session({ name: "s3-user-copy-after", userKeybindings: userBinds, keybindings: DISABLE_ENTRIES });
    const entriesBeforeUser = await session({ name: "s3-user-copy-before", userKeybindings: [], keybindings: DISABLE_ENTRIES.concat(userBinds) });
    const run = async (s, tag) => {
      if (s.ready === false) return null;
      const before = await state(s.b);
      await s.b.chord("b", MOD);
      await sleep(1.5);
      const after = await state(s.b);
      s.b.close();
      results.s3.survival = results.s3.survival ?? {};
      results.s3.survival[tag] = { before, after, changed: before.side !== after.side };
      console.log(`[${tag}] side bar ${before.side} -> ${after.side}`);
      return before.side !== after.side;
    };
    await run(withEntries, "user copy binds the chord, removal entries appended after it");
    await run(entriesBeforeUser, "removal entries first, the user's binding after them");
    // The seed replaces keybindings.json when the copy id changes: the file read back from IndexedDB.
    const probe = await browser("s3-replace");
    await probe.navigate(`http://127.0.0.1:${port}/`);
    await sleep(1.5);
    const seed = (id, kb) => probe.ev(settings.buildBrowserSeedScript(settings.BROWSER_APP_SETTINGS, { id, settings: {}, keybindingsBase64: kb ? b64(JSON.stringify(kb)) : null }));
    const read = () => probe.ev(`(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('vscode-web-db'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); const v = await new Promise((res) => { const q = db.transaction('vscode-userdata-store').objectStore('vscode-userdata-store').get('/User/keybindings.json'); q.onsuccess = () => res(q.result); }); db.close(); return v === undefined ? null : new TextDecoder().decode(v); })()`);
    await seed("copy-1", DISABLE_ENTRIES);
    const kept = await read();
    await seed("copy-1", null); // same id: the copy is not applied again
    const sameId = await read();
    await seed("copy-2", [{ key: "ctrl+x", command: "noop" }]); // a new start: the copy replaces the file
    const replaced = await read();
    results.s3.seedReplaces = { entriesPresentAfterFirstSeed: kept?.includes("-workbench.action.toggleSidebarVisibility"), keptWhenSameCopyId: sameId?.includes("-workbench.action.toggleSidebarVisibility"), goneAfterNewCopyId: !replaced?.includes("-workbench.action.toggleSidebarVisibility") };
    console.log(`[seed] removal entries present after the first seed: ${results.s3.seedReplaces.entriesPresentAfterFirstSeed}; kept on a tab reload (same copy id): ${results.s3.seedReplaces.keptWhenSameCopyId}; gone after a new copy id: ${results.s3.seedReplaces.goneAfterNewCopyId}`);
    probe.close();
  }
}

// =====================================================================================================
// S4
// =====================================================================================================
if (ONLY.includes("S4")) {
  console.log("\n== S4: flash and palette undo ==");
  for (const [tag, spec] of [["baseline settings (no hiding beyond today's)", { name: "s4-base" }], ["best route", { ...bestSpec, name: "s4-best" }], ["best route without saved layout state", { ...bestSpec, layoutRows: null, name: "s4-nolayout" }]]) {
    // Frames: the recorder runs from the first script of the document; screencast frames are kept for the picture.
    const s = await session({ ...spec, flash: true, settleSeconds: 4 });
    if (s.ready === false) { notRendered(`S4 ${tag}`); continue; }
    const rec = await s.b.ev(`(() => ({ frames: window.__flash ? window.__flash.frames : [] }))()`);
    const fr = rec?.frames ?? [];
    const firstWb = fr.find((f) => f.wb);
    const firstVisible = fr.find((f) => f.vis.length > 0);
    const lastVisibleIdx = fr.map((f) => f.vis.length > 0).lastIndexOf(true);
    const firstEditor = fr.find((f) => f.editor);
    // "seen": any unwanted part on screen while the editor is not yet on screen, or after it, before the frame with none.
    const settledIdx = fr.findIndex((f, i) => f.editor && fr.slice(i).every((g) => g.vis.length === 0));
    const flashMs = firstVisible && settledIdx > -1 ? Math.max(0, fr[settledIdx].t - firstVisible.t) : firstVisible ? null : 0;
    const unwanted = new Set(fr.flatMap((f) => f.vis));
    results.s4[tag] = {
      frames: fr.length,
      workbenchAtMs: firstWb?.t ?? null,
      editorAtMs: firstEditor?.t ?? null,
      firstUnwantedAtMs: firstVisible?.t ?? null,
      lastUnwantedAtMs: lastVisibleIdx >= 0 ? fr[lastVisibleIdx].t : null,
      flashMs,
      partsSeen: [...unwanted],
      flashSeen: !!firstVisible,
      stillVisibleAtEnd: lastVisibleIdx === fr.length - 1 && fr.length > 0,
      readyMs: s.readyMs,
    };
    console.log(`[${tag}] ${fr.length} frames; workbench at ${firstWb?.t} ms, editor at ${firstEditor?.t} ms; ${firstVisible ? `unwanted parts first seen at ${firstVisible.t} ms (${[...unwanted].join(", ")}), ${flashMs === null ? "never hidden again" : `gone ${flashMs} ms later`}` : "no flash seen"}`);
    if (tag === "best route") {
      // The picture: a contact sheet of frames across the load is not possible from a finished load, so the picture is
      // the settled page plus the frame table in the JSON. A second load below takes real screencast frames.
      await s.b.shot(`PR-1-S4-${label}-settled.png`);
    }
    s.b.close();
  }
  // Screencast of one load of the best route, to look at.
  {
    const b = await browser("s4-cast");
    const shots = [];
    b.on("Page.screencastFrame", (p) => {
      shots.push({ t: p.metadata.timestamp, data: p.data });
      void b.send("Page.screencastFrameAck", { sessionId: p.sessionId });
    });
    const machine = settings.writeMachineSettings(serverData, { dark: false });
    fs.writeFileSync(machine, JSON.stringify({ ...JSON.parse(fs.readFileSync(machine, "utf8")), ...bestSpec.settings }, null, 2));
    await b.navigate(`http://127.0.0.1:${port}/`);
    await sleep(1.5);
    const kb = [...bestSpec.keybindings];
    await b.ev(settings.buildBrowserSeedScript({ ...settings.BROWSER_APP_SETTINGS, ...OVERLAY, ...bestSpec.settings }, { id: "cast", settings: {}, keybindingsBase64: b64(JSON.stringify(kb)) }));
    await b.send("Page.startScreencast", { format: "jpeg", quality: 60, everyNthFrame: 1 });
    const uri = paths.buildFileUri(`http://127.0.0.1:${port}`, path.join(vault, "a.js"));
    await b.navigate(`http://127.0.0.1:${port}/?tkn=${token}&folder=${encodeURIComponent(vault)}&payload=${encodeURIComponent(JSON.stringify([["openFile", uri]]))}`);
    for (let i = 0; i < 60; i++) { await sleep(0.5); if ((await b.ev(READY)) === true) break; }
    await b.ev(bestSpec.pageScript);
    await sleep(3);
    await b.send("Page.stopScreencast");
    const picks = shots.length <= 12 ? shots : Array.from({ length: 12 }, (_, i) => shots[Math.floor((i * (shots.length - 1)) / 11)]);
    results.s4.screencastFrames = shots.length;
    const html = `<body style="margin:0;background:#222;display:grid;grid-template-columns:repeat(4,1fr);gap:4px">${picks.map((p, i) => `<figure style="margin:0;color:#fff;font:11px sans-serif"><img style="width:100%" src="data:image/jpeg;base64,${p.data}"><figcaption>frame ${i + 1}/${picks.length} (of ${shots.length}) +${Math.round((p.t - picks[0].t) * 1000)} ms</figcaption></figure>`).join("")}</body>`;
    const sheet = path.join(work, "sheet.html");
    fs.writeFileSync(sheet, html);
    await b.navigate(pathToFileURL(sheet).href);
    await sleep(2);
    await b.send("Emulation.setDeviceMetricsOverride", { width: 1800, height: 1100, deviceScaleFactor: 1, mobile: false });
    await b.shot(`PR-1-S4-${label}.png`);
    console.log(`[screencast of the best route's load] ${shots.length} frames kept, ${picks.length} in the contact sheet`);
    b.close();
  }
  // A palette command that reveals a bar, with and without the hold script.
  results.s4.paletteReveal = {};
  for (const [tag, hold] of [["no undo script", false], ["undo script (hold)", true]]) {
    const s = await session({ ...bestSpec, name: `s4-palette-${hold ? "hold" : "plain"}`, pageScript: PAGE_CLOSE_SCRIPT(hold) });
    if (s.ready === false) { notRendered(`S4 palette ${tag}`); continue; }
    const out = {};
    for (const [cmd, part] of [["View: Toggle Primary Side Bar Visibility", "sideBar"], ["View: Toggle Panel Visibility", "panel"], ["View: Toggle Secondary Side Bar Visibility", "secondarySideBar"]]) {
      await s.b.palette(cmd);
      const samples = [];
      for (const ms of [100, 400, 1500]) {
        await sleep(ms === 100 ? 0.1 : ms === 400 ? 0.3 : 1.1);
        samples.push((await s.b.ev(MEASURE)).parts[part].shown);
      }
      out[part] = { command: cmd, shownAfter100ms: samples[0], shownAfter400ms: samples[1], shownAfter1500ms: samples[2], undone: samples[2] === false };
      if (samples[2]) await s.b.palette(cmd.replace("Toggle", "Toggle")); // put it back for the next command
    }
    results.s4.paletteReveal[tag] = out;
    console.log(`[palette reveal, ${tag}] ${Object.entries(out).map(([p, o]) => `${p}: shown at 100/400/1500 ms = ${o.shownAfter100ms}/${o.shownAfter400ms}/${o.shownAfter1500ms}`).join("; ")}`);
    s.b.close();
  }
  check(Object.keys(results.s4).length > 0, "S4: frames and palette reveal measured");
}

// =====================================================================================================
// S5
// =====================================================================================================
const SIGNALS = `(() => {
  const title = document.title || '';
  const tabsDirty = document.querySelectorAll('.monaco-workbench .tab.dirty').length;
  const dirtyClass = [...document.querySelectorAll('.monaco-workbench [class*="dirty"]')].filter((e) => !e.closest('.quick-input-widget')).map((e) => e.className.toString().slice(0, 60));
  const tabLabel = [...document.querySelectorAll('.monaco-workbench .tab')].map((t) => t.getAttribute('data-resource-name') + ':' + (t.classList.contains('dirty') ? 'dirty' : 'clean'));
  const ed = document.querySelector('.monaco-editor[data-uri]');
  const al = ed && ed.getAttribute('aria-label');
  const hiddenTitle = document.querySelector('.editor-group-container .title');
  return {
    titleDot: title.startsWith('\\u25cf'),
    title,
    tabDirtyCount: tabsDirty,
    dirtyClassNames: dirtyClass,
    tabLabels: tabLabel,
    titleControlSize: hiddenTitle ? Math.round(hiddenTitle.getBoundingClientRect().height) : null,
    titleControlDirty: !!document.querySelector('.editor-group-container .title [class*="dirty"], .editor-group-container .title .dirty'),
    editorAria: al ? al.slice(0, 80) : null,
  };
})()`;
if (ONLY.includes("S5")) {
  console.log("\n== S5: unsaved-edit signal with the tab strip hidden ==");
  results.s5.modes = {};
  const modes = [
    ["showTabs none", { ...bestSpec.settings, "workbench.editor.showTabs": "none", "files.autoSave": "off" }],
    ["showTabs single, strip hidden by CSS", { ...bestSpec.settings, "workbench.editor.showTabs": "single", "files.autoSave": "off" }],
    ["showTabs multiple (today's strip, control)", { "workbench.editor.showTabs": "multiple", "files.autoSave": "off" }],
  ];
  for (const [mode, st] of modes) {
    const s = await session({ name: `s5-${mode.split(" ")[1]}`, trust: mode === "showTabs none", settings: st, userKeybindings: [], keybindings: DISABLE_ENTRIES.filter((e) => !/closeActiveEditor/.test(e.command)), file: "a.js", pageScript: mode.includes("CSS") ? `(() => { const s = document.createElement('style'); s.textContent = '.editor-group-container > .title { height: 0 !important; overflow: hidden !important; }'; document.head.appendChild(s); return true; })()` : null });
    if (s.ready === false) { notRendered(`S5 ${mode}`); continue; }
    const b = s.b;
    const read = async () => ({
      signals: await b.ev(SIGNALS),
      dirtyScript: await b.ev(DIRTY_SCRIPT),
      fileDirty: await b.ev(fileDirtyScript("a.js")),
    });
    const clean = await read();
    const typedOk = await b.typeInEditor("X");
    results.s5[`typed in ${mode}`] = typedOk;
    check(typedOk, `S5: the probe typed into the editor (${mode})`);
    await sleep(1);
    const typed = await read();
    if (mode === "showTabs none") await b.shot(`PR-1-S5-${label}.png`);
    await b.chord("s", MOD);
    await sleep(2.5);
    const saved = await read();
    if (mode === "showTabs none") await b.shot(`PR-1-S5-${label}-saved.png`);
    results.s5.modes[mode] = { clean, typed, saved };
    console.log(`[${mode}] clean/typed/saved: title dot ${clean.signals.titleDot}/${typed.signals.titleDot}/${saved.signals.titleDot}; .tab.dirty ${clean.signals.tabDirtyCount}/${typed.signals.tabDirtyCount}/${saved.signals.tabDirtyCount}; DIRTY_SCRIPT ${clean.dirtyScript}/${typed.dirtyScript}/${saved.dirtyScript}; fileDirtyScript ${clean.fileDirty}/${typed.fileDirty}/${saved.fileDirty}; other dirty-looking classes while typed: ${JSON.stringify(typed.signals.dirtyClassNames)}`);
    b.close();
    fs.writeFileSync(path.join(vault, "a.js"), 'import { helper } from "./b.js";\n\nconst x = helper(1);\nconsole.log(x);\n');
  }
  // The window title with two editors open, the typed one not active: the title names the active editor only.
  {
    const s = await session({ name: "s5-two", settings: { ...bestSpec.settings, "workbench.editor.showTabs": "none", "workbench.editor.enablePreview": false, "files.autoSave": "off" }, userKeybindings: [], keybindings: [] });
    if (s.ready !== false) {
      const b = s.b;
      const typedY = await b.typeInEditor("Y");
      check(typedY, "S5: the probe typed into the editor (two editors)");
      await sleep(1);
      const typedA = (await b.ev(SIGNALS)).title;
      await b.chord("p", MOD);
      await sleep(1);
      await b.send("Input.insertText", { text: "c.txt" });
      await sleep(1.2);
      await b.chord("enter");
      await sleep(3);
      const onC = (await b.ev(SIGNALS)).title;
      const marks = await b.listEditors(true);
      results.s5.twoEditors = { quickPickRows: marks, titleWhileATyped: typedA, titleWhenCActiveAndAStillDirty: onC, pageWideDirtyScript: await b.ev(DIRTY_SCRIPT), fileDirtyA: await b.ev(fileDirtyScript("a.js")) };
      console.log(`[two editors, a.js dirty, c.txt active] title "${onC}"; title was "${typedA}" while a.js was active; DIRTY_SCRIPT ${results.s5.twoEditors.pageWideDirtyScript}; fileDirtyScript(a.js) ${results.s5.twoEditors.fileDirtyA}; Show All Editors rows ${JSON.stringify(marks)}`);
      b.close();
      fs.writeFileSync(path.join(vault, "a.js"), 'import { helper } from "./b.js";\n\nconst x = helper(1);\nconsole.log(x);\n');
    }
  }
  check(Object.keys(results.s5.modes).length > 0, "S5: signals measured in each tab mode");
}

// =====================================================================================================
// F1 / F4 and the table
// =====================================================================================================
recordListeners();
const listing = (() => {
  try { return execFileSync("lsof", ["-nP", "-i", "-a", "-p", serverTree().join(",")], { encoding: "utf8" }); } catch { return ""; }
})();
// A run that had to download the server (no CLI_DATA_SRC) has the launcher's own download connection to Microsoft's CDN
// open: that is the probe fetching the server it measures, not the product, so it is named and left out. A run from a
// cached server (CLI_DATA_SRC) has no such line and is the F4 evidence.
const downloadLines = haveServer ? [] : listing.split("\n").filter((l) => /^code-tunn/.test(l) && /->\S+:443 /.test(l));
const nonLoopback = listing.split("\n").filter((l) => /TCP|UDP/.test(l) && !/127\.0\.0\.1|\[::1\]|localhost|\*:/.test(l) && !/^COMMAND/.test(l) && !downloadLines.includes(l));
results.f4 = { lsofNonLoopback: nonLoopback, serverDownloadConnections: downloadLines.length, hostsSeen: [...hostsSeen].sort(), knownHosts: [...KNOWN_HOSTS].sort() };
results.hostsSeen = [...hostsSeen].sort();
check(nonLoopback.length === 0, "F4: lsof -i on the server tree shows loopback listeners only", nonLoopback.slice(0, 3).join(" | "));
const newHosts = [...hostsSeen].filter((h) => h && !KNOWN_HOSTS.has(h));
check(newHosts.length === 0, "F4: Chrome saw no host beyond 127.0.0.1, main.vscode-cdn.net and the one marketplace query", `hosts: ${[...hostsSeen].join(", ")}${newHosts.length ? `; NEW: ${newHosts.join(", ")}` : ""}`);
const realAfter = Object.fromEntries(REAL_FILES.map((f) => [f, sum(f)]));
const changedReal = REAL_FILES.filter((f) => realBefore[f] !== realAfter[f]);
results.f1 = { checked: REAL_FILES.map((f) => [f, realBefore[f] === "absent" ? "absent" : realBefore[f].slice(0, 12)]), changed: changedReal };
check(changedReal.length === 0, "F1: the desktop VS Code's settings.json, keybindings.json and extensions.json are identical before and after", changedReal.join(", "));

// stop, then check nothing of ours is left
const toStop = serverTree();
stopAll();
// CLI_DATA_SAVE=<dir>: keep the server this run downloaded, so the next run can use it as CLI_DATA_SRC (no network at all).
if (process.env.CLI_DATA_SAVE && !haveServer) {
  await sleep(1);
  fs.cpSync(cliData, process.env.CLI_DATA_SAVE, { recursive: true });
  console.log(`saved the downloaded server to ${process.env.CLI_DATA_SAVE} (use it as CLI_DATA_SRC)`);
}
await sleep(2);
const left = toStop.filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
let listening = "";
try { listening = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim(); } catch { /* none */ }
results.cleanup = { pidsLeft: left, listenerOnPort: listening || null };
check(left.length === 0 && listening === "", "the probe stopped everything it started by PID: no process or listener left", `left ${left.join(",") || "none"}; listener ${listening || "none"}`);

fs.writeFileSync(path.join(outDir, `chrome-spike-${label}.json`), JSON.stringify(results, null, 2));

// The table: one line per question, as the report states it.
const answerS1 = (p) => {
  const order = Object.entries(results.s1.routes ?? {});
  const first = order.find(([, r]) => r.hidden?.includes(p));
  const best = results.s1.best?.first?.parts?.[p];
  return `${first ? first[0] : "no route"}; best route ${best ? `${best.w}x${best.h}${best.shown ? " SHOWN" : " hidden"}` : "n/a"}`;
};
console.log(`\n== S1 to S5 on ${label} (${version}) ==`);
if (ONLY.includes("S1")) for (const p of PART_NAMES) console.log(`S1 ${p.padEnd(18)} ${answerS1(p)}`);
if (ONLY.includes("S2")) console.log(`S2 intercept: quick open ${results.s2.quickOpen?.changed ? "changed the open file" : "n/a"}; Go to Definition ${results.s2.goToDefinition?.opened ? `opened ${results.s2.goToDefinition.afterDef.uri.split("/").pop()} at line ${results.s2.goToDefinition.afterDef.line}` : "did not resolve"}; page-script events ${results.s2.goToDefinition?.events?.length ?? 0}`);
if (ONLY.includes("S3")) console.log(`S3 chords: ${Object.entries(results.s3.chords ?? {}).map(([k, v]) => `${k} ${v.changed ? "CHANGED" : "no change"}`).join("; ")}; bridged ${results.s3.bridged?.actions?.join("+") ?? "n/a"}`);
if (ONLY.includes("S4")) console.log(`S4 flash: ${Object.entries(results.s4).filter(([, v]) => v && typeof v === "object" && "flashSeen" in v).map(([k, v]) => `${k}: ${v.flashSeen ? `seen, ${v.flashMs} ms` : `no flash seen (${v.frames} frames)`}`).join("; ")}`);
if (ONLY.includes("S5")) console.log(`S5 signals: ${Object.entries(results.s5.modes ?? {}).map(([k, v]) => `${k}: title dot ${v.clean.signals.titleDot}/${v.typed.signals.titleDot}/${v.saved.signals.titleDot}, .tab.dirty ${v.clean.signals.tabDirtyCount}/${v.typed.signals.tabDirtyCount}/${v.saved.signals.tabDirtyCount}`).join("; ")}`);

fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
console.log(`results and screenshots: ${outDir}`);
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exit(neverPainted ? 2 : failures.length ? 1 : 0);
