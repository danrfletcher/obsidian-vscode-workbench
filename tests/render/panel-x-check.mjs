/**
 * Live check of the X in VS Code's terminal panel (ticket warkworth-54, PR-1), on a real `code serve-web` server in a real
 * headless Chrome. The drawer closes itself when the host page's layout shows a painted workbench without its panel
 * (src/terminal-host/host-page.ts `checkPanel`, built on src/terminal-host/panel-only.ts). Unit tests feed that code a made-up
 * layout; this script asks whether VS Code really produces it:
 *
 *   X1  the page is panel-only, and the plugin's own `isPanelOnly` says so
 *   X2  a real mouse click on the panel's close (X) button leaves a layout the plugin reads as "painted, no panel"
 *       (`isPainted` true, `partShown(panel)` false), the layout `checkPanel` closes the drawer on
 *   X3  the panel comes back (Ctrl+`) and the layout is panel-only again, so a reopened drawer is not left blank
 *
 * Not part of `npm test`: it needs a VS Code build with `serve-web` and Google Chrome. It starts the server through the plugin's
 * `buildServeWebArgs` on 127.0.0.1 with a token file, on a free port it picks itself, and headless Chrome (--mute-audio) on a free
 * debugging port, and stops what it started, by PID, at the end.
 *
 *   CODE_CLI=<code binary> CHROME=<chrome> ALLOW_DOWNLOAD=1 node tests/render/panel-x-check.mjs [outDir]
 *   # or CLI_DATA_SRC=<a --cli-data-dir holding the server> SERVER_COMMIT=<its commit> instead of ALLOW_DOWNLOAD=1
 *
 * Exit codes: 0 every check held, 1 a check failed, 2 could not run (a missing tool, no server, a page that never painted).
 */
import { build } from "esbuild";
import { execFileSync, spawn } from "node:child_process";
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
    console.error(`panel X check needs ${name}${f ? ` (${f} does not exist)` : " (not set)"}`);
    process.exit(2);
  }
}
const [, installedCommit] = execFileSync(CODE, ["--version"], { encoding: "utf8" }).trim().split("\n");
const commit = process.env.SERVER_COMMIT ?? installedCommit;
const held = CLI_DATA_SRC && fs.existsSync(path.join(CLI_DATA_SRC, "serve-web")) ? fs.readdirSync(path.join(CLI_DATA_SRC, "serve-web")) : [];
const haveServer = held.includes(commit);
if (!haveServer && !ALLOW_DOWNLOAD) {
  console.error(`panel X check cannot run: no cached VS Code server for ${commit}. Set CLI_DATA_SRC (and SERVER_COMMIT), or ALLOW_DOWNLOAD=1.`);
  process.exit(2);
}
const scratchBase = process.env.TMPDIR ?? os.tmpdir();
const work = fs.mkdtempSync(path.join(scratchBase, "panel-x-"));
const outDir = path.resolve(process.argv[2] ?? work);
fs.mkdirSync(outDir, { recursive: true });
const MOD = process.platform === "darwin" ? 4 : 2; // CDP modifier bits: 2 ctrl, 4 meta

