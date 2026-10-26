/**
 * Real-server check for G16 and G17: a copied setting, a copied keybinding and the workspace excludes
 * take effect in the running workbench, not just exist as files.
 *
 * Not part of `npm test`: it needs a VS Code build with `serve-web`, a cached VS Code server for that
 * build, and Google Chrome. It runs the plugin's own code (seedUserData, writeMachineSettings,
 * buildBrowserSeedScript) against a scratch dir, starts `serve-web` on a free loopback port, loads the
 * workbench in headless Chrome and asserts:
 *   1. editor.fontSize copied from the instance's settings.json is the font size of an open editor;
 *   2. a keybinding copied from the instance's keybindings.json runs its command (it toggles the side bar);
 *   3. a search for a word that occurs in src/a.txt, .obsidian/, Attachments/ and a folder the instance
 *      excluded itself finds only src/a.txt: the five workspace excludes and the instance's own exclude
 *      are all in force together.
 * A control run (same server, fresh browser profile, no seed script) must show the opposite for 1 and 2:
 * the files in <server-data>/data/User alone change nothing, which is why the browser profile is seeded.
 *
 *   npm run check:user-data [outDir]
 *
 * Env: CODE_CLI (the build's `code` script), CLI_DATA_SRC (a --cli-data-dir that already holds the
 * server for that build; it is cloned into the scratch dir, never written to; nothing is downloaded),
 * CHROME, SERVER_TMPDIR (default /tmp, see the comment at the spawn). Everything it starts runs on scratch ports and is stopped by PID at the end.
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
for (const [name, f] of [["CODE_CLI", CODE], ["CHROME", CHROME], ["CLI_DATA_SRC", CLI_DATA_SRC]]) {
  if (!f || !fs.existsSync(f)) {
    console.error(`user-data check needs ${name}${f ? ` (${f} does not exist)` : " (not set)"}`);
    process.exit(2);
  }
}
const work = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "user-data-check-"));
const outDir = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "user-data-shots-")));
fs.mkdirSync(outDir, { recursive: true });

const started = []; // every PID this script started (roots); stopped at the end, nothing else is
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const failures = [];
const check = (ok, what, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail === undefined ? "" : `  (${detail})`}`);
  if (!ok) failures.push(what);
};

function descendants(pid) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number));
  const out = [];
  const walk = (p) => {
    for (const [c, pp] of rows) if (pp === p) { walk(c); out.push(c); }
  };
  walk(pid);
  return out;
}
function stopAll() {
  for (const root_ of started) {
    for (const pid of [...descendants(root_), root_]) {
      try { process.kill(pid); } catch { /* already gone */ }
    }
  }
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

// --- the plugin's own code ---------------------------------------------------------------------------
await build({
  entryPoints: { "user-data-seed": path.join(root, "src/server/user-data-seed.ts"), settings: path.join(root, "src/settings.ts") },
  bundle: true, format: "esm", platform: "node", outdir: path.join(work, "plugin"), outExtension: { ".js": ".mjs" }, logLevel: "error",
});
const seed = await import(pathToFileURL(path.join(work, "plugin/user-data-seed.mjs")).href);
const settings = await import(pathToFileURL(path.join(work, "plugin/settings.mjs")).href);

// --- the fixtures ------------------------------------------------------------------------------------
const vault = path.join(work, "vault");
for (const d of [".obsidian", "Attachments", "skipme", "src"]) fs.mkdirSync(path.join(vault, d), { recursive: true });
fs.writeFileSync(path.join(vault, "src/a.txt"), "zzmarker in a visible file\n");
fs.writeFileSync(path.join(vault, ".obsidian/hit.txt"), "zzmarker in obsidian\n");
fs.writeFileSync(path.join(vault, "Attachments/att.txt"), "zzmarker in attachments\n");
fs.writeFileSync(path.join(vault, "skipme/mine.txt"), "zzmarker in the instance's own excluded folder\n");

const FONT = 31;
const instanceUser = path.join(work, "instance-user");
fs.mkdirSync(instanceUser, { recursive: true });
fs.writeFileSync(path.join(instanceUser, "settings.json"), `{\n  // mine\n  "editor.fontSize": ${FONT},\n  "search.exclude": { "**/skipme": true },\n}\n`);
fs.writeFileSync(path.join(instanceUser, "keybindings.json"), '// mine\n[ { "key": "ctrl+alt+n", "command": "workbench.action.toggleSidebarVisibility" } ]\n');

const runtime = path.join(work, "runtime");
const serverData = path.join(runtime, "server-data");
const userData = path.join(serverData, "data");
fs.mkdirSync(userData, { recursive: true });
const seeded = seed.seedUserData({ userDataDir: userData, sourceUserDir: instanceUser });
settings.writeMachineSettings(serverData, { dark: true });
const copy = { id: "check-1", settings: seeded.merged, keybindingsBase64: seeded.keybindingsBase64 };

