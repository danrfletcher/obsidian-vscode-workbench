/**
 * The extension spike (ticket warkworth-36, PR-1): four measurements on a real `code serve-web` server, in a
 * real headless Chrome. Its output is what docs/spike-extensions.md records and the Extensions section of the
 * plugin settings shows (src/settings/spike-result.ts).
 *
 *   Q1 Stable port:   two starts of the server on the same port, then one on another port. Does the workbench's
 *                     origin, and with it the stored Workspace Trust record, stay the same?
 *   Q2 Trust record:  the browser-storage database, object store and key the workbench writes when the Trust
 *                     button is clicked, with its value (machine-specific parts redacted). The key is found by
 *                     diffing every IndexedDB store before and after the click, not assumed.
 *   Q3 Settings route: a setting with a visible effect (editor.fontSize) and a keybinding with a visible effect
 *                     (toggle the side bar) are put in a scratch "mirrored profile", then delivered by each
 *                     candidate route (the IndexedDB write of buildBrowserSeedScript, the server's User
 *                     folder, the Machine settings file). The effect is read from the DOM / computed style.
 *   Q4 Turbo Console Log: the extension is in the installed list of a real server that shares the instance's
 *                     real extensions folder (shareExtensions). Each candidate cause for "it does nothing" is
 *                     tested in turn: Restricted Mode, not enabled, not activated, missing contribution.
 *
 * The fixture is Dan's own set-up and is asserted from the instance's own files before anything starts (GP1):
 * Turbo Console Log is in `extensions.json` and not disabled, and the vault folder is associated with the
 * Default profile in `User/globalStorage/storage.json`.
 *
 * Read-only on the desktop instance (F1): `extensions.json`, `User/settings.json`, `keybindings.json` and
 * `globalStorage` are checksummed and listed before and after and have to match, a `state.vscdb` is only read
 * from a temp copy, and nothing is ever written to, installed into or enabled in that folder. Nothing it
 * starts uses a fixed port, and it stops what it started, by PID, at the end.
 *
 * Not part of `npm test`.
 *
 *   npm run check:extensions-spike [outDir]
 *
 * Env: CODE_CLI (the build's `code` script), CLI_DATA_SRC / ALLOW_DOWNLOAD (as in workbench-check.mjs), CHROME,
 * SERVER_TMPDIR, SQLITE3, APP_SUPPORT (default ~/Library/Application Support), INSTANCE_FOLDER (default
 * "Code - Insiders"), EXTENSIONS_DIR (default ~/.vscode-insiders/extensions), VAULT_FOLDER (default
 * ~/Documents/Notes). Writes `extension-spike-result.json` and screenshots into outDir.
 *
 * Exit codes: 0 done, 1 a guard failed (the desktop instance changed while it ran), 2 the spike could not run
 * (a missing tool or instance, a fixture that does not match, a server that does not come up).
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
const HOME = os.homedir();
const CODE = process.env.CODE_CLI ?? "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const APP_SUPPORT = process.env.APP_SUPPORT ?? path.join(HOME, "Library/Application Support");
const INSTANCE = path.join(APP_SUPPORT, process.env.INSTANCE_FOLDER ?? "Code - Insiders");
const EXT_DIR = process.env.EXTENSIONS_DIR ?? path.join(HOME, ".vscode-insiders/extensions");
const VAULT_FOLDER = process.env.VAULT_FOLDER ?? path.join(HOME, "Documents/Notes");
const CLI_DATA_SRC = process.env.CLI_DATA_SRC;
const ALLOW_DOWNLOAD = process.env.ALLOW_DOWNLOAD === "1";
const TURBO = "chakrounanas.turbo-console-log";
const DEFAULT_PROFILE = "__default__profile__";

let work = null; // the scratch folder, once made; a run that stops before doing anything removes it again
const stop = (code, message) => {
  console.error(message);
  if (work) fs.rmSync(work, { recursive: true, force: true });
  process.exit(code);
};

// --- 1. the tools and the instance: plain messages, no stack traces -----------------------------------
function findSqlite() {
  // SQLITE3, when set, is the only candidate (so a wrong path is reported, not papered over).
  if (process.env.SQLITE3) return fs.existsSync(process.env.SQLITE3) ? process.env.SQLITE3 : null;
  for (const c of ["/usr/bin/sqlite3", ...(process.env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, "sqlite3"))]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}
const SQLITE = findSqlite();
if (!SQLITE) stop(2, "extension spike cannot run: sqlite3 was not found (set SQLITE3 to its path). It is needed to read the desktop instance's state.vscdb, from a temp copy.");
for (const [name, f] of [["CODE_CLI", CODE], ["CHROME", CHROME]]) {
  if (!fs.existsSync(f)) stop(2, `extension spike needs ${name} (${f} does not exist)`);
}
if (!fs.existsSync(INSTANCE)) stop(2, `extension spike cannot run: the VS Code instance folder ${INSTANCE} does not exist (set APP_SUPPORT / INSTANCE_FOLDER).`);
if (!fs.existsSync(EXT_DIR)) stop(2, `extension spike cannot run: the extensions folder ${EXT_DIR} does not exist (set EXTENSIONS_DIR).`);
work = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "extension-spike-"));
const outDir = path.resolve(process.argv[2] ?? path.join(work, "out"));
fs.mkdirSync(outDir, { recursive: true });

const started = []; // every PID this script started (roots); stopped at the end, nothing else is
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const log = (...a) => console.log(...a);
async function until(fn, secs, what) {
  for (let i = 0; i < secs * 2; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(0.5);
  }
  throw new Error(`timed out after ${secs}s waiting for ${what}`);
}
function descendants(pid) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
  const out = [];
  const walk = (p) => { for (const [c, pp] of rows) if (pp === p) { walk(c); out.push(c); } };
  walk(pid);
  return out;
}
function stopPid(pid) {
  for (const p of [...descendants(pid), pid]) {
    try { process.kill(p); } catch { /* already gone */ }
  }
  const i = started.indexOf(pid);
  if (i >= 0) started.splice(i, 1);
}
process.on("exit", () => { for (const p of [...started]) stopPid(p); });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on("error", reject);
});

