/**
 * Render check for the terminal drawer's bottom edge (PR-3: GP1, G1, G3, G4 and the "no stuck hover" part of C7/C28).
 *
 * Not part of `npm test`: it needs Google Chrome. It bundles the plugin's own TerminalDrawer (with a stand-in for the host
 * page, which is a plain box) and the plugin's own src/styles.css into a page that has the three Obsidian splits (left
 * sidebar, main pane area, right sidebar), loads it in headless Chrome, and drives it with real mouse events through the
 * DevTools protocol (Input.dispatchMouseEvent: a real hover, a real press, move and release). What it judges it reads off
 * the screenshots, pixel by pixel, not off the DOM alone: the colour of the edge, and which box covers which pixel.
 *
 *   node tests/render/bottom-edge-check.mjs [outDir]
 *
 * Env: CHROME (path), if the default below is wrong on this machine. Exits 1 if any check fails; screenshots go to outDir.
 * Chrome runs on a port the OS picks, and only the Chrome this script started is stopped.
 */
import { build } from "esbuild";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!fs.existsSync(CHROME)) {
  console.error(`bottom-edge check needs ${CHROME}`);
  process.exit(2);
}
const work = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "bottom-edge-check-"));
const outDir = path.resolve(process.argv[2] ?? path.join(work, "shots"));
fs.mkdirSync(outDir, { recursive: true });

const W = 1024;
const H = 740;
const ACCENT = [0x1d, 0x6f, 0xe0];
const BORDER = [0x55, 0x55, 0x55];
const SIDE = [0x30, 0x40, 0x30];
const MAIN = [0x25, 0x25, 0x38];
const HOST = [0x80, 0x20, 0x20];
const hex = (c) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");

// --- the page: the plugin's TerminalDrawer and stylesheet over Obsidian's three splits ---------------------------------
fs.writeFileSync(
  path.join(work, "entry.ts"),
  `import { TerminalDrawer } from ${JSON.stringify(path.join(root, "src/terminal/terminal-drawer.ts"))};
const w = window as any;
w.saved = [] as number[];
w.kind = "markdown";
const host = document.querySelector(".vscode-workbench-terminal-host") as HTMLElement;
w.drawer = new TerminalDrawer({
  document, window,
  host: () => ({ show: () => { host.style.visibility = "visible"; }, hide: () => { host.style.visibility = "hidden"; }, focusTerminal: () => {}, view: () => "running" }),
  initialHeight: 300,
  saveHeight: (h: number) => w.saved.push(h),
  viewKind: () => w.kind,
  nonCodeDrawer: () => true,
  focus: { remember: () => {}, restore: () => {} } as any,
});
w.drawer.mount();
`,
);
await build({ entryPoints: [path.join(work, "entry.ts")], bundle: true, format: "iife", platform: "browser", outfile: path.join(work, "entry.js"), logLevel: "error" });
fs.writeFileSync(
  path.join(work, "page.html"),
  `<!doctype html><html><head><meta charset="utf-8"><style>
:root { --interactive-accent: ${hex(ACCENT)}; --background-modifier-border: ${hex(BORDER)}; --background-primary: ${hex(MAIN)}; --layer-status-bar: 20; }
html, body { margin: 0; height: 100%; overflow: hidden; background: #000; }
body { display: flex; }
.workspace-split { box-sizing: border-box; }
.mod-left-split, .mod-right-split { width: 260px; background: ${hex(SIDE)}; }
.mod-root { flex: 1; background: ${hex(MAIN)}; }
body .vscode-workbench-terminal-host { visibility: hidden; background: ${hex(HOST)}; }
</style><style>${fs.readFileSync(path.join(root, "src/styles.css"), "utf8")}</style></head><body>
<div class="workspace-split mod-left-split"></div>
<div class="workspace-split mod-root"><div class="workspace-leaf-content" data-type="markdown"></div></div>
<div class="workspace-split mod-right-split"></div>
<div class="vscode-workbench-terminal-host"></div>
<script src="entry.js"></script></body></html>`,
);

