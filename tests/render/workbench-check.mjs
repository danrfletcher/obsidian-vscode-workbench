/**
 * Real-server check for two things the Code tab leaves to VS Code itself, run in a real workbench:
 *
 *   G4 (checklist C5, C35): a file that changes on disk behind an open editor. What VS Code does is
 *      recorded and asserted so the README's statement ("VS Code decides; the plugin adds no prompt and never
 *      overwrites the buffer") stays true: a clean buffer reloads with no prompt of any kind; a buffer with
 *      unsaved edits keeps them and the disk keeps the outside change; saving that buffer is refused with
 *      VS Code's own "newer" message and a Compare / Overwrite choice, and nothing is written.
 *   G5, G6 (checklist C36): with the plugin's own workbench settings (writeMachineSettings) for light and for
 *      dark, the chrome is hidden (the settings hide the activity bar, status bar, title bar, tab strip and breadcrumbs;
 *      the seeded chords and the page script close the side bar, secondary side bar and panel: src/chrome-settings.ts,
 *      src/chrome-script.ts, the same code the Code tab runs) and the text in the editor is legible: the contrast ratio of every syntax
 *      colour on the editor's own background, measured from the page's computed styles (WCAG 2.x), has to be
 *      at least MIN_CONTRAST. The same block measures GP6 (line numbers in the gutter; at the four window sizes of
 *      tests/render/run.mjs the editor is as wide and tall as the window, no frame, margin or centring gutter) and takes the
 *      E6 flash frames (16 over the first seconds after navigation, saved with a frames.json; whether the full workbench is ever
 *      painted is printed, not failed on, because PR-1 saw no flash).
 *
 *   GP4, E8, E9 (checklist C37 on): the keybinding overlay and the revealing commands, in a real workbench. Cmd+B, Cmd+J, Cmd+K Z and
 *      Cmd+W change nothing (a recorder in the page notes any bar that is ever laid out, so the page script's undo cannot hide
 *      a chord that did work; a control browser with only the close chords proves the recorder sees them); Cmd+F, Cmd+Shift+P and Cmd+P
 *      open as overlays; a copied keybindings.json that binds a layout command to ctrl+alt+n, or re-binds cmd+b / cmd+j / cmd+k z / cmd+w to
 *      their commands, is unbound, also after a reload with the same copy id; each command of REVEALING_COMMANDS is run, and the eight
 *      the spec names are run from the palette, and every bar is hidden afterwards; so is the panel that "Terminal: Create New Terminal" opens
 *      behind VS Code's Workspace Trust dialog (the dialog stops every key, so the page script clicks the panel's hide button) and the one a
 *      running terminal reopens in a trusted folder.
 *
 * Not part of `npm test`: it needs a VS Code build with `serve-web`, a cached VS Code server for that build,
 * and Google Chrome. It starts `serve-web` on a free loopback port and headless Chrome on a free debugging
 * port, and stops what it started, by PID, at the end.
 *
 *   npm run check:workbench [outDir]
 *
 * Env: CODE_CLI (the build's `code` script), CLI_DATA_SRC (a --cli-data-dir that already holds the server for
 * that build; it is cloned into the scratch dir, never written to), ALLOW_DOWNLOAD=1 (let `serve-web` download
 * the server for the installed build from Microsoft into the scratch dir when CLI_DATA_SRC is not set or does
 * not hold it; without it nothing is ever downloaded), CHROME, SERVER_TMPDIR (default /tmp, see the comment at
 * the spawn), SKIP_G4=1 (skip the G4 block), ONLY_GP4=1 (run only the GP4/E8/E9 block).
 *
 * Exit codes: 0 all checks passed, 1 a check failed, 2 the check could not run (a missing tool, no server for
 * the installed build, a server that answers with an error, or a page that never painted).
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
    console.error(`workbench check needs ${name}${f ? ` (${f} does not exist)` : " (not set)"}`);
    process.exit(2);
  }
}
// The server must be the one for the installed build: a server for another build can answer HTTP 500 or serve a
// page that never paints. Say so before starting anything, rather than printing a screenful of FAIL lines.
const [version, commit] = execFileSync(CODE, ["--version"], { encoding: "utf8" }).trim().split("\n");
const held = CLI_DATA_SRC && fs.existsSync(path.join(CLI_DATA_SRC, "serve-web"))
  ? fs.readdirSync(path.join(CLI_DATA_SRC, "serve-web")).filter((n) => /^[0-9a-f]{40}$/.test(n))
  : [];
const haveServer = held.includes(commit);
if (!haveServer && !ALLOW_DOWNLOAD) {
  console.error(
    `workbench check cannot run: the installed VS Code (${CODE}) is ${version} (server commit ${commit}), and ` +
      (CLI_DATA_SRC
        ? `CLI_DATA_SRC (${CLI_DATA_SRC}) ${held.length ? `holds a server only for ${held.join(", ")}` : "holds no cached server"}.`
        : "CLI_DATA_SRC is not set.") +
      `\nSet CLI_DATA_SRC to a --cli-data-dir whose serve-web/ folder holds ${commit}, or set ALLOW_DOWNLOAD=1 to let ` +
      "serve-web download that server from Microsoft into the scratch directory.",
  );
  process.exit(2);
}
const MIN_CONTRAST = 4.5;
const work = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "workbench-check-"));
const outDir = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "workbench-shots-")));
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
  entryPoints: { paths: path.join(root, "src/paths.ts"), "trust-seed": path.join(root, "src/trust/trust-seed.ts"), settings: path.join(root, "src/settings.ts"), "dirty-script": path.join(root, "src/dirty-script.ts"), "chrome-settings": path.join(root, "src/chrome-settings.ts"), "chrome-script": path.join(root, "src/chrome-script.ts") },
  bundle: true, format: "esm", platform: "node", outdir: path.join(work, "plugin"), outExtension: { ".js": ".mjs" }, logLevel: "error",
});
const settings = await import(pathToFileURL(path.join(work, "plugin/settings.mjs")).href);
const pluginPaths = await import(pathToFileURL(path.join(work, "plugin/paths.mjs")).href);
const trustSeed = await import(pathToFileURL(path.join(work, "plugin/trust-seed.mjs")).href);
// The plugin's own unsaved-buffer probe (what delete, rename, idle stop and quit ask), run against the real workbench below.
const { DIRTY_SCRIPT, fileDirtyScript } = await import(pathToFileURL(path.join(work, "plugin/dirty-script.mjs")).href);

// What the Code tab seeds and runs to hide the chrome (src/main.ts chromeHiding(), src/code-view.ts loadWorkbench), from the same code.
const { chromeKeybindings, overlayKeybindings, unbindCommands, REVEALING_COMMANDS } = await import(pathToFileURL(path.join(work, "plugin/chrome-settings.mjs")).href);
const { buildChromeHideScript } = await import(pathToFileURL(path.join(work, "plugin/chrome-script.mjs")).href);

// --- the fixtures ------------------------------------------------------------------------------------
const vault = path.join(work, "vault");
fs.mkdirSync(vault, { recursive: true });
const PY = `# a comment
import os
def estimate(hours: int, rate: float = 1.5) -> str:
    """doc string"""
    total = hours * rate  # 42
    return f"total {total} for {os.name}"

class Thing:
    kind = 'thing'
    def run(self):
        return [1, 2, 3, None, True]
`;
fs.writeFileSync(path.join(vault, "clean.txt"), "clean line one\nclean line two\n");
fs.writeFileSync(path.join(vault, "dirty.txt"), "dirty line one\ndirty line two\n");
fs.writeFileSync(path.join(vault, "saved.txt"), "saved line one\nsaved line two\n");
fs.writeFileSync(path.join(vault, "other.txt"), "other line one\n");
fs.writeFileSync(path.join(vault, "mine.txt"), "mine line one\n");
fs.writeFileSync(path.join(vault, "sample.py"), PY);

// --- the server --------------------------------------------------------------------------------------
async function startServer(name, dark, extraSettings = {}) {
  const runtime = path.join(work, `runtime-${name}`);
  const serverData = path.join(runtime, "server-data");
  fs.mkdirSync(serverData, { recursive: true });
  const machineFile = settings.writeMachineSettings(serverData, { dark });
  if (Object.keys(extraSettings).length) fs.writeFileSync(machineFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(machineFile, "utf8")), ...extraSettings }, null, 2));
  const cliData = path.join(runtime, "cli-data");
  if (haveServer) fs.cpSync(CLI_DATA_SRC, cliData, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
  else fs.mkdirSync(cliData, { recursive: true }); // ALLOW_DOWNLOAD: serve-web fetches the server into here
  const token = "tok" + "x".repeat(24);
  const tokenFile = path.join(runtime, "token");
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const port = await freePort();
  const server = spawn(
    CODE,
    ["serve-web", "--host", "127.0.0.1", "--port", String(port), "--connection-token-file", tokenFile, "--server-data-dir", serverData, "--cli-data-dir", cliData, "--disable-telemetry", "--commit-id", commit, "--accept-server-license-terms"],
    {
      stdio: ["ignore", fs.openSync(path.join(work, `server-${name}.log`), "w"), "ignore"],
      // The server listens on a unix socket `<TMPDIR>/code-insiders-<uuid>`; macOS caps socket paths at 104
      // characters and a scratch dir is longer than that, so the server (and only the server) gets a short TMPDIR.
      env: { ...process.env, TMPDIR: process.env.SERVER_TMPDIR ?? "/tmp" },
    },
  );
  started.push(server.pid);
  console.log(`[${name}] server pid ${server.pid} on 127.0.0.1:${port}`);
  let answered;
  for (let i = 0; ; i++) {
    answered = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.status, () => 0);
    if (answered) break;
    if (i === (haveServer ? 40 : 300)) { console.error(`server did not come up (see ${path.join(work, `server-${name}.log`)})`); process.exit(2); }
    await sleep(1);
  }
  if (answered >= 500) {
    console.error(`the server answered HTTP ${answered}: the server for commit ${commit} is probably damaged or does not match the installed VS Code (${version}) (see ${path.join(work, `server-${name}.log`)})`);
    process.exit(2);
  }
  await sleep(3);
  return { port, token, pid: server.pid };
}

// Rules written into the browser profile's keybindings.json AFTER the overlay (so the overlay has not unbound them): how this check runs
// a command that has no palette entry of its own. Inserted before the closing bracket of the overlay's array.
const appendRulesScript = (rules) => `(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open(${JSON.stringify(settings.WORKBENCH_DB.name)}, ${settings.WORKBENCH_DB.version}); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const store = ${JSON.stringify(settings.WORKBENCH_DB.store)};
  const key = "/User/keybindings.json";
  const raw = await new Promise((res, rej) => { const q = db.transaction(store).objectStore(store).get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  let text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  const at = text.lastIndexOf("\\n]");
  text = text.slice(0, at) + ",\\n" + ${JSON.stringify(rules)}.map((r) => "  " + JSON.stringify(r)).join(",\\n") + text.slice(at);
  await new Promise((res, rej) => { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).put(new TextEncoder().encode(text), key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  db.close();
  return "appended " + ${JSON.stringify(rules)}.length;
})()`;

// Which parts are painted right now, for the flash frames (the same selectors as CONTRAST below).
const FLASH_PARTS = `(() => {
  const shown = (sel) => { const e = document.querySelector(sel); return !!e && e.offsetWidth > 0 && e.offsetHeight > 0; };
  return { titlebar: shown('.part.titlebar'), activitybar: shown('.part.activitybar'), statusbar: shown('.part.statusbar'), sidebar: shown('.part.sidebar'), secondarysidebar: shown('.part.auxiliarybar'), panel: shown('.part.panel'), tabstrip: shown('.tabs-and-actions-container'), breadcrumbs: shown('.breadcrumbs-control'), editor: shown('.part.editor') };
})()`;

// --- one browser -------------------------------------------------------------------------------------
async function browser(name, srv, { hide = false, dark = false, copy = null, overlay = true, extraRules = null, script = true, flash: wantFlash = true, trust = false } = {}) {
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
    // A "leave this page?" prompt (VS Code asks when an editor has unsaved changes) would block the next navigation: leave.
    if (d.method === "Page.javascriptDialogOpening") ws.send(JSON.stringify({ id: ++id, method: "Page.handleJavaScriptDialog", params: { accept: true } }));
  };
  // A CDP call that never answers (a page that navigated away while a script was running) must not hang the whole run.
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id;
    const timer = setTimeout(() => { pend.delete(i); console.log(`[${name}] CDP ${method} gave no answer in 60 s`); res({ error: "timeout" }); }, 60_000);
    pend.set(i, (d) => { clearTimeout(timer); res(d); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async (e) => {
    const r = (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result;
    if (r?.exceptionDetails) console.log(`[${name}] page script threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`.slice(0, 400));
    return r?.result?.value;
  };
  const key = async (k, code, vk, modifiers = 0) => {
    for (const type of ["rawKeyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, modifiers });
  };
  const shot = async (file) => {
    const s = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(outDir, file), Buffer.from(s.result.data, "base64"));
  };
  await send("Page.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  const seedProfile = async () => {
    // As the Code tab does: the seed runs on the server's own origin page (the browser profile's IndexedDB), then the workbench page loads.
    await send("Page.navigate", { url: `http://127.0.0.1:${srv.port}/version` });
    await sleep(2);
    const seeded = await ev(settings.buildBrowserSeedScript({ ...settings.BROWSER_APP_SETTINGS, ...settings.workbenchOverlay({ dark }) }, copy, overlay ? overlayKeybindings() : chromeKeybindings(), overlay ? unbindCommands() : []));
    console.log(`[${name}] browser profile seed: ${seeded}`);
    // The trust seed the Code tab runs by default (trustVaultFolder): the vault folder opens trusted, so a terminal starts with no prompt.
    if (trust) console.log(`[${name}] trust seed: ${await ev(trustSeed.buildTrustSeedScript({ origin: `http://127.0.0.1:${srv.port}`, folderUri: pluginPaths.buildFileUri(`http://127.0.0.1:${srv.port}`, vault), heldPorts: [srv.port] }))}`);
    if (extraRules) console.log(`[${name}] extra rules after the overlay: ${await ev(appendRulesScript(extraRules))}`);
  };
  const waitWorkbench = async () => {
    // The Code tab runs the script at the workbench page's own dom-ready: wait for that page's document (not the /version one) to be past loading.
    for (let i = 0; i < 200; i++) {
      if ((await ev("location.search.includes('tkn=') && document.readyState !== 'loading'")) === true) break;
      await sleep(0.05);
    }
  };
  const workbenchUrl = `http://127.0.0.1:${srv.port}/?tkn=${srv.token}&folder=${encodeURIComponent(vault)}`;
  if (hide) await seedProfile();
  const navigatedAt = Date.now();
  await send("Page.navigate", { url: workbenchUrl });
  const flash = [];
  if (hide) {
    await waitWorkbench();
    if (script) console.log(`[${name}] chrome script: ${await ev(buildChromeHideScript())}`);
    // E6 flash check (best effort): frames over the first seconds after navigation, and whether the full workbench is ever painted.
    // PR-1 saw no flash (docs/spike-chrome.md S4), so the frames are kept as evidence and nothing here fails the run.
    if (wantFlash) {
      fs.mkdirSync(path.join(outDir, `flash-${name}`), { recursive: true });
      for (let i = 0; i < 16; i++) {
        const parts = await ev(FLASH_PARTS);
        const t = Date.now() - navigatedAt;
        flash.push({ ms: t, parts });
        await shot(`flash-${name}/frame-${String(i).padStart(2, "0")}-${t}ms.png`);
        await sleep(0.3);
      }
      const painted = flash.filter((f) => f.parts && Object.entries(f.parts).some(([k, v]) => k !== "editor" && v));
      fs.writeFileSync(path.join(outDir, `flash-${name}`, "frames.json"), JSON.stringify(flash, null, 2));
      console.log(`[${name}] E6 flash frames: ${flash.length} captured, the full workbench (a part besides the editor) painted in ${painted.length}${painted.length ? `, first at ${painted[0].ms} ms: ${JSON.stringify(painted[0].parts)}` : ""}; frames in ${path.join(outDir, `flash-${name}`)}`);
    }
  }
  // A reload of the tab within one server start: the same seed (same copy id) and the same script, as CodeView.loadWorkbench runs them.
  const reload = async () => {
    console.log(`[${name}] reload: seeding the profile again`);
    await seedProfile();
    await send("Page.navigate", { url: workbenchUrl });
    await waitWorkbench();
    if (script) await ev(buildChromeHideScript());
    await sleep(6);
    console.log(`[${name}] reload: done`);
  };
  await sleep(20);
  const META = 4;
  const openFile = async (file) => {
    // The first Cmd+P after a start can reach the page before the workbench has bound its keys (the tab then stays on the Welcome page):
    // ask again, up to three times, until a file editor shows.
    for (let attempt = 0; attempt < 3; attempt++) {
      await key("p", "KeyP", 80, META);
      await sleep(1.5);
      await send("Input.insertText", { text: file });
      await sleep(1.5);
      await key("Enter", "Enter", 13);
      await sleep(4);
      for (let i = 0; i < 20; i++) {
        if ((await ev("document.querySelectorAll('.part.editor .monaco-editor[data-uri]').length")) >= 1) { await sleep(1); return; }
        await sleep(0.5);
      }
      await key("Escape", "Escape", 27);
      await sleep(1);
    }
  };
  const close = () => {
    ws.close();
    stopPid(chrome.pid);
  };
  return { send, ev, key, shot, openFile, close, META, reload };
}

// What VS Code is showing besides the editor: toasts, dialogs, and the editor's text.
const PAGE_STATE = `(() => {
  const txt = (sel) => [...document.querySelectorAll(sel)].map((e) => e.innerText.replace(/\\s+/g, ' ').trim()).filter(Boolean);
  const visible = (e) => !!e && e.offsetWidth > 0 && e.offsetHeight > 0;
  return {
    text: [...document.querySelectorAll('.monaco-editor .view-line')].map((e) => e.innerText.replace(/\\u00a0/g, ' ')).join('\\n'),
    toasts: txt('.notifications-toasts .notification-toast'),
    dialogs: txt('.monaco-dialog-box'),
    // The tab strip is hidden by the plugin's settings, so the unsaved marker is read from the window title.
    title: document.title,
    anyDialogVisible: [...document.querySelectorAll('.monaco-dialog-box')].some(visible),
  };
})()`;

// A page that never paints gives no state; it is reported, not thrown on.
const EMPTY_STATE = { text: "", toasts: [], dialogs: [], title: "", anyDialogVisible: false };
const pageState = async (b) => (await b.ev(PAGE_STATE)) ?? EMPTY_STATE;
let neverPainted = false;
const notRendered = (what) => (neverPainted = true, check(false, `${what}: the page did not render (check that the server matches the installed VS Code build, ${commit})`));

// =====================================================================================================
// G4: a file changes on disk behind an open editor
// =====================================================================================================
g4: {
  if (process.env.SKIP_G4 === "1" || process.env.ONLY_GP4 === "1") break g4; // SKIP_G4=1: only the G5/G6 block (a faster rerun while working on the hiding)
  // The web workbench saves by itself after a second unless auto-save is off; the checklist runs with it off (GP7).
  // The plugin's Machine file now hides the tab strip (GP1), and the unsaved-buffer probes below read `.tab.dirty` and
  // `data-resource-name` from it, so this block puts the tab strip back for its own server only. The Code tab itself has no
  // tab strip until PR-5 replaces that signal (docs/spike-chrome.md S5); with it hidden the page-wide probe sees only the active
  // editor's title dot and the per-file probe answers "none". The G5/G6 block below runs with the hiding on.
  const srv = await startServer("g4", true, { "files.autoSave": "off", "workbench.editor.showTabs": "multiple" });
  const b = await browser("g4", srv);

  // 1. clean buffer
  await b.openFile("clean.txt");
  const opened = (await pageState(b)).text.includes("clean line one");
  check(opened, "G4: the clean file is open in the editor");
  if (!opened) {
    notRendered("G4");
    b.close();
    stopPid(srv.pid);
    break g4;
  }
  fs.appendFileSync(path.join(vault, "clean.txt"), "added from outside\n");
  await sleep(6);
  check((await b.ev(DIRTY_SCRIPT)) === false, "G3: the plugin's unsaved-buffer probe (DIRTY_SCRIPT) reads a clean buffer as clean");
  const clean = await pageState(b);
  await b.shot("G4-clean-external.png");
  console.log("clean buffer after outside change:", JSON.stringify({ toasts: clean.toasts, dialogs: clean.dialogs }));
  check(clean.text.includes("added from outside"), "G4: a clean buffer reloads the outside change");
  check(clean.toasts.length === 0 && !clean.anyDialogVisible, "G4: a clean buffer reloads with no prompt, toast or dialog (VS Code shows none)", JSON.stringify([...clean.toasts, ...clean.dialogs]));

  // 1b. type into a file and save it: the probe sees the buffer go from dirty to clean (what the rename watch relies on).
  // Done before the next step on purpose: the probe is true while ANY editor in the page is unsaved, so the refused save below would keep it true.
  await b.openFile("saved.txt");
  await b.send("Input.insertText", { text: "SAVED " });
  await sleep(1.5);
  check((await b.ev(DIRTY_SCRIPT)) === true, "G3: ...a second typed buffer reads dirty");
  await b.key("s", "KeyS", 83, b.META);
  await sleep(3);
  check((await b.ev(DIRTY_SCRIPT)) === false, "G3: ...and reads clean once it is saved (Cmd+S in the tab)");
  check(fs.readFileSync(path.join(vault, "saved.txt"), "utf8").startsWith("SAVED saved line one"), "G3: ...with the typed text on disk");

  // 1b2. the page-wide probe cannot see a save while ANOTHER editor is unsaved, so the rename watch asks the tab of
  // the one file (PR-5 R4, T40, T41): with other.txt unsaved, saving mine.txt leaves DIRTY_SCRIPT true, but the tab
  // script reads mine.txt clean, other.txt dirty, and a file with no tab as "none" (the caller then keeps the page-wide answer).
  await b.openFile("other.txt");
  await b.send("Input.insertText", { text: "OTHER " });
  await sleep(1.5);
  await b.openFile("mine.txt");
  await b.send("Input.insertText", { text: "MINE " });
  await sleep(1.5);
  check((await b.ev(fileDirtyScript("mine.txt"))) === "dirty", "G3: the tab script reads a typed file's own tab as dirty");
  await b.key("s", "KeyS", 83, b.META);
  await sleep(3);
  check((await b.ev(DIRTY_SCRIPT)) === true, "G3: ...after saving mine.txt the page-wide probe still reads dirty (other.txt is unsaved)");
  check((await b.ev(fileDirtyScript("mine.txt"))) === "clean", "G3: ...while the tab script reads the saved file's own tab as clean");
  check((await b.ev(fileDirtyScript("other.txt"))) === "dirty", "G3: ...and the other file's tab as dirty");
  check((await b.ev(fileDirtyScript("nothing-open.txt"))) === "none", "G3: ...and a file with no tab as none");
  await b.openFile("other.txt");
  await b.key("s", "KeyS", 83, b.META);
  await sleep(3);
  check((await b.ev(DIRTY_SCRIPT)) === false, "G3: ...and saving the other file leaves the page clean for the steps below");

  // 1c. rename a file on disk under a typed buffer, then save in the workbench (PR-5 R4, T33). The held-back
  // repoint in src/code-view.ts relies on exactly this: the buffer stays bound to the OLD path, the probe still
  // reads it as dirty, and Cmd+S writes the text at the old path (re-creating it) and turns the probe clean. Only
  // then does the plugin carry the text into the renamed file and re-point the embed. If VS Code behaved otherwise
  // (refused the save, or followed the rename), the watch would never fire or would carry nothing.
  fs.writeFileSync(path.join(vault, "ren-a.txt"), "rename line one\nrename line two\n");
  await b.openFile("ren-a.txt");
  await b.send("Input.insertText", { text: "RENAMED " });
  await sleep(1.5);
  check((await b.ev(DIRTY_SCRIPT)) === true, "G3: a typed buffer reads dirty before its file is renamed on disk");
  fs.renameSync(path.join(vault, "ren-a.txt"), path.join(vault, "ren-b.txt"));
  await sleep(5);
  check((await b.ev(DIRTY_SCRIPT)) === true, "G3: ...and still reads dirty after the rename (the typed text is not dropped or moved by VS Code)");
  check(!fs.existsSync(path.join(vault, "ren-a.txt")), "G3: ...nothing re-created the old path before a save");
  await b.key("s", "KeyS", 83, b.META);
  await sleep(4);
  const afterRenameSave = await pageState(b);
  await b.shot("G3-rename-save.png");
  console.log("after saving under a renamed file:", JSON.stringify({ toasts: afterRenameSave.toasts, dialogs: afterRenameSave.dialogs }));
  check((await b.ev(DIRTY_SCRIPT)) === false, "G3: ...the save in the workbench turns the probe clean (this is what makes the plugin's rename watch re-point the tab)");
  check(
    fs.existsSync(path.join(vault, "ren-a.txt")) && fs.readFileSync(path.join(vault, "ren-a.txt"), "utf8").startsWith("RENAMED rename line one"),
    "G3: ...and the typed text is written at the OLD path, which is where the plugin picks it up to carry into the renamed file",
  );
  check(fs.readFileSync(path.join(vault, "ren-b.txt"), "utf8") === "rename line one\nrename line two\n", "G3: ...while the renamed file still holds its old content until the plugin carries the edit");

  // 1d. delete a file on disk under a typed buffer (PR-5 R3, T32). A delete that is not Obsidian's own leaves a tab
  // with unsaved edits open (src/vault-sync.ts); that is only safe if the probe the plugin asks still reads the
  // buffer as dirty once its file is gone. Saved afterwards so the probe is clean for the steps below.
  fs.writeFileSync(path.join(vault, "gone.txt"), "gone line one\ngone line two\n");
  await b.openFile("gone.txt");
  await b.send("Input.insertText", { text: "KEEP " });
  await sleep(1.5);
  fs.unlinkSync(path.join(vault, "gone.txt"));
  await sleep(5);
  check((await b.ev(DIRTY_SCRIPT)) === true, "G3: a typed buffer still reads dirty after its file is deleted on disk (so the tab is kept open)");
  check((await pageState(b)).text.includes("KEEP gone line one"), "G3: ...and its typed text is still in the editor");
  await b.key("s", "KeyS", 83, b.META);
  await sleep(4);
  check((await b.ev(DIRTY_SCRIPT)) === false, "G3: ...saving it turns the probe clean again");

  // 2. buffer with unsaved edits
  await b.openFile("dirty.txt");
  await b.send("Input.insertText", { text: "TYPED " });
  await sleep(1.5);
  check((await pageState(b)).title.includes("\u25cf"), "G4: typing makes the buffer unsaved (the window title shows the unsaved dot)");
  check((await b.ev(DIRTY_SCRIPT)) === true, "G3: the plugin's unsaved-buffer probe (DIRTY_SCRIPT) reads the typed buffer as dirty");
  fs.appendFileSync(path.join(vault, "dirty.txt"), "outside change to a dirty file\n");
  await sleep(6);
  const dirty = await pageState(b);
  await b.shot("G4-dirty-external.png");
  console.log("dirty buffer after outside change:", JSON.stringify({ toasts: dirty.toasts, dialogs: dirty.dialogs }));
  const onDisk = () => fs.readFileSync(path.join(vault, "dirty.txt"), "utf8");
  check(dirty.text.includes("TYPED dirty line one"), "G4: a buffer with unsaved edits keeps its text");
  check(!dirty.text.includes("outside change to a dirty file"), "G4: ...and the outside change is not loaded over it");
  check(onDisk().endsWith("outside change to a dirty file\n") && !onDisk().includes("TYPED"), "G4: the file on disk still holds the outside change (nothing overwrote it)");

  // 3. save that buffer
  await b.key("s", "KeyS", 83, b.META);
  await sleep(4);
  const saved = await pageState(b);
  await b.shot("G4-dirty-save-conflict.png");
  console.log("after saving the dirty buffer:", JSON.stringify({ toasts: saved.toasts, dialogs: saved.dialogs }));
  const prompts = [...saved.toasts, ...saved.dialogs].join(" | ");
  check(/newer|changed|conflict/i.test(prompts) && /Overwrite/i.test(prompts) && /Compare/i.test(prompts), "G4: saving it is refused with VS Code's own message and a Compare / Overwrite choice", prompts.slice(0, 300));
  check(!onDisk().includes("TYPED"), "G4: the refused save wrote nothing: the file on disk still lacks the typed text");

  b.close();
  stopPid(srv.pid);
}

// =====================================================================================================
// G5, G6: chrome hidden and legible text in light and in dark
// =====================================================================================================
const CONTRAST = `(() => {
  const parse = (s) => { const m = /rgba?\\(([^)]+)\\)/.exec(s); if (!m) return null; const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const ed = document.querySelector('.monaco-editor .monaco-editor-background') || document.querySelector('.monaco-editor');
  const bg = parse(getComputedStyle(ed).backgroundColor);
  const seen = new Map();
  for (const s of document.querySelectorAll('.monaco-editor .view-line span span')) {
    if (!s.textContent.trim()) continue;
    const c = getComputedStyle(s).color;
    if (!seen.has(c)) seen.set(c, s.textContent.trim().slice(0, 20));
  }
  const colours = [...seen].map(([c, sample]) => ({ colour: c, sample, ratio: Math.round(ratio(parse(c), bg) * 100) / 100 }));
  const shown = (sel) => { const e = document.querySelector(sel); return !!e && e.offsetWidth > 0 && e.offsetHeight > 0; };
  return {
    bg: getComputedStyle(ed).backgroundColor,
    bgLuminance: lum(bg),
    colours,
    chrome: { titlebar: shown('.part.titlebar'), activitybar: shown('.part.activitybar'), statusbar: shown('.part.statusbar'), sidebar: shown('.part.sidebar'), secondarysidebar: shown('.part.auxiliarybar'), panel: shown('.part.panel'), menubar: shown('.menubar'), tabstrip: shown('.tabs-and-actions-container'), breadcrumbs: shown('.breadcrumbs-control'), explorer: shown('.explorer-viewlet'), openeditors: shown('.open-editors'), editor: shown('.part.editor') },
    editors: document.querySelectorAll('.monaco-editor[data-uri]').length,
  };
})()`;

for (const dark of process.env.ONLY_GP4 === "1" ? [] : [false, true]) {
  const name = dark ? "dark" : "light";
  const srv = await startServer(name, dark);
  const b = await browser(name, srv, { hide: true, dark });
  await b.openFile("sample.py");
  await sleep(3);
  const r = await b.ev(CONTRAST);
  await b.shot(`G5-G6-${name}.png`);
  if (!r?.bg) {
    notRendered(`G5/G6 ${name}`);
    b.close();
    stopPid(srv.pid);
    continue;
  }
  console.log(`[${name}] editor background ${r.bg}; text colours:`, JSON.stringify(r.colours));
  check(dark ? r.bgLuminance < 0.05 : r.bgLuminance > 0.85, `${name}: the editor background is ${dark ? "dark" : "light"}`, r.bg);
  check(r.colours.length >= 4, `${name}: the sample shows several syntax colours (the grammar is loaded)`, `${r.colours.length} colours`);
  const worst = r.colours.reduce((a, c) => (c.ratio < a.ratio ? c : a), { ratio: 99 });
  check(worst.ratio >= MIN_CONTRAST, `${name}: every text colour has contrast ${MIN_CONTRAST} or more on the editor background (lowest ${worst.ratio} for "${worst.sample}")`);
  // GP1: nothing but the editor shows (docs/spike-decision.md); the side bar goes with the Explorer and Open Editors views inside it.
  const expected = Object.fromEntries(Object.keys(r.chrome).map((k) => [k, k === "editor"]));
  check(JSON.stringify(r.chrome) === JSON.stringify(expected), `${name}: every part is hidden (title, activity, status, tab strip, breadcrumbs, side bar with Explorer and Open Editors, secondary side bar, panel) and only the editor is shown`, JSON.stringify(r.chrome));
  check(r.editors === 1, `${name}: the editor holds exactly the one file that was opened (E6)`, String(r.editors));
  // GP6: the editor fills the pane at the window sizes tests/render/run.mjs uses (no frame, margin or centring gutter), and the gutter has line numbers.
  check((await b.ev("document.querySelectorAll('.line-numbers').length")) > 0, `${name}: line numbers are in the gutter`);
  for (const [w, h] of [[1280, 800], [900, 600], [600, 700], [500, 700]]) {
    await b.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(1.5);
    // A Workspace Trust banner (an untrusted folder, as this check's vault is) is a 26 px row above the editor and is not a frame; it is subtracted, and the Code tab's trusted vault has none.
    const m = await b.ev("(() => { const q = (s) => { const e = document.querySelector(s); return e && e.offsetHeight > 0 ? e.getBoundingClientRect() : null; }; const banner = q('.part.banner'); const bh = banner ? Math.round(banner.height) : 0; const r = document.querySelector('.part.editor').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top) - bh, w: Math.round(r.width), h: Math.round(r.height), banner: bh, innerW: window.innerWidth, innerH: window.innerHeight - bh, centered: !!document.querySelector('.centered-layout, .monaco-workbench.centered') }; })()");
    check(!!m && m.w === m.innerW && m.x === 0 && m.y === 0 && m.h === m.innerH && !m.centered, `${name}: at ${w}x${h} the editor is the whole window, with no frame, margin or centring gutter`, JSON.stringify(m));
    if (w === 1280 || w === 500) await b.shot(`G6-${name}-${w === 1280 ? "wide" : "narrow"}-${w}x${h}.png`);
  }
  b.close();
  stopPid(srv.pid);
}


// =====================================================================================================
// GP4, E8, E9: the keybinding overlay and the revealing commands
// =====================================================================================================
// The bars, as the layout has them right now: any width and height above zero.
const BARS_NOW = `(() => {
  const shown = (sel) => { const e = document.querySelector(sel); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return { sidebar: shown('.part.sidebar'), panel: shown('.part.panel'), secondarysidebar: shown('.part.auxiliarybar'), activitybar: shown('.part.activitybar'), statusbar: shown('.part.statusbar'), titlebar: shown('.part.titlebar'), explorer: shown('.explorer-viewlet'), editor: shown('.part.editor'), editors: [...document.querySelectorAll('.part.editor .monaco-editor[data-uri]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length };
})()`;
// A recorder that notes every bar that is ever laid out, from a mutation callback (a microtask, before the page script's undo, which waits for a
// frame): a chord that worked and was undone at once is still recorded. Without it the page script would hide whether a chord was disabled.
const RECORDER = `(() => {
  window.__seen = {};
  const names = { sidebar: '.part.sidebar', panel: '.part.panel', secondarysidebar: '.part.auxiliarybar', explorer: '.explorer-viewlet' };
  const look = () => { for (const [n, sel] of Object.entries(names)) { const e = document.querySelector(sel); if (!e) continue; const r = e.getBoundingClientRect(); if (r.width > 0 && r.height > 0) window.__seen[n] = true; } };
  new MutationObserver(look).observe(document.documentElement, { subtree: true, attributes: true, childList: true, attributeFilter: ['class', 'style'] });
  return 'recording';
})()`;
const seenNow = async (b) => Object.keys((await b.ev("window.__seen")) ?? {}).sort();
const barsHidden = (r) => !!r && !r.sidebar && !r.panel && !r.secondarysidebar && !r.activitybar && !r.statusbar && !r.titlebar && !r.explorer;
const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const KEYS = {
  a: ["KeyA", 65], b: ["KeyB", 66], f: ["KeyF", 70], j: ["KeyJ", 74], k: ["KeyK", 75], m: ["KeyM", 77], n: ["KeyN", 78], p: ["KeyP", 80], w: ["KeyW", 87], z: ["KeyZ", 90],
};
// The editor has the keyboard focus before each chord (a panel that opened would have taken it, and the chord would then go to the panel).
const chord = async (b, k, ...mods) => {
  await b.ev("document.querySelector('.monaco-editor textarea.inputarea')?.focus()");
  await b.key(k, KEYS[k][0], KEYS[k][1], mods.reduce((m, x) => m | MOD[x], 0));
};
const WORKBENCH_CLASSES = `[...(document.querySelector('.monaco-workbench')?.classList ?? [])].sort().join(" ")`;
const zenToast = `[...document.querySelectorAll('.notification-toast')].some((e) => /Zen Mode/i.test(e.innerText))`;
const quickInput = `(() => { const e = document.querySelector('.quick-input-widget'); if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? { text: e.querySelector('input')?.value ?? '', rows: e.querySelectorAll('.quick-input-list .monaco-list-row').length } : null; })()`;
const findVisible = `(() => { const e = document.querySelector('.monaco-editor .find-widget'); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; })()`;
const escape = (b) => b.key("Escape", "Escape", 27);

gp4: {
  if (process.env.SKIP_GP4 === "1") break gp4;
  const want = (part) => !process.env.GP4_PARTS || process.env.GP4_PARTS.split(",").includes(part); // GP4_PARTS=ctl,ovl,term,e8,table,e9: a faster rerun of some parts
  const srv = await startServer("gp4", false, { "files.autoSave": "off" });
  const shotName = (n) => `GP4-${n}.png`;

  // --- control: the close chords only, as before this PR. The four layout chords work, and the recorder sees them.
  if (want("ctl")) {
    const b = await browser("gp4-ctl", srv, { hide: true, overlay: false, flash: false });
    await b.openFile("sample.py");
    await sleep(3);
    if (!(await b.ev(BARS_NOW))?.editor) { notRendered("GP4 control"); }
    else {
      await chord(b, "w", "meta"); await sleep(1.5);
      const afterW = await b.ev(BARS_NOW);
      check(afterW?.editors === 0, "GP4 control: ...and Cmd+W closes the editor inside VS Code", JSON.stringify(afterW));
      await b.shot(shotName("control-after-w"));
      await b.openFile("sample.py"); // Cmd+W closed it: open it again for the layout chords
      await b.ev(RECORDER);
      await chord(b, "b", "meta"); await sleep(1.5);
      await chord(b, "j", "meta"); await sleep(1.5);
      const seen = await seenNow(b);
      check(seen.includes("sidebar") && seen.includes("panel"), "GP4 control: without the overlay Cmd+B and Cmd+J lay out the side bar and the panel (the recorder sees them, so it proves a disabled chord is disabled)", seen.join(","));
      // Cmd+K Z has no sign in the DOM that this check can read (the title bar and the bars are hidden already), so its control is the
      // class list of the workbench container before and after: informational, not a pass/fail line.
      const before = await b.ev(WORKBENCH_CLASSES);
      await chord(b, "k", "meta"); await b.key("z", "KeyZ", 90); await sleep(1.5);
      const after = await b.ev(WORKBENCH_CLASSES);
      console.log(`[gp4-ctl] Cmd+K Z, workbench classes before: ${before} -> after: ${after}`);
    }
    b.close();
  }

  // --- the overlay: the four chords change nothing, the three overlays open, the editor keeps its file.
  if (want("ovl")) {
    const b = await browser("gp4-ovl", srv, { hide: true, flash: false });
    await b.openFile("sample.py");
    await sleep(3);
    const start = await b.ev(BARS_NOW);
    if (!start?.editor) notRendered("GP4");
    else {
      check(barsHidden(start) && start.editors === 1, "GP4: before any chord only the editor shows, with its file", JSON.stringify(start));
      await b.shot(shotName("start"));
      await b.ev(RECORDER);
      await chord(b, "b", "meta"); await sleep(1.5);
      await chord(b, "j", "meta"); await sleep(1.5);
      await b.shot(shotName("chords"));
      check((await seenNow(b)).length === 0, "GP4: Cmd+B and Cmd+J change nothing on screen: no side bar, Explorer or panel is ever laid out", (await seenNow(b)).join(","));
      const classesBefore = await b.ev(WORKBENCH_CLASSES);
      await chord(b, "k", "meta"); await b.key("z", "KeyZ", 90); await sleep(1.5);
      check((await b.ev(WORKBENCH_CLASSES)) === classesBefore, "GP4: Cmd+K Z leaves the workbench container's classes as they were (Zen Mode would change them)", classesBefore);
      check((await b.ev(zenToast)) === false, "GP4: Cmd+K Z shows no Zen Mode notification (see the control's class list line: the chord's removal itself is checked in the unit tests and by the keybindings the profile holds)", JSON.stringify((await b.ev(PAGE_STATE)).toasts));
      await chord(b, "w", "meta"); await sleep(1.5);
      const afterW = await b.ev(BARS_NOW);
      check(afterW?.editors === 1 && barsHidden(afterW), "GP4: Cmd+W does not close the editor inside VS Code; the tab keeps its file", JSON.stringify(afterW));
      check((await b.ev(PAGE_STATE))?.text?.includes("def estimate"), "GP4: ...and the file's text is still in the editor");

      // Ordinary keys are untouched: typing and Cmd+Z.
      await b.send("Input.insertText", { text: "TYPED " }); await sleep(0.8);
      check((await b.ev(PAGE_STATE))?.text?.includes("TYPED # a comment"), "GP4: ordinary typing reaches the editor");
      await chord(b, "z", "meta"); await sleep(0.8);
      check(!(await b.ev(PAGE_STATE))?.text?.includes("TYPED #"), "GP4: Cmd+Z still undoes it (VS Code undoes by word, so the space typed with the word goes)", JSON.stringify((await b.ev(PAGE_STATE)).text.slice(0, 80)));

      // Cmd+F, Cmd+Shift+P, Cmd+P: overlays, no bar behind them.
      await chord(b, "f", "meta"); await sleep(1);
      await b.shot(shotName("find"));
      check((await b.ev(findVisible)) === true, "GP4: Cmd+F opens the find widget in the editor");
      await escape(b); await sleep(0.5);
      await chord(b, "p", "meta", "shift"); await sleep(1.2);
      await b.shot(shotName("palette"));
      const palette = await b.ev(quickInput);
      check(!!palette && palette.text.startsWith(">"), "GP4: Cmd+Shift+P opens the command palette", JSON.stringify(palette));
      await escape(b); await sleep(0.5);
      await chord(b, "p", "meta"); await sleep(1.2);
      await b.shot(shotName("quickopen"));
      const quick = await b.ev(quickInput);
      check(!!quick && !quick.text.startsWith(">"), "GP4: Cmd+P opens quick open", JSON.stringify(quick));
      await escape(b); await sleep(0.5);
      check((await seenNow(b)).length === 0 && barsHidden(await b.ev(BARS_NOW)), "GP4: ...with no bar behind any of the three overlays", (await seenNow(b)).join(","));
    }
    b.close();
  }

  // --- E8 with a terminal: "Terminal: Create New Terminal" opens the panel and VS Code asks whether to trust the folder, a modal dialog that
  // takes the keyboard focus and stops every key at itself; the panel's close chord must still get through (the page script presses it from
  // outside the dialog), and the dialog is VS Code's own and stays (F8). Once the folder is trusted the terminal runs, and the panel that
  // reopens on it takes the focus: the chord must close it from there too.
  if (want("term")) {
    const tsrv = await startServer("gp4-term", false, { "files.autoSave": "off" });
    const b = await browser("gp4-term", tsrv, { hide: true, flash: false });
    await b.openFile("sample.py");
    await sleep(3);
    if (!(await b.ev(BARS_NOW))?.editor) notRendered("E8 terminal");
    else {
      const run = async (title) => {
        await chord(b, "p", "meta", "shift"); await sleep(1);
        await b.send("Input.insertText", { text: title }); await sleep(1.2);
        await b.key("Enter", "Enter", 13);
        await sleep(3);
      };
      const dialogUp = `(() => { const e = document.querySelector('.monaco-dialog-box'); return !!e && e.getBoundingClientRect().width > 0 && /trust/i.test(e.innerText); })()`;
      const terminalFocused = `!!document.activeElement?.closest?.('.terminal-wrapper')`;
      await b.ev(RECORDER);
      await run("Terminal: Create New Terminal");
      const created = await b.ev(BARS_NOW);
      const dialog = await b.ev(dialogUp);
      await b.shot("GP4-terminal-trust.png");
      check(barsHidden(created) && created.editors === 1, "E8 terminal: \"Terminal: Create New Terminal\" ends hidden, with the editor on its file, also while VS Code's trust dialog is up", JSON.stringify({ created, dialog }));
      check(dialog === true, "F8: ...and the trust dialog is still there, answered by nobody (the undo does not touch VS Code's own popups)", String(dialog));
      // Trust the folder: the terminal starts, the panel opens on it and the terminal takes the focus.
      await b.ev(`[...document.querySelectorAll('.monaco-dialog-box .monaco-button')].find((e) => /Trust Folder/i.test(e.innerText))?.click()`);
      await sleep(4);
      const trusted = await b.ev(BARS_NOW);
      console.log(`[gp4-term] after trusting the folder: terminal focused ${await b.ev(terminalFocused)}, seen ${(await seenNow(b)).join(",") || "nothing"}`);
      check(barsHidden(trusted) && trusted.editors === 1, "E8 terminal: ...and once the folder is trusted and the terminal runs, the panel is hidden", JSON.stringify(trusted));
      await run("View: Toggle Panel Visibility");
      const afterPanel = await b.ev(BARS_NOW);
      console.log(`[gp4-term] Toggle Panel with a running terminal: terminal focused ${await b.ev(terminalFocused)}`);
      check(barsHidden(afterPanel) && afterPanel.editors === 1, "E8 terminal: \"View: Toggle Panel Visibility\" with a running terminal in the panel ends hidden, with the editor on its file", JSON.stringify(afterPanel));
      await b.shot("GP4-terminal.png");
      for (let i = 0; i < 3; i++) await run("View: Toggle Panel Visibility");
      check(barsHidden(await b.ev(BARS_NOW)), "E8 terminal: ...and three more runs of it end hidden too");
    }
    b.close();

    // The Code tab's default: the vault folder is trusted (the trust seed), so the terminal starts at once, the panel opens on it and the
    // terminal has the keyboard focus. No dialog is up: the chord is the route.
    const tb = await browser("gp4-term-trusted", tsrv, { hide: true, flash: false, trust: true });
    await tb.openFile("sample.py");
    await sleep(3);
    if (!(await tb.ev(BARS_NOW))?.editor) notRendered("E8 terminal, trusted folder");
    else {
      const run = async (title) => {
        await chord(tb, "p", "meta", "shift"); await sleep(1);
        await tb.send("Input.insertText", { text: title }); await sleep(1.2);
        await tb.key("Enter", "Enter", 13);
        await sleep(3);
      };
      await tb.ev(RECORDER);
      await run("Terminal: Create New Terminal");
      const created = await tb.ev(BARS_NOW);
      console.log(`[gp4-term-trusted] after Create New Terminal: dialog up ${await tb.ev("!!document.querySelector('.monaco-dialog-modal-block')")}, terminal rows ${await tb.ev("document.querySelectorAll('.terminal-wrapper').length")}, seen ${(await seenNow(tb)).join(",") || "nothing"}`);
      check(barsHidden(created) && created.editors === 1, "E8 terminal (trusted folder): \"Terminal: Create New Terminal\" ends hidden, with the editor on its file", JSON.stringify(created));
      for (let i = 0; i < 3; i++) {
        await run("View: Toggle Panel Visibility");
        const r = await tb.ev(BARS_NOW);
        check(barsHidden(r) && r.editors === 1, `E8 terminal (trusted folder): "View: Toggle Panel Visibility" with a running terminal, run ${i + 1}, ends hidden`, JSON.stringify(r));
      }
      await tb.shot("GP4-terminal-trusted.png");
    }
    tb.close();
    stopPid(tsrv.pid);
  }

  // --- E8: the eight commands the spec names, from the palette; then every command of REVEALING_COMMANDS, by a chord written after the overlay.
  if (want("e8") || want("table")) {
    const b = await browser("gp4-e8", srv, { hide: true, flash: false });
    await b.openFile("sample.py");
    await sleep(3);
    if (!want("e8")) { /* not asked for */ }
    else if (!(await b.ev(BARS_NOW))?.editor) notRendered("E8");
    else {
      const run = async (title) => {
        await chord(b, "p", "meta", "shift"); await sleep(1);
        await b.send("Input.insertText", { text: title }); await sleep(1.2);
        await b.key("Enter", "Enter", 13);
        await sleep(2);
        await escape(b); await sleep(0.4); // a trust prompt or picker a command opens is VS Code's own and is only dismissed here, so the next step starts clean
      };
      const PALETTE = ["View: Toggle Primary Side Bar Visibility", "View: Toggle Panel Visibility", "View: Toggle Secondary Side Bar Visibility", "View: Toggle Activity Bar Visibility", "View: Toggle Status Bar Visibility", "View: Toggle Zen Mode", "View: Show Explorer", "Terminal: Create New Terminal"];
      for (const title of PALETTE) {
        await b.ev(RECORDER);
        await run(title);
        const r = await b.ev(BARS_NOW);
        if (title === "View: Toggle Zen Mode") { await run(title); } // leave Zen Mode again for the next command
        const after = await b.ev(BARS_NOW);
        if (title === "Terminal: Create New Terminal") await b.shot("GP4-undo.png");
        check(barsHidden(r) && barsHidden(after) && after.editors === 1, `E8: "${title}" from the palette leaves every bar hidden and the editor on its file`, JSON.stringify({ r, after }));
      }
      await run("View: Toggle Primary Side Bar Visibility");
      await b.shot("PR-3-undo-primary.png");

      // twice in a row, and ten times fast: a chord bound to the command writes into the profile after the overlay (below, in the table), here via the palette
      for (let i = 0; i < 2; i++) await run("View: Toggle Panel Visibility");
      check(barsHidden(await b.ev(BARS_NOW)), "E8: a revealing command run twice in a row ends hidden");
    }
    b.close();

    // the table: every command of REVEALING_COMMANDS through its own chord. The chords are rules written AFTER the overlay, so the
    // overlay has not unbound them; the palette runs the same command id.
    const codeFor = (i) => {
      const keys = [..."abcdefghijklmnopqrstuvwxyz"].map((c) => [c, `Key${c.toUpperCase()}`, c.toUpperCase().charCodeAt(0)]).concat([..."0123456789"].map((c) => [c, `Digit${c}`, c.charCodeAt(0)]), Array.from({ length: 12 }, (_, n) => [`f${n + 1}`, `F${n + 1}`, 112 + n]));
      return keys[i];
    };
    const entries = REVEALING_COMMANDS.map((command, i) => ({ command, key: codeFor(i) }));
    const rules = entries.map(({ command, key }) => ({ key: `ctrl+alt+shift+cmd+${key[0]}`, command }));
    if (!want("table")) { stopPid(srv.pid); break gp4; }
    const t = await browser("gp4-table", srv, { hide: true, flash: false, extraRules: rules });
    await t.openFile("sample.py");
    await sleep(3);
    if (!(await t.ev(BARS_NOW))?.editor) notRendered("E8 table");
    else {
      const first = await t.ev(BARS_NOW);
      check(first?.editors === 1 && barsHidden(first), "E8 table: before the first command the tab shows only the editor, with its file", JSON.stringify(first));
      const all = 15; // alt 1 + ctrl 2 + meta 4 + shift 8
      const failing = [];
      const press = async ({ key }) => {
        await t.ev("document.querySelector('.monaco-editor textarea.inputarea')?.focus()");
        await t.key(key[0], key[1], key[2], all);
        await sleep(1.5);
        await escape(t); await sleep(0.3);
        return t.ev(BARS_NOW);
      };
      for (const entry of entries) {
        await t.ev(RECORDER);
        const r = await press(entry);
        if (!(barsHidden(r) && r.editors === 1)) failing.push(`${entry.command}: ${JSON.stringify(r)}`);
        if (entry.command === "workbench.action.toggleZenMode") await press(entry); // leave Zen Mode again for the next command
      }
      check(failing.length === 0, `E8: each of the ${entries.length} revealing commands ends with every bar hidden and the editor on its file`, failing.join(" | "));

      // ten times fast
      const toggle = entries.find((e) => e.command === "workbench.action.togglePanel");
      await t.ev(RECORDER);
      await t.ev("document.querySelector('.monaco-editor textarea.inputarea')?.focus()");
      for (let i = 0; i < 10; i++) { await t.key(toggle.key[0], toggle.key[1], toggle.key[2], all); await sleep(0.05); }
      await sleep(3);
      const burst = await t.ev(BARS_NOW);
      check(barsHidden(burst) && burst.editors === 1, "E8: Toggle Panel ten times fast ends hidden, with the editor on its file", JSON.stringify(burst));
      // and a stuck state would show as a bar that does not close on the next, ordinary run
      const sb = entries.find((e) => e.command === "workbench.action.toggleSidebarVisibility");
      await t.key(sb.key[0], sb.key[1], sb.key[2], all); await sleep(2);
      check(barsHidden(await t.ev(BARS_NOW)), "E8: ...and the next command is undone as before (no stuck state)");
    }
    t.close();
  }

  // --- E9: copied keybindings that try to bring the bars back, also after a reload with the same copy id.
  if (want("e9")) {
    const userRules = `// my keybindings (a comment and a trailing comma on purpose)
[
  { "key": "ctrl+alt+n", "command": "workbench.action.toggleSidebarVisibility" },
  { "key": "cmd+b", "command": "workbench.action.toggleSidebarVisibility" },
  { "key": "cmd+j", "command": "workbench.action.togglePanel" },
  { "key": "cmd+k z", "command": "workbench.action.toggleZenMode" },
  { "key": "cmd+w", "command": "workbench.action.closeActiveEditor" },
  { "key": "ctrl+alt+m", "command": "workbench.action.toggleAuxiliaryBar" },
]
`;
    const copy = { id: "gp4-copy-1", settings: {}, keybindingsBase64: Buffer.from(userRules).toString("base64") };
    const b = await browser("gp4-e9", srv, { hide: true, flash: false, copy });
    await b.openFile("sample.py");
    await sleep(3);
    if (!(await b.ev(BARS_NOW))?.editor) notRendered("E9");
    else {
      const first = await b.ev(BARS_NOW);
      check(first?.editors === 1 && barsHidden(first), "E9: before any chord the tab shows only the editor, with its file", JSON.stringify({ first, page: (await b.ev(PAGE_STATE)) }).slice(0, 700));
      await b.shot("GP4-e9-start.png");
      const stored = await b.ev(`(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open(${JSON.stringify(settings.WORKBENCH_DB.name)}, ${settings.WORKBENCH_DB.version}); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); const raw = await new Promise((res, rej) => { const q = db.transaction(${JSON.stringify(settings.WORKBENCH_DB.store)}).objectStore(${JSON.stringify(settings.WORKBENCH_DB.store)}).get("/User/keybindings.json"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); db.close(); return typeof raw === "string" ? raw : new TextDecoder().decode(raw); })()`);
      check(typeof stored === "string" && stored.startsWith(userRules.slice(0, userRules.lastIndexOf("]"))) , "E9: the user's own text is kept byte for byte at the head of the stored keybindings.json", String(stored).slice(0, 120));
      const press = async () => {
        await b.ev(RECORDER);
        await chord(b, "n", "ctrl", "alt"); await sleep(1.2);
        await chord(b, "m", "ctrl", "alt"); await sleep(1.2);
        await chord(b, "b", "meta"); await sleep(1.2);
        await chord(b, "j", "meta"); await sleep(1.2);
        await chord(b, "k", "meta"); await b.key("z", "KeyZ", 90); await sleep(1.2);
        await chord(b, "w", "meta"); await sleep(1.2);
        return [await seenNow(b), await b.ev(BARS_NOW)];
      };
      let [seen, now] = await press();
      check(seen.length === 0 && now.editors === 1 && barsHidden(now), "E9: a copied ctrl+alt+n (and ctrl+alt+m) for a layout command, and a copied cmd+b, cmd+j, cmd+k z, cmd+w re-bound to their commands, bring nothing back", JSON.stringify({ seen, now }));
      await b.reload();
      await b.shot("PR-3-reload-before.png");
      [seen, now] = await press();
      await b.shot("GP4-reload.png");
      check(seen.length === 0 && barsHidden(now), "E9: after a reload of the tab (same copy id) the same chords still bring nothing back", JSON.stringify({ seen, now }));
    }
    b.close();
  }
  stopPid(srv.pid);
}

stopAll();
fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
console.log(`screenshots: ${outDir}`);
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exit(neverPainted ? 2 : failures.length ? 1 : 0);