// --- 2. GP1: the fixture is Dan's set-up, asserted from the instance's own files -----------------------
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
/** Run a query on a temp copy of a state.vscdb. The original is never opened. */
function queryStateDb(db, sql) {
  if (!fs.existsSync(db)) return null;
  const copy = path.join(work, `state-${crypto.randomBytes(4).toString("hex")}.vscdb`);
  fs.copyFileSync(db, copy);
  for (const ext of ["-wal", "-shm"]) if (fs.existsSync(db + ext)) fs.copyFileSync(db + ext, copy + ext);
  try {
    return execFileSync(SQLITE, ["-readonly", copy, sql], { encoding: "utf8" }).trim();
  } catch (e) {
    return `sqlite3 error: ${String(e.message).split("\n")[0]}`;
  }
}
const storageJson = readJson(path.join(INSTANCE, "User/globalStorage/storage.json"));
const installed = readJson(path.join(EXT_DIR, "extensions.json"));
const vaultUri = pathToFileURL(VAULT_FOLDER).href;
const turboEntry = Array.isArray(installed) ? installed.find((e) => e?.identifier?.id?.toLowerCase() === TURBO) : null;
const disabledRaw = queryStateDb(path.join(INSTANCE, "User/globalStorage/state.vscdb"), "SELECT value FROM ItemTable WHERE key = 'extensionsIdentifiers/disabled'");
let disabledIds = [];
try { disabledIds = JSON.parse(disabledRaw || "[]").map((e) => String(e.id).toLowerCase()); } catch { /* none, or not JSON */ }
const association = storageJson?.profileAssociations?.workspaces?.[vaultUri];
log("GP1 fixture, from the instance's own files:");
log(`  ${path.join(EXT_DIR, "extensions.json")}: ${turboEntry ? `${turboEntry.identifier.id} ${turboEntry.version}` : `${TURBO} NOT LISTED`}`);
log(`  disabled in ${path.join(INSTANCE, "User/globalStorage/state.vscdb")} (temp copy): ${disabledIds.includes(TURBO) ? "YES" : "no"}`);
log(`  ${path.join(INSTANCE, "User/globalStorage/storage.json")} profileAssociations.workspaces[${vaultUri}] = ${association ?? "(none)"}`);
if (!turboEntry) stop(2, `GP1 fixture does not match: Turbo Console Log (${TURBO}) is not listed in ${path.join(EXT_DIR, "extensions.json")}.`);
if (disabledIds.includes(TURBO)) stop(2, "GP1 fixture does not match: Turbo Console Log is disabled in the instance.");
if (association !== DEFAULT_PROFILE) stop(2, `GP1 fixture does not match: ${VAULT_FOLDER} is not associated with the Default profile in the instance's storage.json (found: ${association ?? "no association"}).`);

