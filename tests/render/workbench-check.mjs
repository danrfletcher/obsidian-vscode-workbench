/**
 * Real-server check for two things the Code tab leaves to VS Code itself, run in a real workbench:
 *
 *   G4 (checklist C5, C35): a file that changes on disk behind an open editor. What VS Code does is
 *      recorded and asserted so the README's statement ("VS Code decides; the plugin adds no prompt and never
 *      overwrites the buffer") stays true: a clean buffer reloads with no prompt of any kind; a buffer with
 *      unsaved edits keeps them and the disk keeps the outside change; saving that buffer is refused with
 *      VS Code's own "newer" message and a Compare / Overwrite choice, and nothing is written.
 *   G5, G6 (checklist C36): with the plugin's own workbench settings (writeMachineSettings) for light and for
 *      dark, the chrome is hidden (all but the side bar, which has no switch: src/chrome-settings.ts) and the text in the editor is legible: the contrast ratio of every syntax
 *      colour on the editor's own background, measured from the page's computed styles (WCAG 2.x), has to be
 *      at least MIN_CONTRAST.
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
 * the spawn).
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
  entryPoints: { settings: path.join(root, "src/settings.ts"), "dirty-script": path.join(root, "src/dirty-script.ts") },
  bundle: true, format: "esm", platform: "node", outdir: path.join(work, "plugin"), outExtension: { ".js": ".mjs" }, logLevel: "error",
});
const settings = await import(pathToFileURL(path.join(work, "plugin/settings.mjs")).href);
// The plugin's own unsaved-buffer probe (what delete, rename, idle stop and quit ask), run against the real workbench below.
const { DIRTY_SCRIPT, fileDirtyScript } = await import(pathToFileURL(path.join(work, "plugin/dirty-script.mjs")).href);

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

// --- one browser -------------------------------------------------------------------------------------
async function browser(name, srv) {
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
  const shot = async (file) => {
    const s = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(outDir, file), Buffer.from(s.result.data, "base64"));
  };
  await send("Page.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `http://127.0.0.1:${srv.port}/?tkn=${srv.token}&folder=${encodeURIComponent(vault)}` });
  await sleep(20);
  const META = 4;
  const openFile = async (file) => {
    await key("p", "KeyP", 80, META);
    await sleep(1.5);
    await send("Input.insertText", { text: file });
    await sleep(1.5);
    await key("Enter", "Enter", 13);
    await sleep(4);
  };
  const close = () => {
    ws.close();
    stopPid(chrome.pid);
  };
  return { send, ev, key, shot, openFile, close, META };
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
  // The web workbench saves by itself after a second unless auto-save is off; the checklist runs with it off (GP7).
  const srv = await startServer("g4", true, { "files.autoSave": "off" });
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
    chrome: { titlebar: shown('.part.titlebar'), activitybar: shown('.part.activitybar'), statusbar: shown('.part.statusbar'), sidebar: shown('.part.sidebar'), panel: shown('.part.panel'), menubar: shown('.menubar') },
  };
})()`;

for (const dark of [false, true]) {
  const name = dark ? "dark" : "light";
  const srv = await startServer(name, dark);
  const b = await browser(name, srv);
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
  // As documented (src/chrome-settings.ts, docs/spike-decision.md): the side bar has no settings switch and stays visible.
  const expected = { titlebar: false, activitybar: false, statusbar: false, sidebar: true, panel: false, menubar: false };
  check(JSON.stringify(r.chrome) === JSON.stringify(expected), `${name}: the chrome is hidden except the side bar, which has no settings switch (F11)`, JSON.stringify(r.chrome));
  b.close();
  stopPid(srv.pid);
}

stopAll();
fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
console.log(`screenshots: ${outDir}`);
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exit(neverPainted ? 2 : failures.length ? 1 : 0);