// --- Chrome over the DevTools protocol (a port the OS picks; only this Chrome is stopped) --------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on("error", reject);
});
const cdpPort = await freePort();
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${path.join(work, "chrome")}`, "--no-first-run", "--disable-background-networking", "about:blank"], { stdio: "ignore" });
console.log(`Chrome pid ${chrome.pid}, DevTools port ${cdpPort}`);
const stop = () => { try { process.kill(chrome.pid, "SIGKILL"); } catch { /* gone */ } };
process.on("exit", stop);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

let ver = null;
for (let i = 0; i < 60 && !ver; i++) { ver = await fetch(`http://127.0.0.1:${cdpPort}/json/version`).then((r) => r.json(), () => null); if (!ver) await sleep(500); }
if (!ver) { console.error("Chrome's debugging port never came up"); process.exit(2); }
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let nextId = 0;
const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) pending.get(d.id)(d); };
const send = (method, params = {}, sessionId) => new Promise((res) => { const id = ++nextId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
const { targetId } = (await send("Target.createTarget", { url: "about:blank" })).result;
const sessionId = (await send("Target.attachToTarget", { targetId, flatten: true })).result.sessionId;
const p = (method, params) => send(method, params, sessionId);
await p("Page.enable");
await p("Runtime.enable");
await p("Emulation.setFocusEmulationEnabled", { enabled: true });
await p("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await p("Page.navigate", { url: "file://" + path.join(work, "page.html") });
const ev = async (expression) => {
  const r = (await p("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result;
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate failed");
  return r?.result?.value;
};
for (let i = 0; i < 40 && (await ev("typeof drawer")) !== "object"; i++) await sleep(250);

// --- real mouse input ------------------------------------------------------------------------------------------------------
let mouse = { x: 0, y: 0 };
const mouseEvent = (type, x, y, buttons) => p("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 }).then(() => { mouse = { x, y }; });
const moveTo = (x, y) => mouseEvent("mouseMoved", x, y, 0);
async function dragTo(x, fromY, toY) {
  await moveTo(x, fromY);
  await mouseEvent("mousePressed", x, fromY, 1);
  const steps = 12;
  for (let i = 1; i <= steps; i++) await mouseEvent("mouseMoved", x, Math.round(fromY + ((toY - fromY) * i) / steps), 1);
  await mouseEvent("mouseReleased", x, toY, 0);
  await sleep(50);
}
async function click(x, y) {
  await moveTo(x, y);
  await mouseEvent("mousePressed", x, y, 1);
  await mouseEvent("mouseReleased", x, y, 0);
  await sleep(50);
}

// --- pixels: decode a screenshot -------------------------------------------------------------------------------------------
function decodePng(buf) {
  let pos = 8, width = 0, height = 0, bpp = 4;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString("ascii", pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bpp = data[9] === 6 ? 4 : 3; if (data[8] !== 8 || (data[9] !== 6 && data[9] !== 2)) throw new Error("unsupported PNG"); }
    if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const a = i >= bpp ? px[y * stride + i - bpp] : 0, b = y ? px[(y - 1) * stride + i] : 0, c = i >= bpp && y ? px[(y - 1) * stride + i - bpp] : 0;
      let v;
      if (f === 0) v = x; else if (f === 1) v = x + a; else if (f === 2) v = x + b; else if (f === 3) v = x + ((a + b) >> 1);
      else { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      px[y * stride + i] = v & 255;
    }
  }
  return { width, height, at: (x, y) => [px[y * stride + x * bpp], px[y * stride + x * bpp + 1], px[y * stride + x * bpp + 2]] };
}
async function shot(name) {
  const s = await p("Page.captureScreenshot", { format: "png" });
  const buf = Buffer.from(s.result.data, "base64");
  const file = path.join(outDir, name + ".png");
  fs.writeFileSync(file, buf);
  console.log(`  screenshot ${file}`);
  return decodePng(buf);
}
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 3);
const rect = (sel) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; })()`);
const state = () => ev(`({ open: drawer.isOpen, height: drawer.currentHeight, cssOpen: document.body.style.getPropertyValue("--vscw-open-height"), dragging: document.body.classList.contains("vscw-terminal-dragging") })`);

let failures = 0;
const check = (id, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"} ${id}: ${detail}`); if (!ok) failures++; };
/** The colours on the four rows of the edge (the closed edge sits on the bottom 4 px), at column x. */
const edgeRows = (img, x) => [H - 4, H - 3, H - 2, H - 1].map((y) => img.at(x, y));

