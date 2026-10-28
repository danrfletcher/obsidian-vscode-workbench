/**
 * Render check for the offline notices (checklist C38, "readable and not clipped").
 *
 * Not part of `npm test`: it needs Obsidian.app (for its own app.css) and Google Chrome. It builds the two
 * offline failure Notices (describeFailure), the "use the last downloaded server" modal (promptReuseBuild) and
 * the unsaved-changes prompts of the Code tabs (close, quit, restart; checklist C32) into the DOM Obsidian builds, applies Obsidian's real app.css, loads each in headless Chrome at several
 * window sizes in light and dark themes, and measures every text line against the window and against each
 * clipping ancestor. It exits 1 if anything is cut off or outside the window, and writes a screenshot of
 * each case.
 *
 *   node tests/render/run.mjs [outDir]
 *
 * Env: OBSIDIAN_ASAR, CHROME (paths), if the defaults below are wrong on this machine.
 */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "render-check-")));
const ASAR = process.env.OBSIDIAN_ASAR ?? "/Applications/Obsidian.app/Contents/Resources/obsidian.asar";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
for (const f of [ASAR, CHROME]) {
  if (!fs.existsSync(f)) {
    console.error(`render check needs ${f}`);
    process.exit(2);
  }
}
fs.mkdirSync(outDir, { recursive: true });

/** Read one file out of an asar archive (8-byte pickle header, JSON index, then the file data). */
function readAsar(file, name) {
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const size = head.readUInt32LE(12);
  const index = Buffer.alloc(size);
  fs.readSync(fd, index, 0, size, 16);
  const entry = JSON.parse(index.toString()).files[name];
  const data = Buffer.alloc(Number(entry.size));
  fs.readSync(fd, data, 0, data.length, 16 + size + Number(entry.offset));
  fs.closeSync(fd);
  return data;
}

