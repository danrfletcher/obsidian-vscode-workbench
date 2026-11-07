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
 *      behind VS Code's Workspace Trust dialog (the dialog stops every key, so the page script clicks the panel's hide button) and the one
 *      Toggle Panel Visibility reopens in a trusted folder (each line says whether a terminal row existed and had the focus then).
 *
 *   GP2, GP3, E2, E3, E4, E7 (PR-4): a file opened from inside the editor (Go to Definition, Cmd+P) is reported by the plugin's page
 *      script (src/open-intercept-script.ts) with its file and line, mapped back to a vault file or an outside path by the plugin's own
 *      rule (src/paths.ts targetOfUri, src/open-from-editor.ts planEditorOpen), and put away (the close-editor chord) so the first
 *      tab shows its own file at its own cursor and scroll; the file the tab was loaded with is never reported; Split Editor from the
 *      palette is undone (a control without the script shows two groups); a tab opened for a file is put on a line by the go-to-line
 *      script (src/goto-line-script.ts), with a bad line clamped; and the VS Code tab strip is never laid out through all of it.
 *
 * Not part of `npm test`: it needs a VS Code build with `serve-web`, a cached VS Code server for that build,
 * and Google Chrome. It starts `serve-web` on a free loopback port and headless Chrome on a free debugging
 * port, and stops what it started, by PID, at the end.
 *
 *   npm run check:workbench [outDir]
 *
 * Env: CODE_CLI (the build's `code` script, or the standalone CLI binary for a build that is not installed), CLI_DATA_SRC (a --cli-data-dir that already holds the server for
 * that build; it is cloned into the scratch dir, never written to), ALLOW_DOWNLOAD=1 (let `serve-web` download
 * the server for the installed build from Microsoft into the scratch dir when CLI_DATA_SRC is not set or does
 * not hold it; without it nothing is ever downloaded), CHROME, SERVER_TMPDIR (default /tmp, see the comment at
 * the spawn), SKIP_G4=1 (skip the G4 block), ONLY_GP4=1 (run only the GP4/E8/E9 block), SKIP_PR4=1 (skip the PR-4 block), ONLY_PR4=1 (run only it).
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
// The app's `code --version` prints "version\ncommit\narch"; the standalone CLI (update.code.visualstudio.com/commit:<sha>/cli-darwin-arm64/stable,
// the way to run a build that is not installed, e.g. 1.143.1) prints "code 1.143.1 (commit <sha>)". Both are read.
const versionOut = execFileSync(CODE, ["--version"], { encoding: "utf8" }).trim();
const [version, commit] = (() => {
  const cli = /^code\S*\s+(\S+)\s+\(commit ([0-9a-f]{40})\)/.exec(versionOut);
  return cli ? [cli[1], cli[2]] : versionOut.split("\n");
})();
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
// Say which builds this run covered and which of the two the specs name it did not: the output is the record of a run, and a run on
// one build must not read as a run on both.
const SPEC_BUILDS = ["1.143.1", "1.144.0"];
console.log(`workbench-check: ran on VS Code ${version} (server commit ${commit}). Builds the specs name that this run did NOT cover: ${SPEC_BUILDS.filter((v) => !version.startsWith(v)).join(", ") || "none"}.`);
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
  entryPoints: { paths: path.join(root, "src/paths.ts"), "trust-seed": path.join(root, "src/trust/trust-seed.ts"), settings: path.join(root, "src/settings.ts"), "dirty-script": path.join(root, "src/dirty-script.ts"), "chrome-settings": path.join(root, "src/chrome-settings.ts"), "chrome-script": path.join(root, "src/chrome-script.ts"), "open-intercept-script": path.join(root, "src/open-intercept-script.ts"), "goto-line-script": path.join(root, "src/goto-line-script.ts"), "open-from-editor": path.join(root, "src/open-from-editor.ts") },
  bundle: true, format: "esm", platform: "node", outdir: path.join(work, "plugin"), outExtension: { ".js": ".mjs" }, logLevel: "error",
});
const settings = await import(pathToFileURL(path.join(work, "plugin/settings.mjs")).href);
const pluginPaths = await import(pathToFileURL(path.join(work, "plugin/paths.mjs")).href);
const trustSeed = await import(pathToFileURL(path.join(work, "plugin/trust-seed.mjs")).href);
// The plugin's own unsaved-buffer probe (what delete, rename, idle stop and quit ask), run against the real workbench below.
const { DIRTY_SCRIPT } = await import(pathToFileURL(path.join(work, "plugin/dirty-script.mjs")).href);