// --- 2b. the VS Code build and its cached server (after the fixture, so a fixture mismatch is reported first) ---
const [version, commit] = execFileSync(CODE, ["--version"], { encoding: "utf8" }).trim().split("\n");
const held = CLI_DATA_SRC && fs.existsSync(path.join(CLI_DATA_SRC, "serve-web")) ? fs.readdirSync(path.join(CLI_DATA_SRC, "serve-web")).filter((n) => /^[0-9a-f]{40}$/.test(n)) : [];
const haveServer = held.includes(commit);
if (!haveServer && !ALLOW_DOWNLOAD) {
  stop(2, `extension spike cannot run: the VS Code (${CODE}) is ${version} (server commit ${commit}) and no cached server is set up. Set CLI_DATA_SRC to a --cli-data-dir whose serve-web/ holds ${commit}, or ALLOW_DOWNLOAD=1 to let serve-web fetch it into the scratch folder.`);
}



// --- 3. F1: a checksum and listing of what must not change, before and after ---------------------------
function snapshot() {
  const out = {};
  const hash = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  const walk = (p) => {
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!st) return void (out[p] = "(absent)");
    if (st.isDirectory()) { out[p + "/"] = fs.readdirSync(p).sort().join(","); for (const n of fs.readdirSync(p)) walk(path.join(p, n)); }
    else if (st.isSymbolicLink()) out[p] = "-> " + fs.readlinkSync(p);
    else out[p] = `${st.size} ${hash(p)}`;
  };
  for (const f of [path.join(EXT_DIR, "extensions.json"), path.join(INSTANCE, "User/settings.json"), path.join(INSTANCE, "User/keybindings.json"), path.join(INSTANCE, "User/globalStorage")]) walk(f);
  return out;
}
const before = snapshot();
log(`F1 snapshot before: ${Object.keys(before).length} entries`);

// --- 4. the plugin's own code --------------------------------------------------------------------------
await build({
  entryPoints: { settings: path.join(root, "src/settings.ts"), server: path.join(root, "src/server.ts") },
  bundle: true, format: "esm", platform: "node", outdir: path.join(work, "plugin"), outExtension: { ".js": ".mjs" }, logLevel: "error",
});
const settings = await import(pathToFileURL(path.join(work, "plugin/settings.mjs")).href);
const pluginServer = await import(pathToFileURL(path.join(work, "plugin/server.mjs")).href);

// --- 5. the fixtures: a scratch vault and a scratch "mirrored profile" ---------------------------------
const vault = path.join(work, "vault");
fs.mkdirSync(vault, { recursive: true });
fs.writeFileSync(path.join(vault, "pd.js"), "const total = 41 + 1;\nconsole.log(total);\n");
const SPIKE_FONT = 23;
const profile = path.join(work, "mirrored-profile"); // stands in for the profile's User folder; the real one is never written
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ "editor.fontSize": SPIKE_FONT }, null, 2));
const KEYBINDINGS = [{ key: "ctrl+alt+9", command: "workbench.action.toggleSidebarVisibility" }];
fs.writeFileSync(path.join(profile, "keybindings.json"), JSON.stringify(KEYBINDINGS, null, 2));
// What the plugin shares since PR-5: the extensions the profile lists. This check has no desktop state, so it shares every entry of the folder's own extensions.json.
function listedIn(dir) {
  const file = path.join(dir, "extensions.json");
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8")).map((entry) => ({ id: String(entry.identifier?.id ?? "").toLowerCase(), folder: entry.relativeLocation, entry }));
}

