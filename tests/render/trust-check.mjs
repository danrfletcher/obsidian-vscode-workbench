/**
 * Real-server check for G5, G6 (seeded vs not), G17 and E11: the plugin's trust seed makes the workbench open
 * the vault folder trusted, so a stock extension that does not run in Restricted Mode activates, and nothing else
 * is trusted.
 *
 * Not part of `npm test`: it needs a VS Code build with `serve-web`, a cached VS Code server for that build (or
 * ALLOW_DOWNLOAD=1) and Google Chrome. It runs the plugin's own code (buildTrustSeedScript, buildFileUri,
 * shareExtensions) against a scratch dir and asserts, each in a fresh browser profile:
 *   1. control, no seed: the Restricted Mode banner is shown and the probe extension does not activate;
 *   2. seeded (the Code tab's order: bare origin, seed script, workbench): no banner, no click, the probe
 *      extension activates (it declares untrustedWorkspaces.supported = false, so only a trusted folder runs it);
 *   3. the seeded record holds exactly one entry, for the vault folder; the page reloaded twice still holds one;
 *   4. a different folder opened on the same server, same browser profile: Restricted Mode (G17);
 *   5. the server restarted on a new port, same browser profile, seed run again: no banner, no click, the new
 *      origin's record holds one entry (its own); then the old port is served again and its origin's own record is
 *      read: it is still there, untouched (one browser database per origin, so the new seed cannot reach it and does
 *      not clean it up; the record is inert, and the plugin does not claim to remove it).
 *
 *   npm run check:trust [outDir]
 *
 * Env: CODE_CLI (the build's `code` script), CLI_DATA_SRC (a --cli-data-dir that already holds the server for
 * that build; cloned into the scratch dir, never written to) or ALLOW_DOWNLOAD=1 (serve-web fetches the server
 * into the scratch dir), CHROME, SERVER_TMPDIR (default /tmp, see the comment at the spawn). Everything it starts
 * runs on a free scratch port it picks, and is stopped by PID at the end. It never reads or writes a VS Code user-data folder.
 *
 * Exit codes: 0 all checks passed, 1 a check failed, 2 it could not run (missing tool or cached server, server did not come up).
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
const scratchBase = process.env.TMPDIR ?? os.tmpdir();

const started = []; // every PID this script started (roots); stopped at the end, nothing else is
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const failures = [];
const log = (...a) => console.log(...a);
const check = (ok, what, detail) => {
  log(`${ok ? "PASS" : "FAIL"}  ${what}${detail === undefined ? "" : `  (${detail})`}`);
  if (!ok) failures.push(what);
};
function stop(code, msg) {
  console.error(msg);
  process.exit(code);
}

for (const [name, f] of [["CODE_CLI", CODE], ["CHROME", CHROME]]) {
  if (!fs.existsSync(f)) stop(2, `trust check needs ${name} (${f} does not exist)`);
}
const [version, commit] = execFileSync(CODE, ["--version"], { encoding: "utf8" }).trim().split("\n");
const held = CLI_DATA_SRC && fs.existsSync(path.join(CLI_DATA_SRC, "serve-web")) ? fs.readdirSync(path.join(CLI_DATA_SRC, "serve-web")).filter((n) => /^[0-9a-f]{40}$/.test(n)) : [];
const haveServer = held.includes(commit);
if (!haveServer && !ALLOW_DOWNLOAD) {
  stop(2, `trust check cannot run: ${CODE} is ${version} (server commit ${commit}) and no cached server is set up. Set CLI_DATA_SRC to a --cli-data-dir whose serve-web/ holds ${commit}, or ALLOW_DOWNLOAD=1 to let serve-web fetch it into the scratch dir.`);
}

const work = fs.mkdtempSync(path.join(scratchBase, "trust-check-"));
const outDir = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(scratchBase, "trust-shots-")));
fs.mkdirSync(outDir, { recursive: true });

function descendants(pid) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
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
}
function stopAll() {
  for (const p of started) stopPid(p);
}
process.on("exit", stopAll);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

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
async function until(fn, seconds, what) {
  for (let i = 0; i < seconds * 2; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(0.5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// --- the plugin's own code ---------------------------------------------------------------------------
await build({
  entryPoints: { paths: path.join(root, "src/paths.ts"), "trust-seed": path.join(root, "src/trust/trust-seed.ts"), server: path.join(root, "src/server.ts") },
  bundle: true, format: "esm", platform: "node", outdir: path.join(work, "plugin"), outExtension: { ".js": ".mjs" }, logLevel: "error",
});
const load = (n) => import(pathToFileURL(path.join(work, `plugin/${n}.mjs`)).href);
const paths = await load("paths");
const trust = await load("trust-seed");
const pluginServer = await load("server");

// --- the fixtures: two folders and a probe extension that only runs in a trusted folder ---------------------
const vault = path.join(work, "My Vault ü"); // a space and a non-ASCII character on purpose
const other = path.join(work, "other-folder");
for (const d of [vault, other]) {
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "a.js"), "const total = 41 + 1;\n");
}
const EXT_ID = "fixture.trust-probe";
const extSrc = path.join(work, "ext-src");
const extDir = path.join(extSrc, `${EXT_ID}-0.0.1`);
fs.mkdirSync(extDir, { recursive: true });
fs.writeFileSync(path.join(extDir, "package.json"), JSON.stringify({
  name: "trust-probe", publisher: "fixture", version: "0.0.1", engines: { vscode: "^1.80.0" },
  main: "./extension.js", activationEvents: ["onStartupFinished"], extensionKind: ["workspace"],
  capabilities: { untrustedWorkspaces: { supported: false, description: "the trust check's probe" } },
}));
fs.writeFileSync(path.join(extDir, "extension.js"), "const fs = require('fs'), path = require('path');\nexports.activate = () => fs.appendFileSync(path.join(__dirname, 'activated.log'), Date.now() + '\\n');\n");
fs.writeFileSync(path.join(extSrc, "extensions.json"), JSON.stringify([{ identifier: { id: EXT_ID }, version: "0.0.1", location: { $mid: 1, path: extDir, scheme: "file" }, relativeLocation: path.basename(extDir), metadata: {} }]));
const activations = (serverData) => {
  const f = path.join(serverData, "extensions", path.basename(extDir), "activated.log"); // the symlink resolves to extDir
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).length : 0;
};

const cliData = path.join(work, "cli-data");
if (haveServer) fs.cpSync(CLI_DATA_SRC, cliData, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
else fs.mkdirSync(cliData, { recursive: true });

// --- a server and a browser --------------------------------------------------------------------------
async function startServer(name, port) {
  const serverData = path.join(work, `server-data-${name}`);
  fs.mkdirSync(serverData, { recursive: true });
  pluginServer.shareExtensions(extSrc, serverData);
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
  return { name, port, token, pid: server.pid, serverData, origin: `http://127.0.0.1:${port}` };
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
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) pend.get(d.id)(d);
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  const b = {
    pid: chrome.pid,
    ev: async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value,
    shot: async (file) => {
      const s = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(outDir, file), Buffer.from(s.result.data, "base64"));
      log(`  screenshot ${path.join(outDir, file)}`);
    },
    navigate: (url) => send("Page.navigate", { url }),
    /** What the Code tab does: the bare origin first, the seed script in that page, then the workbench. */
    seedThenOpen: async (srv, folder, heldPorts, { seed = true } = {}) => {
      if (seed) {
        await b.navigate(`${srv.origin}/`);
        await sleep(3);
        const script = trust.buildTrustSeedScript({ origin: srv.origin, folderUri: paths.buildFileUri(srv.origin, vault), heldPorts });
        const outcome = await b.ev(script);
        check(outcome === "seeded", `[${srv.name}] the trust seed answered seeded`, outcome);
      }
      await b.open(srv, folder);
    },
    open: async (srv, folder) => {
      await b.navigate(`${srv.origin}/?tkn=${srv.token}&folder=${encodeURIComponent(folder)}`);
      await until(() => b.ev("document.querySelector('.part.editor')?.offsetWidth > 0"), 90, "the workbench to paint");
      await sleep(8); // the Restricted Mode banner and the extension host settle
    },
    close: () => {
      ws.close();
      stopPid(chrome.pid);
    },
  };
  return b;
}