// --- the server --------------------------------------------------------------------------------------
const cliData = path.join(runtime, "cli-data");
fs.cpSync(CLI_DATA_SRC, cliData, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
const commit = execFileSync(CODE, ["--version"], { encoding: "utf8" }).trim().split("\n")[1];
if (!fs.existsSync(path.join(cliData, "serve-web", commit))) {
  console.error(`CLI_DATA_SRC has no cached server for ${CODE} (commit ${commit}); this check never downloads one`);
  process.exit(2);
}
const token = "tok" + "x".repeat(24);
const tokenFile = path.join(runtime, "token");
fs.writeFileSync(tokenFile, token, { mode: 0o600 });
const serverPort = await freePort();
const server = spawn(
  CODE,
  ["serve-web", "--host", "127.0.0.1", "--port", String(serverPort), "--connection-token-file", tokenFile, "--server-data-dir", serverData, "--cli-data-dir", cliData, "--disable-telemetry", "--commit-id", commit, "--accept-server-license-terms"],
  {
    stdio: ["ignore", fs.openSync(path.join(work, "server.log"), "w"), "ignore"],
    // The server listens on a unix socket `<TMPDIR>/code-insiders-<uuid>`; macOS caps socket paths at 104
    // characters and a scratch dir is longer than that, so the server (and only the server) gets a short TMPDIR.
    env: { ...process.env, TMPDIR: process.env.SERVER_TMPDIR ?? "/tmp" },
  },
);
started.push(server.pid);
console.log(`server pid ${server.pid} on 127.0.0.1:${serverPort}`);
// Up once the origin answers at all (it says 403 without the token); the first workbench load waits for the rest.
for (let i = 0; ; i++) {
  const answered = await fetch(`http://127.0.0.1:${serverPort}/`, { signal: AbortSignal.timeout(3000) }).then(() => true, () => false);
  if (answered) break;
  if (i === 40) { console.error("server did not come up"); process.exit(1); }
  await sleep(1);
}
await sleep(3);

// --- one browser run ---------------------------------------------------------------------------------
async function scenario(name, seedBrowser) {
  const cdpPort = await freePort();
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${path.join(work, "chrome-" + name)}`, "--no-first-run", "--disable-background-networking", "about:blank"], { stdio: "ignore" });
  started.push(chrome.pid);
  await sleep(5);
  const page = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pend = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) pend.get(d.id)(d);
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const key = async (k, code, vk, modifiers = 0) => {
    for (const type of ["rawKeyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, modifiers });
  };
  const META = 4, SHIFT = 8, CTRL = 2, ALT = 1;
  await send("Page.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });

  const origin = `http://127.0.0.1:${serverPort}`;
  if (seedBrowser) {
    // what the Code tab does: the bare origin first, the seed script, then the workbench
    await send("Page.navigate", { url: `${origin}/` });
    await sleep(3);
    const outcome = await ev(settings.buildBrowserSeedScript(settings.BROWSER_APP_SETTINGS, copy));
    check(outcome === "seeded", `${name}: the seed script ran in the page`, outcome);
  }
  await send("Page.navigate", { url: `${origin}/?tkn=${token}&folder=${encodeURIComponent(vault)}` });
  await sleep(20);

  // open src/a.txt (Cmd+P)
  await key("p", "KeyP", 80, META);
  await sleep(1.5);
  await send("Input.insertText", { text: "a.txt" });
  await sleep(1.5);
  await key("Enter", "Enter", 13);
  await sleep(4);
  const fontSize = await ev("(() => { const s = document.querySelector('.monaco-editor .view-line span'); return s ? getComputedStyle(s).fontSize : 'no editor'; })()");

  // the keybinding: Ctrl+Alt+N toggles the side bar
  const sidebar = () => ev("(() => { const e = document.querySelector('.part.sidebar'); return !!e && e.offsetWidth > 0; })()");
  const before = await sidebar();
  await key("n", "KeyN", 78, CTRL | ALT);
  await sleep(1.5);
  const after = await sidebar();
  if (after === false) await key("n", "KeyN", 78, CTRL | ALT); // search below needs the side bar
  await sleep(1);

  // search
  await key("F", "KeyF", 70, META | SHIFT);
  await sleep(2);
  await send("Input.insertText", { text: "zzmarker" });
  await key("Enter", "Enter", 13);
  await sleep(6);
  const hits = await ev("[...document.querySelectorAll('.search-view .monaco-list-row')].map((e) => e.innerText.replace(/\\n/g, ' '))");
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(outDir, `user-data-${name}.png`), Buffer.from(shot.result.data, "base64"));
  ws.close();
  for (const pid of [...descendants(chrome.pid), chrome.pid]) try { process.kill(pid); } catch { /* gone */ }
  return { fontSize, sidebarToggled: before !== after, hits: hits ?? [] };
}

const copied = await scenario("copied", true);
console.log("copied run:", JSON.stringify(copied));
check(copied.fontSize === `${FONT}px`, "copied editor.fontSize is the font size of an open editor", copied.fontSize);
check(copied.sidebarToggled, "the copied keybinding (ctrl+alt+n) runs its command");
const text = copied.hits.join(" | ");
check(/a\.txt/.test(text), "search finds the visible file", text);
for (const [folder, file] of [[".obsidian", "hit.txt"], ["Attachments", "att.txt"], ["skipme", "mine.txt"]]) {
  check(!text.includes(file), `search skips ${folder} (${folder === "skipme" ? "the instance's own exclude" : "workspace exclude"})`);
}

const control = await scenario("control", false);
console.log("control run:", JSON.stringify(control));
check(control.fontSize !== `${FONT}px`, "control: without the browser seed the font size is not the copied one (the data/User file alone does nothing)", control.fontSize);
check(!control.sidebarToggled, "control: without the browser seed the copied keybinding does nothing");
check(control.hits.join(" | ").includes("mine.txt"), "control: the instance's own exclude (skipme) is not in force without the browser seed");
check(!control.hits.join(" | ").includes("hit.txt") && !control.hits.join(" | ").includes("att.txt"), "control: the workspace excludes still are (they are in the Machine file)");

stopAll();
fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