// The plugin's own code: the modal runs in the page; the Notice text comes from describeFailure in node.
await build({
  entryPoints: [path.join(root, "tests/render/entry.mjs")],
  bundle: true,
  format: "iife",
  globalName: "render",
  platform: "browser",
  alias: { obsidian: path.join(root, "tests/render/obsidian-shim.mjs") },
  outfile: path.join(outDir, "entry.js"),
  logLevel: "error",
});
await build({
  entryPoints: [path.join(root, "tests/render/messages.mjs")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: path.join(outDir, "messages.mjs"),
  logLevel: "error",
});
const { describeFailure, ServerStartError, findMirroredProfile, describeExtensionsSection, SPIKE_RESULT } = await import(pathToFileURL(path.join(outDir, "messages.mjs")).href);
const { PROFILES, vscodeFolderUri, writeUserData } = await import(pathToFileURL(path.join(root, "tests/fixtures/make-fake-user-data.mjs")).href);

fs.writeFileSync(path.join(outDir, "app.css"), readAsar(ASAR, "app.css"));
fs.copyFileSync(path.join(root, "styles.css"), path.join(outDir, "plugin.css"));

// The Profile row of the Extensions section, from the real lookup against generated user-data folders.
const SPACE_VAULT = "/Users/x/My Vault/Café Ünï";
function profileScenario(name, vaultPath, associations) {
  const userDataRoot = writeUserData(path.join(fs.mkdtempSync(path.join(outDir, "userdata-")), "Code - Insiders"), { associations });
  const profile = findMirroredProfile({ userDataRoot, vaultPath });
  const state = { status: "resolved", profile };
  const port = { stored: 51789, current: 51789, note: null };
  return { name, kind: "settings-section", view: describeExtensionsSection(SPIKE_RESULT, port, state) };
}
const notRead = { name: "profile-not-read", kind: "settings-section", view: describeExtensionsSection(SPIKE_RESULT, { stored: 51789, current: 51789, note: null }, { status: "not-read" }) };
const profileScenarios = [
  notRead,
  profileScenario("profile-default", SPACE_VAULT, { [vscodeFolderUri(SPACE_VAULT)]: "__default__profile__" }),
  profileScenario("profile-fde-practice", SPACE_VAULT, { [vscodeFolderUri(SPACE_VAULT)]: PROFILES.custom.location }),
  profileScenario("profile-unknown", SPACE_VAULT, { [vscodeFolderUri(SPACE_VAULT)]: "ffff0000" }),
  profileScenario("profile-deleted-folder", SPACE_VAULT, { [vscodeFolderUri(SPACE_VAULT)]: PROFILES.deleted.location }),
  profileScenario("profile-no-association-accents", SPACE_VAULT, {}),
];

// The download failure the way the CLI logs it.
const DNS =
  "Error downloading server: error sending request for url (https://update.example/): error trying to connect: dns error: failed to lookup address information";
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const offline = (ctx) => describeFailure(new ServerStartError("x", 1, DNS, { kind: "exit" }), ctx);
const firstRun = offline({ installedVersion: "1.144.2", installedCommit: NEW, lastServer: null });
const redownload = offline({ installedVersion: "1.145.0", installedCommit: NEW, lastServer: { commit: OLD, version: "1.144.2" }, lastServerCached: true });
if (firstRun.kind !== "offline-first-run" || redownload.kind !== "offline-redownload") {
  console.error(`unexpected failure kinds: ${firstRun.kind}, ${redownload.kind}`);
  process.exit(1);
}

const scenarios = [
  { name: "first-run-notice", kind: "notice", message: firstRun.message },
  { name: "redownload-notice", kind: "notice", message: redownload.message },
  { name: "reuse-offer-modal", kind: "modal", change: redownload.versionChange },
  // The unsaved-changes prompts of the Code tabs (G2, E13, GP7 checkpoint 2), each with a long file name or
  // list so the text has to wrap.
  { name: "close-dirty-modal", kind: "modal", prompt: "close-dirty", request: { file: "estimate_time.py", state: "dirty" } },
  { name: "close-dirty-long-name-modal", kind: "modal", prompt: "close-dirty", request: { file: "scripts/a_very_long_directory_name/with/several/levels/and_a_rather_long_file_name_for_the_editor.py", state: "dirty" } },
  { name: "close-dirty-retry-modal", kind: "modal", prompt: "close-dirty", request: { file: "estimate_time.py", state: "dirty", failed: true } },
  { name: "close-unreadable-modal", kind: "modal", prompt: "close-dirty", request: { file: "estimate_time.py", state: "unreadable" } },
  { name: "quit-save-or-discard-modal", kind: "modal", prompt: "quit-save-or-discard", files: ["a.py", "b.ts", "Makefile", "scripts/estimate_time.py", "notes/ünï.ts", "seventh.rs"] },
  { name: "quit-save-failed-modal", kind: "modal", prompt: "quit-save-failed", files: ["Untitled-1", "scripts/estimate_time.py"] },
  { name: "restart-with-dirty-modal", kind: "modal", prompt: "restart-with-dirty", files: ["a.py", "scripts/estimate_time.py"] },
  // The Profile row of the settings Extensions section (PR-3: G7, G8, E2, E10), drawn with the plugin's styles.css.
  ...profileScenarios,
];
const windows = [
  [1280, 800],
  [900, 600],
  [600, 700],
  [500, 700],
];
const themes = ["theme-light", "theme-dark"];

const chrome = (args) =>
  spawnSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${path.join(outDir, "profile")}`, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60000,
  });

let failed = 0;
for (const sc of scenarios) {
  for (const [w, h] of windows) {
    for (const theme of themes) {
      const id = `${sc.name}-${w}x${h}-${theme}`;
      const page = path.join(outDir, `${id}.html`);
      fs.writeFileSync(
        page,
        `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="app.css">${sc.kind === "settings-section" ? '<link rel="stylesheet" href="plugin.css">' : ""}</head>` +
          `<body class="${theme} is-frameless mod-macos"><pre id="result" style="display:none"></pre>` +
          `<script src="entry.js"></script>` +
          `<script>render.run(${JSON.stringify(sc)}).then(r => { document.getElementById("result").textContent = JSON.stringify(r); }, e => { document.getElementById("result").textContent = JSON.stringify({ ok: false, error: String(e) }); });</script>` +
          `</body></html>`,
      );
      const size = `--window-size=${w},${h}`;
      const dom = chrome([size, "--virtual-time-budget=2000", "--dump-dom", pathToFileURL(page).href]);
      const m = /<pre id="result"[^>]*>([\s\S]*?)<\/pre>/.exec(dom.stdout ?? "");
      let r;
      try {
        r = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
      } catch {
        r = { ok: false, error: `no result from Chrome (status ${dom.status}): ${(dom.stderr ?? "").slice(0, 300)}` };
      }
      chrome([size, "--virtual-time-budget=2000", `--screenshot=${path.join(outDir, `${id}.png`)}`, pathToFileURL(page).href]);
      const lines = (r.results ?? []).map((x) => `${x.label} ${x.box} ${x.textLines} lines`).join("; ");
      console.log(`${r.ok ? "ok  " : "FAIL"} ${id} (window ${r.window ?? "?"}) ${lines}${r.buttons ? ` buttons: ${r.buttons.join(" | ")}` : ""}${r.profileRow ? ` profile row: ${r.profileRow}` : ""}`);
      for (const x of r.results ?? []) for (const p of x.problems) console.log(`       ${p}`);
      if (r.error) console.log(`       ${r.error}`);
      if (!r.ok) failed++;
    }
  }
}
console.log(failed ? `${failed} case(s) cut off or outside the window` : "all cases fit: nothing clipped or outside the window");
console.log(`output: ${outDir}`);
process.exit(failed ? 1 : 0);