// everything started is recorded by PID and stopped by PID, nothing else
const started = new Set();
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const failures = [];
const check = (ok, what, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail === undefined ? "" : `  (${detail})`}`);
  if (!ok) failures.push(what);
};
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function subtree(rootPid) {
  const rows = execFileSync("ps", ["-axww", "-o", "pid=,ppid="], { encoding: "utf8" }).split("\n").map((l) => /^\s*(\d+)\s+(\d+)/.exec(l)).filter(Boolean).map((m) => [+m[1], +m[2]]);
  const out = [rootPid];
  const walk = (p) => { for (const [pid, ppid] of rows) if (ppid === p) { out.push(pid); walk(pid); } };
  walk(rootPid);
  return out;
}
async function stopAll() {
  for (const rootPid of [...started]) {
    const pids = subtree(rootPid);
    for (const p of pids) { try { process.kill(p, "SIGTERM"); } catch { /* gone */ } }
    for (let i = 0; i < 20 && pids.some(isAlive); i++) await sleep(0.1);
    for (const p of pids) if (isAlive(p)) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
    started.delete(rootPid);
  }
}
process.on("exit", () => { for (const r of started) for (const p of subtree(r)) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } } });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); s.on("error", reject); });
const until = async (fn, seconds, what) => { for (let i = 0; i < seconds * 2; i++) { const v = await fn(); if (v) return v; await sleep(0.5); } throw new Error(`timed out waiting for ${what}`); };

// the plugin's own code
await build({
  entryPoints: {
    settings: path.join(root, "src/settings.ts"),
    trust: path.join(root, "src/trust/trust-seed.ts"),
    paths: path.join(root, "src/paths.ts"),
    server: path.join(root, "src/server.ts"),
    panel: path.join(root, "src/terminal-host/panel-only.ts"),
  },
  bundle: true, format: "esm", platform: "node", outdir: path.join(work, "plugin"), outExtension: { ".js": ".mjs" }, logLevel: "error",
});
const load = (n) => import(pathToFileURL(path.join(work, `plugin/${n}.mjs`)).href);
const [settings, trust, paths, serverMod, panelMod] = await Promise.all(["settings", "trust", "paths", "server", "panel"].map(load));

const vault = path.join(work, "vault");
fs.mkdirSync(vault, { recursive: true });
fs.writeFileSync(path.join(vault, "note.md"), "# a note\n");
const runtime = path.join(work, "runtime");
const serverData = path.join(runtime, "server-data");
const cliData = path.join(runtime, "cli-data");
fs.mkdirSync(serverData, { recursive: true });
settings.writeMachineSettings(serverData, { dark: true });
if (haveServer) fs.cpSync(CLI_DATA_SRC, cliData, { recursive: true }); else fs.mkdirSync(cliData, { recursive: true });
const tokenFile = path.join(runtime, "token");

async function startServer(port) {
  const token = serverMod.createTokenFile(tokenFile);
  const logFile = path.join(work, "server.log");
  const args = serverMod.buildServeWebArgs({ port, tokenFile, serverDataDir: serverData, cliDataDir: cliData, acceptLicense: true, disableTelemetry: true, commitId: commit });
  // the server listens on a unix socket under TMPDIR; macOS caps socket paths at 104 characters, so it gets a short TMPDIR
  const child = spawn(CODE, args, { detached: true, stdio: ["ignore", fs.openSync(logFile, "w"), "ignore"], env: { ...process.env, TMPDIR: "/tmp" } });
  started.add(child.pid);
  console.log(`server wrapper pid ${child.pid} on 127.0.0.1:${port}`);
  let answered = 0;
  for (let i = 0; i < (haveServer ? 60 : 400); i++) {
    answered = await fetch(`http://127.0.0.1:${port}/?tkn=${token}`, { redirect: "manual", signal: AbortSignal.timeout(3000) }).then((r) => r.status, () => 0);
    if (answered === 302 || answered === 200 || answered >= 500) break;
    await sleep(1);
  }
  if (answered !== 302 && answered !== 200) { console.error(`the server did not come up (answered ${answered}; see ${logFile})`); process.exit(2); }
  await sleep(3);
  return { port, token, origin: `http://127.0.0.1:${port}` };
}