const cliData = path.join(work, "cli-data");
if (haveServer) fs.cpSync(CLI_DATA_SRC, cliData, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
else fs.mkdirSync(cliData, { recursive: true });

// --- 6. a server and a browser --------------------------------------------------------------------------
async function startServer(name, serverData, port) {
  fs.mkdirSync(serverData, { recursive: true });
  pluginServer.shareExtensions(EXT_DIR, serverData, listedIn(EXT_DIR)); // the plugin's own extension sharing (G11)
  settings.writeMachineSettings(serverData, { dark: true });
  const token = crypto.randomBytes(12).toString("hex");
  const tokenFile = path.join(work, `token-${name}`);
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const logFile = path.join(work, `server-${name}.log`);
  const server = spawn(
    CODE,
    ["serve-web", "--host", "127.0.0.1", "--port", String(port), "--connection-token-file", tokenFile, "--server-data-dir", serverData, "--cli-data-dir", cliData, "--disable-telemetry", "--commit-id", commit, "--accept-server-license-terms"],
    // A short TMPDIR for the server only: its unix socket path has to fit in 104 characters.
    { stdio: ["ignore", fs.openSync(logFile, "w"), "ignore"], env: { ...process.env, TMPDIR: process.env.SERVER_TMPDIR ?? "/tmp" } },
  );
  started.push(server.pid);
  log(`[${name}] server pid ${server.pid} on 127.0.0.1:${port}`);
  let answered = 0;
  for (let i = 0; i < (haveServer ? 60 : 400); i++) {
    answered = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.status, () => 0);
    if (answered) break;
    await sleep(1);
  }
  if (!answered) stop(2, `the server did not come up (see ${logFile})`);
  if (answered >= 500) stop(2, `the server answered HTTP ${answered}: the server for commit ${commit} is probably damaged (see ${logFile})`);
  await sleep(2);
  return { name, port, token, pid: server.pid, serverData };
}