/** The Restricted Mode banner is on screen (a hidden banner keeps its text, so its height is read too). */
const restricted = async (b) =>
  (await b.ev("document.querySelector('.part.banner')?.offsetHeight ?? 0")) > 0 && /Restricted Mode/.test((await b.ev("document.querySelector('.part.banner')?.innerText ?? ''")) || "");
/** The stored trust record, read through the page: the entries of uriTrustInfo, or null when there is none. */
const record = async (b) => {
  const raw = await b.ev(`(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open(${JSON.stringify(trust.TRUST_DB_NAME)}); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    try {
      if (!db.objectStoreNames.contains(${JSON.stringify(trust.TRUST_STORE)})) return null;
      return await new Promise((res) => { const q = db.transaction(${JSON.stringify(trust.TRUST_STORE)}).objectStore(${JSON.stringify(trust.TRUST_STORE)}).get(${JSON.stringify(trust.TRUST_KEY)}); q.onsuccess = () => res(q.result ?? null); });
    } finally { db.close(); }
  })()`);
  return raw ? JSON.parse(raw).uriTrustInfo : null;
};
const vaultPath = (p) => p; // the record holds the decoded path

try {
  // 1. control: no seed
  log("\n== control: no seed ==");
  const portA = await freePort();
  const control = await startServer("control", portA);
  const bc = await startBrowser("control");
  await bc.open(control, vault);
  await bc.shot("trust-control-restricted.png");
  check(await restricted(bc), "control: without the seed the Restricted Mode banner is shown");
  check(activations(control.serverData) === 0, "control: the probe extension did not activate in Restricted Mode", activations(control.serverData));
  bc.close();
  stopPid(control.pid);

  // 2-4. seeded, reloads, another folder: one server, one browser profile
  log("\n== seeded ==");
  const portB = await freePort();
  const srv = await startServer("seeded", portB);
  const b = await startBrowser("seeded");
  await b.seedThenOpen(srv, vault, [portB]);
  await b.shot("trust-seeded.png");
  check(!(await restricted(b)), "seeded: no Restricted Mode banner, and nobody clicked Trust");
  await until(() => activations(srv.serverData) > 0, 30, "the probe extension to activate").then(
    () => check(true, "seeded: the probe extension (untrustedWorkspaces: false) activated"),
    () => check(false, "seeded: the probe extension (untrustedWorkspaces: false) activated", "no activation"),
  );
  const entries = await record(b);
  check(Array.isArray(entries) && entries.length === 1, "seeded: the record holds exactly one entry", entries && entries.length);
  check(entries?.[0]?.uri?.path === vaultPath(vault) && entries[0].uri.authority === `127.0.0.1:${portB}` && entries[0].trusted === true, "seeded: that entry is the vault folder on this server's authority", JSON.stringify(entries?.[0]));

  for (const n of [1, 2]) {
    await b.seedThenOpen(srv, vault, [portB]); // a tab reload runs the seed again
    const after = await record(b);
    check(Array.isArray(after) && after.length === 1, `reload ${n}: still one record, no duplicate`, after && after.length);
    check(!(await restricted(b)), `reload ${n}: still trusted`);
  }

  log("\n== a different folder on the same server (G17) ==");
  await b.open(srv, other);
  await b.shot("trust-other-folder-restricted.png");
  check(await restricted(b), "another folder opened on the same server is still untrusted (Restricted Mode banner)");
  const afterOther = await record(b);
  check(Array.isArray(afterOther) && afterOther.length === 1 && afterOther[0].uri.path === vault, "opening it added no trust entry");

  // 5. restart on a new port, same browser profile
  log("\n== restart on a new port ==");
  stopPid(srv.pid);
  const portC = await freePort();
  const restarted = await startServer("restarted", portC);
  await b.seedThenOpen(restarted, vault, [portC]); // only the new server is running
  await b.shot("trust-new-port.png");
  check(!(await restricted(b)), "new port: the reseed makes the tab open trusted without a click");
  const afterRestart = await record(b);
  check(Array.isArray(afterRestart) && afterRestart.length === 1 && afterRestart[0].uri.authority === `127.0.0.1:${portC}`, "new port: the new origin's database holds one record, its own", JSON.stringify(afterRestart?.map((e) => e.uri.authority)));

  // The old origin's own database: read it by serving the old port again (nothing seeds it). The new seed ran in
  // another origin, so it cannot have removed this record; the check pins that, rather than claiming a cleanup.
  stopPid(restarted.pid);
  const portBFree = await new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(portB, "127.0.0.1", () => s.close(() => resolve(true)));
  });
  if (!portBFree) log(`  skipped: the old port ${portB} was taken meanwhile, so the old origin's record cannot be read`);
  else {
    const again = await startServer("old-port-again", portB);
    await b.navigate(`${again.origin}/`);
    await sleep(3);
    const oldRecord = await record(b);
    check(
      Array.isArray(oldRecord) && oldRecord.length === 1 && oldRecord[0].uri.authority === `127.0.0.1:${portB}` && oldRecord[0].uri.path === vault && oldRecord[0].trusted === true,
      "old port: its origin's own record is still there (the new port's seed does not and cannot clean it up)",
      JSON.stringify(oldRecord?.map((e) => e.uri.authority)),
    );
    await b.open(again, vault);
    check(!(await restricted(b)), "old port: served again, the vault opens trusted from the record that stayed");
  }
  b.close();
} catch (e) {
  check(false, "the check ran to the end", e instanceof Error ? e.message : String(e));
}

stopAll();
fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
