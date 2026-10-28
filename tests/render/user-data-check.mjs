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
 * PR-6 (G12, G13, F9, GP7) adds a fixture instance made by tests/fixtures/make-fake-user-data.mjs with a Default and an
 * FDE Practice profile (different editor.fontSize, one keybinding each, trust keys in both settings files), and two more
 * runs against the same server, each in a fresh browser profile with the copy the plugin would make for that profile
 * (the plugin's own findMirroredProfile + profileSeedSource + seedUserData):
 *   4. vault associated with Default: Default's font size and keybinding (ctrl+alt+n toggles the side bar), no trust line;
 *   5. association moved to FDE Practice: its larger font size and its keybinding (ctrl+alt+m toggles the panel), and nothing
 *      of the other profile left in the IndexedDB files; the tab's `Preferences: Open User Settings (JSON)` has no
 *      `security.workspace.trust.` line (screenshot user-data-gp7-*-settings-json.png);
 *   6. the fixture's other-instance folders (Code, VSCodium, a configured folder) and the chosen instance's own folder hash
 *      the same before and after (the output lines are the F9 evidence).
 *
 *   npm run check:user-data [outDir]
 *
 * Env: CODE_CLI (the build's `code` script), CLI_DATA_SRC (a --cli-data-dir that already holds the
 * server for that build; it is cloned into the scratch dir, never written to; nothing is downloaded),
 * CHROME, SERVER_TMPDIR (default /tmp, see the comment at the spawn). Everything it starts runs on scratch ports and is stopped by PID at the end.
 */
import { build } from "esbuild";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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

// --- the PR-6 fixture instance (profiles) -----------------------------------------------------------
await build({
  entryPoints: { profile: path.join(root, "src/profile/mirrored-profile.ts"), fixture: path.join(root, "tests/fixtures/make-fake-user-data.mjs") },
  bundle: true, format: "esm", platform: "node", outdir: path.join(work, "plugin"), outExtension: { ".js": ".mjs" }, logLevel: "error",
});
const profileMod = await import(pathToFileURL(path.join(work, "plugin/profile.mjs")).href);
const fx = await import(pathToFileURL(path.join(work, "plugin/fixture.mjs")).href);

// --- the fixtures ------------------------------------------------------------------------------------
const vault = path.join(work, "vault");
for (const d of [".obsidian", "Attachments", "skipme", "src"]) fs.mkdirSync(path.join(vault, d), { recursive: true });
fs.writeFileSync(path.join(vault, "src/a.txt"), "zzmarker in a visible file\n");
fs.writeFileSync(path.join(vault, ".obsidian/hit.txt"), "zzmarker in obsidian\n");
fs.writeFileSync(path.join(vault, "Attachments/att.txt"), "zzmarker in attachments\n");
fs.writeFileSync(path.join(vault, "skipme/mine.txt"), "zzmarker in the instance's own excluded folder\n");

const appSupport = path.join(work, "app-support");
const vaultUri = fx.vscodeFolderUri(vault);
fx.makeFakeUserData(appSupport, { associations: { [vaultUri]: fx.PROFILES.custom.location }, folders: ["Code", "Code - Insiders", "VSCodium"] });
fx.writeUserData(path.join(appSupport, "Configured"), { associations: { [vaultUri]: fx.PROFILES.custom.location } });
const insidersRoot = path.join(appSupport, "Code - Insiders");
function associate(location) {
  const file = path.join(insidersRoot, "User", "globalStorage", "storage.json");
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  json.profileAssociations.workspaces[vaultUri] = location;
  fs.writeFileSync(file, JSON.stringify(json));
}
/** What a server start does: resolve the mirrored profile, copy its files, and give the tab the copy (a new id per start). */
let startNo = 0;
function copyForMirroredProfile() {
  const profile = profileMod.findMirroredProfile({ userDataRoot: insidersRoot, vaultPath: vault });
  const dirs = seed.profileSeedSource({ status: "resolved", profile }, null);
  const userDataDir = fs.mkdtempSync(path.join(work, "profile-data-"));
  const r = seed.seedUserData({ userDataDir, ...dirs });
  return { name: profile.name, copy: { id: `profile-${++startNo}`, settings: r.merged, keybindingsBase64: r.keybindingsBase64 } };
}
/** Hash of every file under each dir (F9): name, mode and content. */
function hashTree(dir) {
  const h = createHash("sha256");
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      h.update(`${path.relative(dir, p)}|${st.isDirectory() ? "d" : "f"}|${(st.mode & 0o7777).toString(8)}\n`);
      if (st.isDirectory()) walk(p); else h.update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}
const guardedFolders = ["Code", "VSCodium", "Configured", "Code - Insiders"].map((n) => path.join(appSupport, n));
const hashesBefore = guardedFolders.map(hashTree);

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
async function scenario(name, seedBrowser, copyArg = copy, extra = null) {
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
    const outcome = await ev(settings.buildBrowserSeedScript(settings.BROWSER_APP_SETTINGS, copyArg));
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
  const extraResult = extra ? await extra({ ev, key, send, sleep, origin }) : null;
  ws.close();
  for (const pid of [...descendants(chrome.pid), chrome.pid]) try { process.kill(pid); } catch { /* gone */ }
  return { fontSize, sidebarToggled: before !== after, hits: hits ?? [], extra: extraResult };
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

// --- PR-6: the mirrored profile's settings and keybindings reach the tab (G13, GP7), without trust keys (G12) ---
const TRUST = "security.workspace.trust.";
/** After the main run: the IndexedDB files the tab holds, the panel keybinding, and the settings JSON the tab shows. */
function profileExtra(shotName) {
  return async ({ ev, key, send, sleep }) => {
    const idb = await ev(`(async () => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open("vscode-web-db"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const get = (k) => new Promise((res) => { const q = db.transaction("vscode-userdata-store").objectStore("vscode-userdata-store").get(k); q.onsuccess = () => res(q.result ? new TextDecoder().decode(q.result) : null); q.onerror = () => res(null); });
      const out = { settings: await get("/User/settings.json"), keybindings: await get("/User/keybindings.json") };
      db.close();
      return out;
    })()`);
    const panel = () => ev("(() => { const e = document.querySelector('.part.panel'); return !!e && e.offsetWidth > 0 && e.offsetHeight > 0; })()");
    const panelBefore = await panel();
    await key("m", "KeyM", 77, 2 | 1); // ctrl+alt+m (FDE Practice's keybinding)
    await sleep(1.5);
    const panelToggled = (await panel()) !== panelBefore;
    // Preferences: Open User Settings (JSON), as the spec's screenshot 3 shows it
    await key("F1", "F1", 112);
    await sleep(1.5);
    await send("Input.insertText", { text: ">Preferences: Open User Settings (JSON)" });
    await sleep(1.5);
    await key("Enter", "Enter", 13);
    await sleep(4);
    const settingsJsonText = await ev("[...document.querySelectorAll('.monaco-editor .view-lines')].map((e) => e.innerText).join('\\n')");
    const shot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(outDir, `user-data-${shotName}-settings-json.png`), Buffer.from(shot.result.data, "base64"));
    return { idb, panelToggled, settingsJsonText: settingsJsonText ?? "" };
  };
}

associate("__default__profile__");
const dflt = copyForMirroredProfile();
const gp7Default = await scenario("gp7-default", true, dflt.copy, profileExtra("gp7-default"));
console.log("gp7 default run:", JSON.stringify({ ...gp7Default, extra: undefined }));
check(dflt.name === "Default", "GP7: the mirrored profile is Default", dflt.name);
check(gp7Default.fontSize === "14px", "GP7 Default: the tab uses Default's editor.fontSize", gp7Default.fontSize);
check(gp7Default.sidebarToggled, "GP7 Default: Default's keybinding (ctrl+alt+n) runs its command");
check(!gp7Default.extra.panelToggled, "GP7 Default: FDE Practice's keybinding (ctrl+alt+m) does nothing");
check(!(gp7Default.extra.idb.settings ?? "").includes(TRUST), "G12: no security.workspace.trust. key in the IndexedDB /User/settings.json (Default)");
check(!gp7Default.extra.settingsJsonText.includes(TRUST), "G12: the tab's settings JSON has no security.workspace.trust. line (Default)");

associate(fx.PROFILES.custom.location);
const fde = copyForMirroredProfile();
const gp7Fde = await scenario("gp7-fde", true, fde.copy, profileExtra("gp7-fde"));
console.log("gp7 FDE Practice run:", JSON.stringify({ ...gp7Fde, extra: undefined }));
check(fde.name === "FDE Practice", "GP7: the mirrored profile is FDE Practice", fde.name);
check(gp7Fde.fontSize === "22px", "GP7 FDE Practice: the tab uses the profile's larger editor.fontSize, not Default's", gp7Fde.fontSize);
check(gp7Fde.extra.panelToggled, "GP7 FDE Practice: the profile's keybinding (ctrl+alt+m) runs its command");
check(!gp7Fde.sidebarToggled, "GP7 FDE Practice: Default's keybinding (ctrl+alt+n) is not there");
check(!(gp7Fde.extra.idb.settings ?? "").includes(TRUST), "G12: no security.workspace.trust. key in the IndexedDB /User/settings.json (FDE Practice)");
check(!gp7Fde.extra.settingsJsonText.includes(TRUST), "G12: the tab's settings JSON has no security.workspace.trust. line (FDE Practice)");
check(!(gp7Fde.extra.idb.keybindings ?? "").includes("toggleSidebarVisibility"), "GP7: nothing of Default's keybinding is in the IndexedDB keybindings.json");

// Moving the association back: the next start's copy replaces the whole IndexedDB file (same browser profile is not reused here;
// the seed script's replace-whole rule is covered by tests/unit/settings.test.ts).
associate("__default__profile__");
const back = copyForMirroredProfile();
check(back.name === "Default" && back.copy.settings["editor.fontSize"] === 14 && !JSON.stringify(back.copy.settings).includes("FDE Practice"), "GP7: association back on Default: the copy holds Default's values and nothing of FDE Practice");

// F9: the fixture's other instances, and the chosen instance's own folder, are byte-identical. The association edits above
// changed only storage.json in the chosen instance's folder, so that one is compared with its post-edit state.
const hashesAfter = guardedFolders.map(hashTree);
guardedFolders.forEach((d, i) => {
  const name = path.basename(d);
  if (name === "Code - Insiders") {
    const after = fs.readdirSync(path.join(d, "User", "profiles")).sort().join(",");
    console.log(`F9 ${name}: hash before ${hashesBefore[i].slice(0, 16)} after ${hashesAfter[i].slice(0, 16)} (only storage.json was edited by this script)`);
    check(after === `${fx.PROFILES.agents.location},${fx.PROFILES.custom.location}`, "F9: the chosen instance's profile folders are unchanged by the seed runs", after);
  } else {
    console.log(`F9 ${name}: hash before ${hashesBefore[i].slice(0, 16)} after ${hashesAfter[i].slice(0, 16)}`);
    check(hashesBefore[i] === hashesAfter[i], `F9: ${name} hashes the same before and after`);
  }
});

stopAll();
fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