try {
  // GP1 / C7 / C28: hover turns the edge accent blue; moving away puts it back (a real mouse, read from the pixels).
  await moveTo(500, 300);
  let img = await shot("gp1-1-idle");
  let rows = edgeRows(img, 500);
  check("GP1 idle", !rows.some((c) => near(c, ACCENT)) && rows.some((c) => near(c, BORDER)), `rows at the bottom: ${rows.map(hex).join(" ")} (accent ${hex(ACCENT)}, idle line ${hex(BORDER)})`);
  await moveTo(500, H - 2);
  img = await shot("gp1-2-hover");
  rows = edgeRows(img, 500);
  check("GP1 hover is blue", rows.every((c) => near(c, ACCENT)), `rows: ${rows.map(hex).join(" ")}; edge matches :hover = ${await ev(`document.querySelector(".vscw-edge").matches(":hover")`)}`);
  await moveTo(500, 300);
  img = await shot("gp1-3-away");
  rows = edgeRows(img, 500);
  check("GP1 away returns to idle", !rows.some((c) => near(c, ACCENT)) && rows.some((c) => near(c, BORDER)) && (await ev(`document.querySelector(".vscw-edge").matches(":hover")`)) === false, `rows: ${rows.map(hex).join(" ")}; edge matches :hover = ${await ev(`document.querySelector(".vscw-edge").matches(":hover")`)}`);
  // The same after a click and after a drag (pointer capture must not leave the edge looking hovered once the pointer is gone).
  await click(500, H - 2);
  await moveTo(500, 200);
  await click(500, H - 300);
  await moveTo(500, 150);
  check("GP1 not stuck after click open/close", (await ev(`document.querySelector(".vscw-edge").matches(":hover")`)) === false && !(await state()).open, `state ${JSON.stringify(await state())}`);

  // G1 / C29: drag the edge up about 300 px from closed: the drawer opens at that height under the pointer.
  await dragTo(500, H - 2, H - 2 - 300);
  let s = await state();
  let host = await rect(".vscode-workbench-terminal-host");
  img = await shot("g1-drag-open-300");
  check("G1 drag opens", s.open && s.height === 300 && Math.round(host.height) === 300 && Math.round(host.bottom) === H, `state ${JSON.stringify(s)}; host box ${Math.round(host.left)}..${Math.round(host.right)} x ${Math.round(host.top)}..${Math.round(host.bottom)}`);
  check("G1 drawer shows over the main pane", near(img.at(500, host.top + 50), HOST) && near(img.at(500, host.top - 20), MAIN), `pixel in the drawer ${hex(img.at(500, host.top + 50))}, pixel above it ${hex(img.at(500, host.top - 20))}`);

  // G3 / C30: drag to the top of the window: stops 160 px below it. Drag to the bottom: stops at 120 px. Close and reopen: kept.
  await dragTo(500, host.top, 0);
  s = await state();
  host = await rect(".vscode-workbench-terminal-host");
  await shot("g3-1-top");
  check("G3 top: stops 160 px below the window top", Math.round(host.top) === 160 && s.height === H - 160, `drawer top ${host.top}, height ${s.height}`);
  await dragTo(500, host.top, H - 1);
  s = await state();
  host = await rect(".vscode-workbench-terminal-host");
  await shot("g3-2-bottom");
  check("G3 bottom: stops at 120 px", s.height === 120 && Math.round(host.height) === 120 && s.open, `height ${s.height}, host height ${host.height}`);
  await click(500, host.top);
  s = await state();
  check("G1 click closes", !s.open && s.cssOpen === "0px", `state ${JSON.stringify(s)}`);
  await moveTo(500, 100);
  await click(500, H - 2);
  s = await state();
  host = await rect(".vscode-workbench-terminal-host");
  await shot("g3-3-reopened");
  check("G3 reopen keeps the height", s.open && s.height === 120 && Math.round(host.height) === 120, `state ${JSON.stringify(s)}`);
  check("G3 the heights were saved", (await ev("saved")).includes(120), `saved: ${JSON.stringify(await ev("saved"))}`);

  // G4 / C34: both sidebars open; the drawer spans only the main pane area and the sidebars reach the bottom; over a note and a Code tab.
  for (const kind of ["markdown", "code"]) {
    await ev(`(() => { kind = ${JSON.stringify(kind)}; document.querySelector(".workspace-leaf-content").dataset.type = ${JSON.stringify(kind === "code" ? "vscode-workbench-code" : "markdown")}; drawer.applyVisibility(); })()`);
    if (!(await state()).open) await dragTo(500, H - 2, H - 250); // open by a drag from the closed edge, to 250 px
    s = await state();
    host = await rect(".vscode-workbench-terminal-host");
    const main = await rect(".mod-root"), left = await rect(".mod-left-split"), right = await rect(".mod-right-split");
    img = await shot(`g4-${kind}-sidebars-open`);
    const y = host.top + 40;
    check(`G4 ${kind}: sidebars keep the full height`, Math.round(left.bottom) === H && Math.round(right.bottom) === H, `left ${left.top}..${left.bottom}, right ${right.top}..${right.bottom}`);
    check(`G4 ${kind}: the drawer spans the main pane area only`, Math.round(host.left) === Math.round(main.left) && Math.round(host.width) === Math.round(main.width), `drawer x ${host.left}..${host.right}, main pane x ${main.left}..${main.right}`);
    check(`G4 ${kind}: pixels agree`, near(img.at(500, y), HOST) && near(img.at(100, y), SIDE) && near(img.at(900, y), SIDE) && near(img.at(100, H - 3), SIDE) && near(img.at(900, H - 3), SIDE), `drawer ${hex(img.at(500, y))}, left sidebar at that row ${hex(img.at(100, y))}, right ${hex(img.at(900, y))}, sidebars' last rows ${hex(img.at(100, H - 3))} ${hex(img.at(900, H - 3))}; the edge shows on the ${kind} tab: ${await ev(`getComputedStyle(document.querySelector(".vscw-edge")).display !== "none"`)}`);
    check(`G4 ${kind}: the edge is on the drawer's top`, (await ev(`document.querySelector(".vscw-edge").hidden`)) === false && Math.abs((await rect(".vscw-edge")).bottom - (host.top + 2)) <= 1, `edge ${JSON.stringify(await rect(".vscw-edge"))}`);
    await click(500, host.top);
    check(`G4 ${kind}: closes`, !(await state()).open, `state ${JSON.stringify(await state())}`);
  }
} finally {
  ws.close();
  stop();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