// What the Code tab seeds and runs to hide the chrome (src/main.ts chromeHiding(), src/code-view.ts loadWorkbench), from the same code.
const { chromeKeybindings, overlayKeybindings, unbindCommands, REVEALING_COMMANDS } = await import(pathToFileURL(path.join(work, "plugin/chrome-settings.mjs")).href);
const { buildChromeHideScript } = await import(pathToFileURL(path.join(work, "plugin/chrome-script.mjs")).href);
// What the Code tab runs to turn an open from the editor into a tab (PR-4), from the same code.
const { buildOpenInterceptScript, parseOpenReport, RESTORE_OPEN_SCRIPT, OPEN_INTERCEPT_INSTALLED } = await import(pathToFileURL(path.join(work, "plugin/open-intercept-script.mjs")).href);
const { buildGoToLineScript, GO_TO_LINE_DONE } = await import(pathToFileURL(path.join(work, "plugin/goto-line-script.mjs")).href);
const { planEditorOpen } = await import(pathToFileURL(path.join(work, "plugin/open-from-editor.mjs")).href);

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
async function browser(name, srv, { hide = false, dark = false, copy = null, overlay = true, extraRules = null, script = true, flash: wantFlash = true, trust = false, file = null, intercept = null } = {}) {
  const cdpPort = await freePort();
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${path.join(work, "chrome-" + name)}`, "--no-first-run", "--disable-background-networking", "about:blank"], { stdio: "ignore" });
  started.push(chrome.pid);
  await sleep(5);
  const page = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pend = new Map();
  const consoleLog = []; // what the page printed with console.*, in order (the plugin's open report is one of them)
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === "Runtime.consoleAPICalled") consoleLog.push(d.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
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
  await send("Runtime.enable");
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
  // `file`: the URL the Code tab navigates to for a file (the same code), which opens that file in the editor; else the bare folder.
  const workbenchUrl = file ? pluginPaths.buildFileUrl(`http://127.0.0.1:${srv.port}`, vault, file, srv.token) : `http://127.0.0.1:${srv.port}/?tkn=${srv.token}&folder=${encodeURIComponent(vault)}`;
  if (hide) await seedProfile();
  const navigatedAt = Date.now();
  await send("Page.navigate", { url: workbenchUrl });
  const flash = [];
  if (hide) {
    await waitWorkbench();
    if (script) console.log(`[${name}] chrome script: ${await ev(buildChromeHideScript())}`);
    // PR-4: the tab's open-from-editor script, installed at the workbench page's dom-ready as the Code tab does (the file it was loaded with is the tab's own).
    if (intercept) console.log(`[${name}] open-from-editor script: ${await ev(process.env.PR4_DEBUG ? buildOpenInterceptScript(intercept).replace("window.__vscwOpen = {", "window.__dbg = () => JSON.stringify({ own, reported, pending, budget, s: read() }); window.__vscwOpen = {") : buildOpenInterceptScript(intercept))}`);
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
  return { send, ev, key, shot, openFile, close, META, reload, consoleLog };
}

// What VS Code is showing besides the editor: toasts, dialogs, and the editor's text.
const PAGE_STATE = `(() => {
  const txt = (sel) => [...document.querySelectorAll(sel)].map((e) => e.innerText.replace(/\\s+/g, ' ').trim()).filter(Boolean);
  const visible = (e) => !!e && e.offsetWidth > 0 && e.offsetHeight > 0;
  return {
    text: [...document.querySelectorAll('.monaco-editor .view-line')].map((e) => e.innerText.replace(/\\u00a0/g, ' ')).join('\\n'),
    toasts: txt('.notifications-toasts .notification-toast'),
    dialogs: txt('.monaco-dialog-box'),
    // The tab strip is hidden by the plugin's settings, so the unsaved marker is read from the window title (the signal DIRTY_SCRIPT reads).
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
  if (process.env.SKIP_G4 === "1" || process.env.ONLY_GP4 === "1" || process.env.ONLY_PR4 === "1") break g4; // SKIP_G4=1: only the G5/G6 block (a faster rerun while working on the hiding)
  // The web workbench saves by itself after a second unless auto-save is off; the checklist runs with it off (GP7).
  // The plugin's Machine file hides the tab strip (GP1) and writes `window.title` (DIRTY_TITLE_SETTINGS), so the unsaved-buffer probe
  // below (DIRTY_SCRIPT, PR-5) reads the window title's leading dot, the one signal left with no tab strip. It names the ACTIVE editor only;
  // a Code tab holds one file, so that is the tab's file.
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

  // 1b2. with a second file's buffer left unsaved (in the same page, behind the active editor), saving the first still reads clean for the
  // first (PR-5 E5): the probe is the window title of the active editor, so it follows the file in front and not the rest of the page.
  await b.openFile("other.txt");
  await b.send("Input.insertText", { text: "OTHER " });
  await sleep(1.5);
  check((await b.ev(DIRTY_SCRIPT)) === true, "G3: the second file typed and left unsaved reads dirty while it is in front");
  await b.openFile("mine.txt");
  await b.send("Input.insertText", { text: "MINE " });
  await sleep(1.5);
  check((await b.ev(DIRTY_SCRIPT)) === true, "G3: the first file typed reads dirty (title: " + JSON.stringify((await pageState(b)).title) + ")");
  // Watch the signal through the save: it must not read clean before the text is on disk (two quick reads while a save is in flight).
  const watch = await b.ev(`(() => { window.__w = []; const t0 = Date.now(); window.__t = setInterval(() => window.__w.push([Date.now() - t0, document.title.startsWith("\\u25cf")]), 15); return true; })()`);
  await b.key("s", "KeyS", 83, b.META);
  let firstCleanOnDisk = null;
  for (let i = 0; i < 100 && firstCleanOnDisk === null; i++) {
    if ((await b.ev(DIRTY_SCRIPT)) === false) firstCleanOnDisk = fs.readFileSync(path.join(vault, "mine.txt"), "utf8").startsWith("MINE ");
    else await sleep(0.03);
  }
  await b.ev("clearInterval(window.__t); true");
  const seen = await b.ev("window.__w");
  console.log("G3: signal samples through the save (ms, dirty):", JSON.stringify((seen ?? []).filter((x, i, all) => i === 0 || x[1] !== all[i - 1][1])));
  check(watch === true && firstCleanOnDisk === true, "G3: ...a save shows dirty, then clean, and the first clean read already has the text on disk (never clean before the file is written)");
  await sleep(2);
  check((await b.ev(DIRTY_SCRIPT)) === false, "G3: ...after saving the first file it reads clean although the second file's buffer is still unsaved");
  await b.openFile("other.txt");
  check((await b.ev(DIRTY_SCRIPT)) === true, "G3: ...and the second file reads dirty again when it is in front");
  await b.key("s", "KeyS", 83, b.META);
  await sleep(3);
  check((await b.ev(DIRTY_SCRIPT)) === false, "G3: ...and saving the second file leaves the page clean for the steps below");
  // E5 hot-exit / restored editor: a file opened and not typed in reads clean (nothing typed, nothing to lose).
  await b.openFile("clean.txt");
  check((await b.ev(DIRTY_SCRIPT)) === false, "G3: a file opened with nothing typed in it reads clean");

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

for (const dark of process.env.ONLY_GP4 === "1" || process.env.ONLY_PR4 === "1" ? [] : [false, true]) {
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
  if (process.env.SKIP_GP4 === "1" || process.env.ONLY_PR4 === "1") break gp4;
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
      // Only the side bar is asserted. On VS Code 1.145.0-insider Cmd+J with no overlay did not reveal the panel (the recorder never saw
      // it), so asserting the panel made the control fail on a build where nothing is wrong; the panel is reported, not required.
      check(seen.includes("sidebar"), "GP4 control: without the overlay Cmd+B lays out the side bar (the recorder sees it, so it proves a disabled chord is disabled)", seen.join(","));
      console.log(`[gp4-ctl] Cmd+J with no overlay ${seen.includes("panel") ? "revealed" : "did not reveal"} the panel on this build (informational)`);
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
  // outside the dialog), and the dialog is VS Code's own and stays (F8). Once the folder is trusted the terminal MAY start, and the panel
  // that reopens on it may take the focus: the chord must close it from there too. Whether a terminal started and holds the focus is
  // MEASURED (termState below) and every check message here says what was measured; no message claims a running or focused terminal
  // that the run did not have. A run on which no terminal row appears prints that the focus-in-terminal path was NOT exercised.
  if (want("term")) {
    const termState = async (page) => {
      const st = await page.ev(`({ rows: document.querySelectorAll('.terminal-wrapper').length, focused: !!document.activeElement?.closest?.('.terminal-wrapper') })`);
      return st.rows === 0 ? "no terminal row" : st.focused ? "terminal row, focused" : "terminal row, not focused";
    };
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
      const stateTrusted = await termState(b);
      console.log(`[gp4-term] after trusting the folder: ${stateTrusted}, terminal focused ${await b.ev(terminalFocused)}, seen ${(await seenNow(b)).join(",") || "nothing"}`);
      check(barsHidden(trusted) && trusted.editors === 1, `E8 terminal: ...and once the folder is trusted (${stateTrusted} measured), the panel is hidden`, JSON.stringify(trusted));
      const stateBeforePanel = await termState(b);
      await run("View: Toggle Panel Visibility");
      const afterPanel = await b.ev(BARS_NOW);
      console.log(`[gp4-term] Toggle Panel with ${stateBeforePanel}: terminal focused ${await b.ev(terminalFocused)}`);
      check(barsHidden(afterPanel) && afterPanel.editors === 1, `E8 terminal: "View: Toggle Panel Visibility" with ${stateBeforePanel} when it ran ends hidden, with the editor on its file`, JSON.stringify(afterPanel));
      await b.shot("GP4-terminal.png");
      for (let i = 0; i < 3; i++) await run("View: Toggle Panel Visibility");
      check(barsHidden(await b.ev(BARS_NOW)), "E8 terminal: ...and three more runs of it end hidden too");
    }
    b.close();

    // The Code tab's default: the vault folder is trusted (the trust seed), so no dialog is up and the chord is the route. Whether a
    // terminal actually started and holds the keyboard focus is MEASURED here, not assumed: on some builds "Create New Terminal"
    // left no .terminal-wrapper at all (the coder's PR-3 log printed "terminal rows 0"). Each line below says what the terminal was
    // when it ran, so a pass with no terminal is never read as a pass with a focused one.
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
      const termAtStart = await termState(tb);
      console.log(`[gp4-term-trusted] terminal state after Create New Terminal: ${termAtStart}${termAtStart === "terminal row, focused" ? "" : " (the focus-in-terminal path is NOT exercised on this run)"}`);
      console.log(`[gp4-term-trusted] after Create New Terminal: dialog up ${await tb.ev("!!document.querySelector('.monaco-dialog-modal-block')")}, terminal rows ${await tb.ev("document.querySelectorAll('.terminal-wrapper').length")}, seen ${(await seenNow(tb)).join(",") || "nothing"}`);
      check(barsHidden(created) && created.editors === 1, "E8 terminal (trusted folder): \"Terminal: Create New Terminal\" ends hidden, with the editor on its file", JSON.stringify(created));
      for (let i = 0; i < 3; i++) {
        const before = await termState(tb);
        await run("View: Toggle Panel Visibility");
        const r = await tb.ev(BARS_NOW);
        check(barsHidden(r) && r.editors === 1, `E8 terminal (trusted folder): "View: Toggle Panel Visibility", run ${i + 1}, with ${before} when it ran, ends hidden`, JSON.stringify(r));
      }
      await tb.shot("GP4-terminal-trusted.png");
      console.log(`[gp4-term-trusted] focus-in-terminal path ${termAtStart === "terminal row, focused" ? "exercised on this run" : `NOT exercised on this run (terminal was: ${termAtStart})`}`);
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


// =====================================================================================================
// PR-4: a file opened from inside the editor becomes a tab of its own (GP2, GP3, E2, E3, E4, E7)
// =====================================================================================================
pr4: {
  if (process.env.SKIP_PR4 === "1") break pr4;
  // Fixtures: pd.js imports a helper in the vault and a module outside it; a note; the helper is short so a bad line has a last line.
  const PD = ['import { helper } from "./helper.js";', 'import { ext } from "../outside/ext.js";', ...Array.from({ length: 77 }, (_, i) => `// filler ${i + 3}`), "helper(1);", "ext(2);", ""].join("\n");
  const HELPER = ["// helper", "", "", "", "export function helper(n) {", "  return n + 1;", "}", ""].join("\n");
  fs.writeFileSync(path.join(vault, "pd.js"), PD);
  fs.writeFileSync(path.join(vault, "helper.js"), HELPER);
  fs.writeFileSync(path.join(vault, "note.md"), "# A note\n\nSome text.\n");
  fs.mkdirSync(path.join(work, "outside"), { recursive: true });
  fs.writeFileSync(path.join(work, "outside", "ext.js"), "export function ext(n) {\n  return n * 2;\n}\n");
  const HELPER_LINES = HELPER.split("\n").length; // 8: the empty last line counts, as Go to Line counts it
  const authority = (srv) => `127.0.0.1:${srv.port}`;
  const NONCE = "pr4-check-nonce";

  const state = `(() => {
    const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const eds = [...document.querySelectorAll('.part.editor .monaco-editor[data-uri]')].filter(shown);
    const active = document.querySelector('.part.editor .monaco-editor .line-numbers.active-line-number');
    const nums = [...document.querySelectorAll('.part.editor .monaco-editor .margin-view-overlays .line-numbers')].map((e) => Number(e.textContent)).filter(Boolean);
    return { uris: eds.map((e) => e.getAttribute('data-uri')), line: active ? Number(active.textContent) : null, firstVisible: nums.length ? Math.min(...nums) : null, groups: [...document.querySelectorAll('.part.editor .editor-group-container')].filter(shown).length, tabstrip: [...document.querySelectorAll('.tabs-and-actions-container')].some(shown) };
  })()`;
  // Records (for the whole page life) that the VS Code tab strip was ever laid out, or two files were ever on screen at once.
  const TAB_RECORDER = `(() => { window.__tabstripSeen = false; const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    new MutationObserver(() => { if ([...document.querySelectorAll('.tabs-and-actions-container')].some(shown)) window.__tabstripSeen = true; }).observe(document.documentElement, { subtree: true, attributes: true, childList: true, attributeFilter: ['class', 'style'] }); return 'recording'; })()`;
  const reportsOf = (b) => b.consoleLog.map((m) => parseOpenReport(m, NONCE)).filter(Boolean);
  const waitFor = async (what, fn, seconds = 20) => { for (let i = 0; i < seconds * 4; i++) { const v = await fn(); if (v) return v; await sleep(0.25); } return null; };
  // The textarea of the editor on screen (an editor kept open behind it, such as a file with unsaved edits, is not laid out).
  const focusEditor = (b) => b.ev("(() => { const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }; [...document.querySelectorAll('.monaco-editor textarea.inputarea')].find(shown)?.focus(); })()");
  const endsWith = (uri, name) => typeof uri === "string" && decodeURIComponent(uri).endsWith(`/${name}`);
  // Go to Definition with the cursor where it is. The language features load a moment after the editor (the first ask can find no
  // definition yet), so ask again, alternating F12 and the palette command, until a new report arrives.
  const definition = async (b, seen) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      await focusEditor(b);
      if (attempt % 2 === 0) await b.key("F12", "F12", 123);
      else {
        await b.key("p", "KeyP", 80, b.META | 8); await sleep(1.2);
        await b.send("Input.insertText", { text: "Go to Definition" }); await sleep(1.2);
        await b.key("Enter", "Enter", 13);
      }
      const report = await waitFor("report", () => reportsOf(b)[seen], 6);
      if (report) return report;
      const st = await b.ev(state);
      if (process.env.PR4_DEBUG) console.log(`[definition] dbg ${await b.ev("window.__dbg()")} console ${JSON.stringify(b.consoleLog.filter((m) => m.includes("vscw")))}`);
      console.log(`[definition] attempt ${attempt + 1} gave no report; state ${JSON.stringify(st)}; toasts ${JSON.stringify((await pageState(b)).toasts)}`);
      await escape(b); await sleep(0.5);
    }
    return null;
  };
  const target = (srv, report) => pluginPaths.targetOfUri(report.uri, authority(srv), vault);

  const srv = await startServer("pr4", false, { "files.autoSave": "off" });
  const shotName = (n) => `PR-4-${n}.png`;

  // --- the tab: pd.js loaded the way the Code tab loads it.
  {
    const b = await browser("pr4", srv, { hide: true, flash: false, file: "pd.js", intercept: NONCE, trust: true });
    await b.ev(TAB_RECORDER);
    const first = await waitFor("pd.js", async () => { const st = await b.ev(state); return endsWith(st?.uris?.[0], "pd.js") ? st : null; });
    if (!first) notRendered("PR-4");
    else {
      await sleep(2);
      check(first.uris.length === 1 && first.groups === 1 && !first.tabstrip, "GP2/E7: the tab shows pd.js alone, in one editor group, with no VS Code tab strip", JSON.stringify(first));
      check(reportsOf(b).length === 0, "Added: the file the tab was loaded with is not reported by the intercept (no second tab for itself)", JSON.stringify(b.consoleLog.slice(-3)));
      await b.shot(shotName("1-start"));

      // GP3 line placement into the first tab: go to the call of the imported name.
      check((await b.ev(buildGoToLineScript(80))) === GO_TO_LINE_DONE, "GP3: the go-to-line script moves the cursor of a loaded tab");
      await sleep(1);
      const placed = await b.ev(state);
      check(placed?.line === 80, "GP3: ...to the line asked for", `line ${placed?.line}`);
      check(reportsOf(b).length === 0, "Added: a cursor that moves inside the tab's own file is not reported");
      const before = placed;

      // Go to Definition on the imported name (F12): reported once, with the definition's file and line.
      const r1 = await definition(b, 0);
      check(!!r1 && endsWith(r1.uri, "helper.js"), "GP3: Go to Definition on an imported name reports the target file", JSON.stringify(r1));
      check(r1?.line === 5, "GP3: ...at the definition's line", `line ${r1?.line}`);
      const t1 = r1 && target(srv, r1);
      check(t1?.kind === "vault" && t1.file === "helper.js", "GP3: ...which the plugin maps to the vault file helper.js", JSON.stringify(t1));
      check(JSON.stringify(t1 && planEditorOpen(t1)) === JSON.stringify({ action: "code", file: "helper.js" }), "GP3: ...and plans a Code tab for it", JSON.stringify(t1 && planEditorOpen(t1)));
      await b.shot(shotName("2-definition-before-restore"));

      // The tab puts the opened editor away: the first tab shows pd.js again at its own cursor and scroll.
      check((await b.ev(RESTORE_OPEN_SCRIPT)) === "pressed", "GP3: the tab puts the opened editor away with the close-editor chord");
      const back = await waitFor("pd.js back", async () => { const st = await b.ev(state); return st?.uris?.length === 1 && endsWith(st.uris[0], "pd.js") ? st : null; });
      check(!!back, "GP2: the first tab shows pd.js alone again (VS Code did not switch the tab to the other file)", JSON.stringify(back));
      await sleep(1);
      const after = await b.ev(state);
      check(after?.line === before.line && after?.firstVisible === before.firstVisible, "GP3: the first tab's cursor and scroll are where they were", `before line ${before.line} top ${before.firstVisible}; after line ${after?.line} top ${after?.firstVisible}`);
      await b.shot(shotName("3-first-tab-after"));

      // E3: the same definition again is reported again (the plugin then focuses the tab it already has).
      const r2 = await definition(b, 1);
      check(!!r2 && endsWith(r2.uri, "helper.js") && r2.line === 5, "E3: the same Go to Definition again is reported again, same file and line", JSON.stringify(r2));
      await b.ev(RESTORE_OPEN_SCRIPT); await sleep(1.5);

      // E2: a definition outside the vault.
      await b.ev(buildGoToLineScript(81)); await sleep(1);
      const r3 = await definition(b, 2);
      const t3 = r3 && target(srv, r3);
      check(t3?.kind === "outside" && t3.path === path.join(work, "outside", "ext.js"), "E2: Go to Definition into a file outside the vault is reported as outside, by its path", JSON.stringify(t3));
      check(JSON.stringify(t3 && planEditorOpen(t3)) === JSON.stringify({ action: "outside", name: "ext.js" }), "E2: ...and the plan is a notice naming it, no tab", JSON.stringify(t3 && planEditorOpen(t3)));
      await b.shot(shotName("4-outside"));
      await b.ev(RESTORE_OPEN_SCRIPT); await sleep(1.5);

      // GP3 quick open: Cmd+P and a file; E2: a note.
      const quick = async (name) => {
        await focusEditor(b);
        await b.key("p", "KeyP", 80, b.META); await sleep(1.5);
        await b.send("Input.insertText", { text: name }); await sleep(1.5);
        await b.key("Enter", "Enter", 13);
      };
      const n0 = reportsOf(b).length;
      await quick("helper.js");
      const r4 = await waitFor("quick open report", () => reportsOf(b)[n0]);
      check(!!r4 && endsWith(r4.uri, "helper.js"), "GP3: choosing a file in Cmd+P quick open is reported as an open from the editor", JSON.stringify(r4));
      await b.shot(shotName("5-quick-open"));
      await b.ev(RESTORE_OPEN_SCRIPT);
      check(!!(await waitFor("pd.js after quick open", async () => { const st = await b.ev(state); return st?.uris?.length === 1 && endsWith(st.uris[0], "pd.js"); })), "GP3: ...and the tab shows its own file again after it is put away");
      const n1 = reportsOf(b).length;
      await quick("note.md");
      const r5 = await waitFor("note report", () => reportsOf(b)[n1]);
      const t5 = r5 && target(srv, r5);
      check(t5?.kind === "vault" && t5.file === "note.md" && JSON.stringify(planEditorOpen(t5)) === JSON.stringify({ action: "obsidian", file: "note.md" }), "E2: a note chosen in quick open is reported as a vault file that Obsidian opens in its own view", JSON.stringify(t5 && planEditorOpen(t5)));
      await b.ev(RESTORE_OPEN_SCRIPT); await sleep(1.5);

      // T1: the file opened from the editor already holds unsaved edits in this tab, so VS Code answers the close with its save prompt.
      // The page cancels the prompt (never saves or discards) and shows the previous editor, so the tab shows pd.js and not helper.js.
      const n2 = reportsOf(b).length;
      await quick("helper.js");
      const r6 = await waitFor("helper report for the edit", () => reportsOf(b)[n2]);
      check(!!r6 && endsWith(r6.uri, "helper.js"), "T1: helper.js is open in the tab to be edited", JSON.stringify(r6));
      await sleep(1);
      await b.ev(buildGoToLineScript(1)); await sleep(1); // line 1 is a comment: the edit leaves `helper` exported, so Go to Definition below still finds it
      await b.send("Input.insertText", { text: "// EDITED " });
      await sleep(1);
      check((await b.ev(DIRTY_SCRIPT)) === true, "T1: ...and it holds unsaved edits (the window title shows the dirty mark)");
      const n3 = reportsOf(b).length;
      check((await b.ev(RESTORE_OPEN_SCRIPT)) === "switched", "T1: putting away an opened file with unsaved edits cancels the save prompt and shows the previous editor");
      const own1 = await waitFor("pd.js after the prompt", async () => { const st = await b.ev(state); return st?.uris?.length === 1 && endsWith(st.uris[0], "pd.js") ? st : null; });
      check(!!own1, "T1: the tab shows pd.js alone again, not helper.js (no in-place navigation)", JSON.stringify(own1));
      await sleep(1.5);
      check((await b.ev(state))?.uris?.length === 1, "T1: ...and it stays alone, with the edited helper.js not on screen", JSON.stringify(await b.ev(state)));
      check(!(await pageState(b)).dialogs?.length, "T1: ...and no save prompt is left on screen", JSON.stringify((await pageState(b)).dialogs));
      // The same Go to Definition again, with the dirty helper.js still open behind: reported again, put away the same way.
      await b.ev(buildGoToLineScript(80)); await sleep(1);
      const r7 = await definition(b, n3);
      check(!!r7 && endsWith(r7.uri, "helper.js") && r7.line !== null, "T1: Go to Definition into the file with unsaved edits is reported again", JSON.stringify(r7));
      check((await b.ev(RESTORE_OPEN_SCRIPT)) === "switched", "T1: ...and put away the same way a second time");
      check(!!(await waitFor("pd.js again", async () => { const st = await b.ev(state); return st?.uris?.length === 1 && endsWith(st.uris[0], "pd.js"); })), "T1: ...the tab shows pd.js alone");
      // The edits were kept: reaching helper.js again shows them, and nothing was written to disk.
      const n4 = reportsOf(b).length;
      await quick("helper.js");
      await waitFor("helper report again", () => reportsOf(b)[n4]);
      await sleep(1);
      check((await pageState(b)).text.includes("EDITED"), "T1: the unsaved edits are still in the tab's helper.js buffer");
      check(fs.readFileSync(path.join(vault, "helper.js"), "utf8") === HELPER, "T1: ...and the file on disk is untouched (the prompt was cancelled, not answered with Save)");
      // Put the buffer back as it was (revert), so the steps below see a clean helper.js, then put the editor away.
      await b.key("p", "KeyP", 80, b.META | 8); await sleep(1.2);
      await b.send("Input.insertText", { text: "File: Revert File" }); await sleep(1.2);
      await b.key("Enter", "Enter", 13); await sleep(1.5);
      check((await b.ev(RESTORE_OPEN_SCRIPT)) === "pressed", "T1: once the edits are reverted, the opened file is closed as before");
      check(!!(await waitFor("pd.js after revert", async () => { const st = await b.ev(state); return st?.uris?.length === 1 && endsWith(st.uris[0], "pd.js"); })), "T1: ...and the tab shows pd.js alone");

      check((await b.ev("window.__tabstripSeen")) === false, "E7: the VS Code tab strip was never laid out, through all of the above (no patching of VS Code internals was needed)");
      const end = await b.ev(state);
      check(end?.uris?.length === 1 && endsWith(end.uris[0], "pd.js") && !end.tabstrip, "GP2: the tab ends with the one file it started with", JSON.stringify(end));

      // E4: Split Editor from the palette is undone by the script (a control without the script follows below).
      await focusEditor(b);
      await b.key("p", "KeyP", 80, b.META | 8); await sleep(1.2);
      await b.send("Input.insertText", { text: "View: Split Editor Right" }); await sleep(1.2);
      await b.key("Enter", "Enter", 13);
      await sleep(4);
      const split = await b.ev(state);
      check(split?.groups === 1, "E4: Split Editor from the palette leaves one editor group in the tab", JSON.stringify(split));
      await b.shot(shotName("6-split"));
    }
    b.close();
  }

  // --- E4 control: without the tab's script, the same palette command does split (so the line above is the script's doing).
  {
    const b = await browser("pr4-ctl", srv, { hide: true, flash: false, file: "pd.js" });
    const ok = await waitFor("pd.js", async () => endsWith((await b.ev(state))?.uris?.[0], "pd.js"));
    if (!ok) notRendered("PR-4 control");
    else {
      await sleep(2);
      await focusEditor(b);
      await b.key("p", "KeyP", 80, b.META | 8); await sleep(1.2);
      await b.send("Input.insertText", { text: "View: Split Editor Right" }); await sleep(1.2);
      await b.key("Enter", "Enter", 13);
      await sleep(4);
      const st = await b.ev(state);
      check(st?.groups === 2, "E4 control: without the script the palette's Split Editor does split (two groups)", JSON.stringify(st));
      await b.shot(shotName("6-split-control"));
    }
    b.close();
  }

  // --- GP3 line placement into a tab opened for a file, and bad lines.
  {
    const b = await browser("pr4-line", srv, { hide: true, flash: false, file: "helper.js" });
    const ok = await waitFor("helper.js", async () => endsWith((await b.ev(state))?.uris?.[0], "helper.js"));
    if (!ok) notRendered("PR-4 line");
    else {
      await sleep(2);
      for (const [asked, expected, why] of [[5, 5, "the definition's line"], [0, 1, "zero is line 1"], [-3, 1, "negative is line 1"], ["abc", 1, "non-numeric is line 1"], [99999, HELPER_LINES, "past the end is the last line"], [3, 3, "a line in the middle"]]) {
        check((await b.ev(buildGoToLineScript(asked))) === GO_TO_LINE_DONE, `GP3: the script runs for line ${JSON.stringify(asked)}`);
        await sleep(1);
        const st = await b.ev(state);
        check(st?.line === expected, `GP3: line ${JSON.stringify(asked)} puts the cursor on line ${expected} (${why}), never an error`, `line ${st?.line}`);
      }
      await b.shot(shotName("7-line"));
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