async function startChrome() {
  const cdpPort = await freePort();
  const chrome = spawn(CHROME, ["--headless=new", "--mute-audio", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${path.join(work, "chrome")}`, "--no-first-run", "--disable-background-networking", "about:blank"], { stdio: "ignore" });
  started.add(chrome.pid);
  console.log(`chrome pid ${chrome.pid}, debugging port ${cdpPort}`);
  const ver = await until(() => fetch(`http://127.0.0.1:${cdpPort}/json/version`).then((r) => r.json(), () => null), 30, "Chrome's debugging port");
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) pend.get(d.id)(d); };
  const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const targetId = (await send("Target.createTarget", { url: "about:blank" })).result.targetId;
  const sessionId = (await send("Target.attachToTarget", { targetId, flatten: true })).result.sessionId;
  const p = (method, params) => send(method, params, sessionId);
  await p("Page.enable");
  await p("Runtime.enable");
  await p("Emulation.setFocusEmulationEnabled", { enabled: true });
  await p("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  const page = { send: p };
  page.ev = async (e) => {
    const r = (await p("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result;
    return r?.result?.value ?? (r?.exceptionDetails ? `ERROR ${r.exceptionDetails.exception?.description}` : undefined);
  };
  page.key = async (k, code, vk, modifiers = 0) => { for (const type of ["rawKeyDown", "keyUp"]) await p("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, modifiers }); };
  page.click = async (x, y) => {
    await p("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await p("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await p("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  page.shot = async (file) => { fs.writeFileSync(path.join(outDir, file), Buffer.from((await p("Page.captureScreenshot", { format: "png" })).result.data, "base64")); console.log(`  screenshot ${path.join(outDir, file)}`); };
  page.goto = (u) => p("Page.navigate", { url: u });
  return page;
}

/** The plugin's own reading of the page: the same script and parser the host page uses. */
const readLayout = async (page) => panelMod.parseLayout(await page.ev(panelMod.LAYOUT_SCRIPT));
const fmt = (l) => (l ? panelMod.PART_NAMES.map((n) => `${n} ${l.parts[n] ? l.parts[n].join("x") : "none"}`).join(", ") : "no layout");

try {
  const srv = await startServer(await freePort());
  const page = await startChrome();
  await page.goto(`${srv.origin}/manifest.json?tkn=${srv.token}`);
  await sleep(1);
  // the terminal page's profile: the plugin's chrome-hiding settings, and the panel filling the window when it opens
  const base = { ...settings.workbenchOverlay({ dark: true }), ...settings.BROWSER_APP_SETTINGS, "workbench.startupEditor": "none", "workbench.panel.opensMaximized": "always" };
  await page.ev(settings.buildBrowserSeedScript(base));
  await page.ev(trust.buildTrustSeedScript({ origin: srv.origin, folderUri: paths.buildFileUri(srv.origin, vault), heldPorts: [srv.port] }));
  await page.goto(`${srv.origin}/?tkn=${srv.token}&folder=${encodeURIComponent(vault)}`);
  try {
    await until(async () => { const l = await readLayout(page); return l && panelMod.isPainted(l); }, 120, "the workbench to paint");
  } catch (e) { console.error(String(e)); process.exit(2); }
  await sleep(4);

  // the two key presses that make the page panel-only (in production the plugin's extension runs the same VS Code commands)
  await page.ev("document.body.click()");
  await page.key("`", "Backquote", 192, 2); // Ctrl+`: open the terminal panel
  await sleep(5);
  await page.key("b", "KeyB", 66, MOD); // Cmd/Ctrl+B: hide the side bar
  await sleep(2);
  const before = await readLayout(page);
  console.log("layout, panel open:", fmt(before));
  await page.shot("panel-x-1-before.png");
  check(!!before && panelMod.isPanelOnly(before), "X1: the page is panel-only (the plugin's isPanelOnly)", fmt(before));

  // the X: the panel's close button, found by its label and clicked with a real mouse event at its centre
  const btn = await page.ev(`(() => {
    const els = [...document.querySelectorAll('.part.panel .title-actions .action-label, .part.panel .title .action-label')];
    const e = els.find((x) => /close panel|hide panel/i.test((x.getAttribute('aria-label') || '') + ' ' + (x.title || '')));
    if (!e) return JSON.stringify({ found: false, labels: els.map((x) => x.getAttribute('aria-label') || x.title || x.className) });
    const b = e.getBoundingClientRect();
    return JSON.stringify({ found: true, label: e.getAttribute('aria-label') || e.title, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
  })()`);
  const target = JSON.parse(btn);
  check(target.found, "X2: the panel has a close (X) button", target.found ? `"${target.label}" at ${target.x},${target.y}` : `labels seen: ${JSON.stringify(target.labels)}`);
  if (target.found) {
    await page.click(target.x, target.y);
    const after = await until(async () => { const l = await readLayout(page); return l && !panelMod.partShown(l, "panel") ? l : null; }, 10, "the panel to close").catch(() => null);
    const l = after ?? (await readLayout(page));
    console.log("layout, after the X:", fmt(l));
    await page.shot("panel-x-2-after-x.png");
    check(!!after, "X2: after a real click on the X the panel is gone", fmt(l));
    check(!!l && panelMod.isPainted(l) && !panelMod.partShown(l, "panel"), "X2: ...and the plugin reads it as painted without a panel, the layout checkPanel closes the drawer on", fmt(l));

    await page.ev("document.body.click()");
    await page.key("`", "Backquote", 192, 2);
    const again = await until(async () => { const x = await readLayout(page); return x && panelMod.isPanelOnly(x) ? x : null; }, 10, "the panel to come back").catch(() => null);
    await page.shot("panel-x-3-restored.png");
    check(!!again, "X3: the panel comes back and the page is panel-only again", fmt(again ?? (await readLayout(page))));
  }
} finally {
  await stopAll();
}
console.log(failures.length ? `\n${failures.length} check(s) FAILED` : "\nall checks held");
process.exit(failures.length ? 1 : 0);