async function startBrowser(name) {
  const cdpPort = await freePort();
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${path.join(work, "chrome-" + name)}`, "--no-first-run", "--disable-background-networking", "about:blank"], { stdio: "ignore" });
  started.push(chrome.pid);
  const page = await until(async () => (await fetch(`http://127.0.0.1:${cdpPort}/json`).then((r) => r.json(), () => [])).find((t) => t.type === "page"), 30, "Chrome's debugging port");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) pend.get(d.id)(d); };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const b = {
    pid: chrome.pid,
    ev: async (e) => { const r = (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result; return r?.result?.value ?? (r?.exceptionDetails ? `ERROR ${r.exceptionDetails.exception?.description}` : undefined); },
    key: async (k, code, vk, modifiers = 0) => { for (const type of ["rawKeyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, modifiers }); },
    /** A real mouse click at the centre of the element `expr` (a JS expression) evaluates to. */
    click: async (expr) => {
      const r = JSON.parse((await b.ev(`(() => { const e = (${expr}); if (!e) return "null"; const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`)) || "null");
      if (!r) return false;
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x, y: r.y });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
      return true;
    },
    type: (text) => send("Input.insertText", { text }),
    shot: async (file) => { const s = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(outDir, file), Buffer.from(s.result.data, "base64")); log(`  screenshot ${path.join(outDir, file)}`); },
    open: async (srv) => {
      await send("Page.navigate", { url: `http://127.0.0.1:${srv.port}/?tkn=${srv.token}&folder=${encodeURIComponent(vault)}` });
      await until(() => b.ev("document.querySelector('.part.editor')?.offsetWidth > 0"), 90, "the workbench to paint");
      await sleep(3);
    },
    close: () => { try { ws.close(); } catch { /* gone */ } stopPid(chrome.pid); },
  };
  await send("Page.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  return b;
}

/** Every IndexedDB store of the page's origin, as "db/store/key" -> text (long values cut). */
const DUMP = `(async () => {
  const out = {};
  for (const d of await indexedDB.databases()) {
    const db = await new Promise((res, rej) => { const r = indexedDB.open(d.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    for (const s of db.objectStoreNames) {
      const rows = await new Promise((res) => {
        const tx = db.transaction(s); const st = tx.objectStore(s);
        const k = st.getAllKeys(); const v = st.getAll();
        tx.oncomplete = () => res(k.result.map((key, i) => [key, v.result[i]]));
      });
      for (const [k, v] of rows) out[d.name + " / " + s + " / " + String(k)] = typeof v === "string" ? v.slice(0, 4000) : v instanceof Uint8Array ? new TextDecoder().decode(v).slice(0, 4000) : "[" + Object.prototype.toString.call(v) + "]";
    }
    db.close();
  }
  return JSON.stringify(out);
})()`;
const dump = async (b) => JSON.parse((await b.ev(DUMP)) || "{}");
const bannerHeight = (b) => b.ev("document.querySelector('.part.banner')?.offsetHeight ?? 0");
/** The Restricted Mode banner is on screen (a hidden banner keeps its text, so its height is read too). */
const restricted = async (b) => (await bannerHeight(b)) > 0 && /Restricted Mode/.test((await b.ev("document.querySelector('.part.banner')?.innerText ?? ''")) || "");

/** Click Manage in the Restricted Mode banner, then Trust in the Workspace Trust editor: "trust done by hand". */
async function trustByHand(b) {
  await b.click("[...document.querySelectorAll('.part.banner a')].find((e) => /Manage/.test(e.innerText))");
  await until(() => b.ev("!!document.querySelector('.workspace-trust-editor a.monaco-button')"), 20, "the Workspace Trust editor");
  await sleep(1);
  await b.click("[...document.querySelectorAll('.workspace-trust-editor a.monaco-button')].find((e) => /^Trust/.test(e.innerText))");
  try {
    await until(async () => !(await restricted(b)), 30, "Restricted Mode to end");
  } catch (e) {
    await b.shot("trust-failed.png");
    log("trust did not take; page says:", await b.ev("[...document.querySelectorAll('.monaco-dialog-box, .workspace-trust-editor, .part.banner')].map((e) => e.className + ': ' + e.innerText.slice(0, 200)).join(' || ')"));
    throw e;
  }
}

/** The extension host log lines of a server (all hosts it started). */
function extHostLog(serverData) {
  const logs = path.join(serverData, "data/logs");
  if (!fs.existsSync(logs)) return [];
  const lines = [];
  for (const run of fs.readdirSync(logs)) for (const h of fs.readdirSync(path.join(logs, run))) {
    const f = path.join(logs, run, h, "remoteexthost.log");
    if (h.startsWith("exthost") && fs.existsSync(f)) for (const l of fs.readFileSync(f, "utf8").split("\n")) if (l) lines.push(`${h}: ${l}`);
  }
  return lines;
}

async function openFile(b, name) {
  await b.key("p", "KeyP", 80, 4); // Cmd+P
  await until(() => b.ev("document.querySelector('.quick-input-widget')?.style.display !== 'none' && !!document.querySelector('.quick-input-widget input')"), 10, "quick open");
  await b.type(name);
  await sleep(1.5);
  await b.key("Enter", "Enter", 13);
  await until(() => b.ev("!!document.querySelector('.monaco-editor .view-lines .view-line')"), 20, `${name} to open`);
  await sleep(1);
}
const fontSize = (b) => b.ev("(() => { const e = document.querySelector('.monaco-editor .view-lines .view-line span'); return e ? getComputedStyle(e).fontSize : null; })()");
const sidebarWidth = (b) => b.ev("document.querySelector('.part.sidebar')?.offsetWidth ?? 0");
const redact = (s) => String(s).split(vault).join("<vault folder>").split(work).join("<scratch>").split(HOME).join("~");
const result = { measuredOn: new Date().toISOString().slice(0, 10), vscodeVersion: version };

// =====================================================================================================
// Q1 + Q2 + Q4: one server, started twice on the same port, then once on another
// =====================================================================================================
const stablePort = await freePort();
const serverData = path.join(work, "server-data-main");
const q1 = {};
log("\n== Q1 stable port / Q2 trust record / Q4 Turbo Console Log ==");
let srv = await startServer("start1", serverData, stablePort);
let br = await startBrowser("main");
await br.open(srv);
q1.origin1 = await br.ev("location.origin");
q1.restrictedBeforeTrust = await restricted(br);
const dumpBefore = await dump(br);
await br.shot("02-restricted-mode-before-trust.png");
const turboLogBefore = extHostLog(srv.serverData).filter((l) => /turbo-console-log/i.test(l));
const baselineFont = (await openFile(br, "pd.js"), await fontSize(br));
const baselineSidebar = await sidebarWidth(br);

await trustByHand(br);
await sleep(8); // the extension hosts restart on trust and activate what was waiting
const dumpAfter = await dump(br);
await br.shot("03-after-trust.png");
const added = Object.keys(dumpAfter).filter((k) => !(k in dumpBefore) || dumpBefore[k] !== dumpAfter[k]);
const trustKeys = added.filter((k) => /trust/i.test(k) && !/publisher/i.test(k));
q1.trustKeys = trustKeys;
const trustKey = trustKeys.find((k) => k.endsWith("content.trust.model.key")) ?? trustKeys[0] ?? null;
log(`origin: ${q1.origin1}; Restricted Mode before trust: ${q1.restrictedBeforeTrust}; keys that changed with the click: ${added.length}; trust key: ${trustKey ?? "NOT FOUND"}`);

let trustRecord;
if (trustKey) {
  const [dbName, store, ...keyParts] = trustKey.split(" / ");
  const raw = dumpAfter[trustKey];
  const sample = redact(raw).replace(new RegExp(`127\\.0\\.0\\.1:${stablePort}`, "g"), "127.0.0.1:<port>");
  trustRecord = { found: true, database: dbName, store, key: keyParts.join(" / "), sample };
  log(`trust record: ${dbName} / ${store} / ${trustRecord.key}\n  ${sample}`);
} else {
  trustRecord = { found: false };
}
// The desktop instance's own trust record, from a temp copy: only to say where it lives, not to use it.
const desktopTrust = queryStateDb(path.join(INSTANCE, "User/globalStorage/state.vscdb"), "SELECT COUNT(*) FROM ItemTable WHERE key = 'content.trust.model.key'");
log(`desktop state.vscdb (temp copy) has content.trust.model.key rows: ${desktopTrust}`);

// Q4: the candidate causes, in turn
const q4 = {};
q4.restrictedModeAfterTrust = await restricted(br);
const logAfter = extHostLog(srv.serverData);
const turboLines = logAfter.filter((l) => /turbo-console-log/i.test(l));
q4.activatedBefore = turboLogBefore.some((l) => /_doActivateExtension/.test(l));
q4.activatedAfter = turboLines.some((l) => /_doActivateExtension/.test(l));
q4.errorLines = logAfter.filter((l) => /\[(error|warning)\]/i.test(l) && /turbo|chakroun/i.test(l));
q4.sharedDirLinked = fs.existsSync(path.join(serverData, "extensions", fs.readdirSync(path.join(serverData, "extensions")).find((n) => n.toLowerCase().startsWith(TURBO)) ?? "__none__"));
q4.listedByServer = (readJson(path.join(serverData, "extensions/extensions.json")) ?? []).some((e) => e?.identifier?.id?.toLowerCase() === TURBO);
// the workbench's own installed list
await br.key("x", "KeyX", 88, 12); // Cmd+Shift+X
await until(() => br.ev("!!document.querySelector('.extensions-viewlet')"), 20, "the Extensions view");
await sleep(1);
await br.type("@installed");
await sleep(3);
q4.installedList = JSON.parse((await br.ev("JSON.stringify([...document.querySelectorAll('.extensions-viewlet .monaco-list-row .name')].map((e) => e.innerText))")) || "[]");
q4.inInstalledList = q4.installedList.some((n) => /turbo console log/i.test(n));
await br.shot("04-installed-extensions.png");
// the contributed command
await br.key("F1", "F1", 112);
await until(() => br.ev("!!document.querySelector('.quick-input-widget input')"), 10, "the command palette");
await br.type("Turbo Console Log: Insert");
await sleep(2);
q4.commandsInPalette = JSON.parse((await br.ev("JSON.stringify([...document.querySelectorAll('.quick-input-list .monaco-list-row')].map((e) => e.innerText.replace(/\\s+/g, ' ')).slice(0, 5))")) || "[]");
q4.contributionPresent = q4.commandsInPalette.some((t) => /Turbo Console Log/i.test(t));
await br.key("Escape", "Escape", 27);
q4.disabledInInstance = disabledIds.includes(TURBO);
log("Q4 candidates:", JSON.stringify(q4, null, 1));
let turbo;
const ruled = [];
ruled.push(q4.restrictedModeAfterTrust ? "Restricted Mode: STILL ON after trust" : `Restricted Mode: ${q4.activatedBefore ? "was not blocking" : "blocked activation before trust (no activation line in the extension host log), gone after the Trust click"}`);
ruled.push(q4.disabledInInstance ? "Enabled: DISABLED in the instance" : "Not enabled: ruled out (not in the instance's disabled list, and listed in the installed view)");
ruled.push(q4.activatedAfter ? "Not activated: ruled out (the extension host logged _doActivateExtension for it after trust)" : "Not activated: CONFIRMED (no activation line after trust)");
ruled.push(q4.contributionPresent ? "Missing contribution: ruled out (its commands are in the command palette)" : "Missing contribution: CONFIRMED (its commands are not in the command palette)");
if (q4.inInstalledList && q4.activatedAfter && q4.contributionPresent && !q4.restrictedModeAfterTrust) {
  turbo = { state: "active", cause: q4.activatedBefore ? null : "Restricted Mode kept it from activating until the folder was trusted", detail: ruled };
} else {
  const cause = q4.errorLines[0] ?? (q4.activatedAfter ? "activated, but the cause is not in the extension host log" : "no activation and no error line in the extension host log");
  turbo = { state: q4.activatedAfter ? "failed" : "inactive", cause, detail: ruled };
}
// the real extension host log line, for the doc
const turboLogLine = turboLines.find((l) => /_doActivateExtension/.test(l)) ?? null;
log(`Turbo Console Log: ${turbo.state}; log line: ${turboLogLine ?? "(none)"}`);

// Q1: stop, start again on the SAME port with a new token, open in the same browser profile
br.close();
stopPid(srv.pid);
await sleep(2);
srv = await startServer("start2", serverData, stablePort);
br = await startBrowser("main"); // the same Chrome profile directory
await br.open(srv);
q1.origin2 = await br.ev("location.origin");
q1.restrictedAfterRestartSamePort = await restricted(br);
q1.trustKeyKept = trustKey ? (await dump(br))[trustKey] === dumpAfter[trustKey] : false;
log(`restart on the same port: origin ${q1.origin2}; Restricted Mode: ${q1.restrictedAfterRestartSamePort}; trust record kept: ${q1.trustKeyKept}`);
await br.shot("05-after-restart-same-port.png");
br.close();
stopPid(srv.pid);
await sleep(2);
const otherPort = await freePort();
srv = await startServer("start3", serverData, otherPort);
br = await startBrowser("main");
await br.open(srv);
q1.origin3 = await br.ev("location.origin");
q1.restrictedOnOtherPort = await restricted(br);
log(`start on another port: origin ${q1.origin3}; Restricted Mode: ${q1.restrictedOnOtherPort}`);
await br.shot("06-other-port.png");
br.close();
stopPid(srv.pid);

const originSame = q1.origin1 === q1.origin2;
const stable = originSame && !q1.restrictedAfterRestartSamePort && q1.trustKeyKept;
result.stablePort = {
  stable,
  result: `Two starts of the server on one port (${redact(q1.origin1).replace(String(stablePort), "<port>")}), opened in the same Chrome profile: the origin ${originSame ? "stayed the same" : "changed"}, Restricted Mode was ${q1.restrictedAfterRestartSamePort ? "shown again" : "not shown"} and the trust record was ${q1.trustKeyKept ? "unchanged" : "not kept"}. A third start on another port gave a different origin and Restricted Mode ${q1.restrictedOnOtherPort ? "came back" : "did not come back"}.`,
  decision: stable ? "Store one port per vault and try it first; fall back to a free port when it is held." : "A stable port does not keep the trust record: do not rely on it (see the doc).",
};
result.trustRecord = {
  found: trustRecord.found,
  location: trustRecord.found ? `${trustRecord.database} / ${trustRecord.store} / ${trustRecord.key}` : null,
  result: trustRecord.found
    ? `Written by the Trust click in the browser's IndexedDB for the server's origin; the value lists the trusted folder URIs, and each URI's authority is the server's host:port, so the record only matches on the same port.`
    : "The Trust click changed no IndexedDB key whose name mentions trust; the record was not found.",
  decision: trustRecord.found ? "Seed the record by writing this key, in this format, for the vault URI on the stable port." : "Do not claim a format; PR-2 builds nothing on a trust record until it is found.",
  sample: trustRecord.sample ?? null,
};
result.turboConsoleLog = {
  state: turbo.state,
  cause: turbo.cause,
  result: `${turbo.detail.join("; ")}.${turboLogLine ? ` Extension host log: ${redact(turboLogLine)}` : ""}`,
  decision: turbo.state === "active" ? "The extension runs once the folder is trusted: the fix is trust, nothing else." : "Record the separate cause found here and fix that before relying on trust.",
};

// =====================================================================================================
// Q3: each candidate route, each on its own server and browser profile
// =====================================================================================================
log("\n== Q3 settings and keybindings route ==");
const routes = [];
const mirroredSettings = readJson(path.join(profile, "settings.json"));
async function tryRoute(name, prepare, afterOpen) {
  const dir = path.join(work, `server-data-${name}`);
  fs.mkdirSync(path.join(dir, "data/User"), { recursive: true });
  fs.mkdirSync(path.join(dir, "data/Machine"), { recursive: true });
  const port = await freePort();
  await prepare(dir);
  const s = await startServer(name, dir, port);
  const b = await startBrowser(name);
  try {
    await b.open(s);
    if (afterOpen) { await afterOpen(b, s); await b.ev("location.reload()"); await sleep(3); await until(() => b.ev("document.querySelector('.part.editor')?.offsetWidth > 0"), 90, "the reload"); await sleep(3); }
    await openFile(b, "pd.js");
    const fs_ = await fontSize(b);
    // the keybinding: click into the editor, press it, and see whether the side bar went away
    const w0 = await sidebarWidth(b);
    await b.ev("document.querySelector('.monaco-editor .view-lines')?.click()");
    await b.key("9", "Digit9", 57, 3); // Ctrl+Alt+9
    await sleep(1.5);
    const w1 = await sidebarWidth(b);
    const row = { name, fontSize: fs_, settingArrived: fs_ === `${SPIKE_FONT}px`, sidebarBefore: w0, sidebarAfter: w1, keybindingArrived: w0 > 0 && w1 === 0 };
    log(`  route ${name}: fontSize ${fs_} (baseline ${baselineFont}) -> setting ${row.settingArrived ? "ARRIVED" : "no"}; side bar ${w0} -> ${w1} -> keybinding ${row.keybindingArrived ? "ARRIVED" : "no"}`);
    return row;
  } finally {
    b.close();
    stopPid(s.pid);
    await sleep(1);
  }
}
routes.push({
  ...(await tryRoute("indexeddb", async () => {}, async (b) => {
    // the plugin's existing path: buildBrowserSeedScript with a copy of the instance's settings and keybindings
    const copy = { id: "spike", settings: mirroredSettings, keybindingsBase64: fs.readFileSync(path.join(profile, "keybindings.json")).toString("base64") };
    const outcome = await b.ev(settings.buildBrowserSeedScript(settings.BROWSER_APP_SETTINGS, copy));
    log(`  seed script outcome: ${outcome}`);
  })),
  description: "the IndexedDB write of buildBrowserSeedScript (WORKBENCH_SETTINGS_KEY /User/settings.json and /User/keybindings.json)",
});
routes.push({
  ...(await tryRoute("server-user", async (dir) => {
    fs.copyFileSync(path.join(profile, "settings.json"), path.join(dir, "data/User/settings.json"));
    fs.copyFileSync(path.join(profile, "keybindings.json"), path.join(dir, "data/User/keybindings.json"));
  })),
  description: "the server's own User folder (<server-data-dir>/data/User/settings.json and keybindings.json)",
});
routes.push({
  ...(await tryRoute("machine", async (dir) => {
    const machine = path.join(dir, "data/Machine/settings.json");
    fs.mkdirSync(path.dirname(machine), { recursive: true });
    fs.writeFileSync(machine, JSON.stringify({ ...mirroredSettings }, null, 2));
  })),
  description: "the server's Machine settings file (<server-data-dir>/data/Machine/settings.json; keybindings have no machine file)",
});
const settingRoute = routes.find((r) => r.settingArrived);
const keyRoute = routes.find((r) => r.keybindingArrived);
const arrives = Boolean(settingRoute || keyRoute);
const routeText = routes.map((r) => `${r.description}: setting ${r.settingArrived ? `arrived (editor.fontSize ${baselineFont} -> ${r.fontSize})` : `did not arrive (${r.fontSize})`}, keybinding ${r.keybindingArrived ? `arrived (side bar ${r.sidebarBefore}px -> ${r.sidebarAfter}px)` : "did not arrive"}`).join(" | ");
result.settingsRoute = {
  arrives,
  route: !arrives ? null : settingRoute && keyRoute && settingRoute === keyRoute ? settingRoute.description : [settingRoute && `settings: ${settingRoute.description}`, keyRoute && `keybindings: ${keyRoute.description}`].filter(Boolean).join("; "),
  result: routeText,
  decision: arrives
    ? `PR-6 builds on ${[...new Set([settingRoute?.description, keyRoute?.description].filter(Boolean))].join(" and on ")}.`
    : "STOP: neither the profile's settings nor its keybindings reach the tab by any route; ask Dan before the profile settings work is built.",
};

// =====================================================================================================
// F1 guard and the result
// =====================================================================================================
const after = snapshot();
const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]);
log(`\nF1 snapshot after: ${Object.keys(after).length} entries; changed: ${changed.length ? changed.join(", ") : "none"}`);
fs.writeFileSync(path.join(outDir, "extension-spike-result.json"), JSON.stringify({ ...result, q1, q4, routes, baselineFont, baselineSidebar }, null, 2));
log(`\nresult: ${path.join(outDir, "extension-spike-result.json")}`);
log(JSON.stringify(result, null, 2));
if (changed.length) {
  console.error(`FAIL  the desktop instance changed while the spike ran (the script writes nothing there; is VS Code Insiders running?): ${changed.join(", ")}`);
  process.exit(1);
}
log("PASS  the instance's extensions.json, settings.json, keybindings.json and globalStorage are unchanged");
process.exit(0);
