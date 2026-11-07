/**
 * The page-side scripts and the settings of each route of the chrome spike, shared by chrome-spike-check.mjs (headless Chrome on
 * the Mac) and chrome-spike-pack.mjs (the pack the Obsidian container run measures with). Nothing here starts a process.
 * `OVERLAY` (what the plugin wrote in 0.1.0, the R0 baseline) is not here: it comes from the plugin's own `legacyChromeSettings()`, bundled by the caller.
 */
// --- page-side scripts -------------------------------------------------------------------------------
export const PARTS = {
  sideBar: ".part.sidebar",
  secondarySideBar: ".part.auxiliarybar",
  activityBar: ".part.activitybar",
  statusBar: ".part.statusbar",
  titleBar: ".part.titlebar",
  panel: ".part.panel",
  tabStrip: ".editor-group-container .tabs-and-actions-container",
  breadcrumb: ".editor-group-container .breadcrumbs-control",
};
export const PART_NAMES = Object.keys(PARTS);

// Computed layout of every part: size in px, whether it is shown at all, and how many focusable elements sit inside
// (a part at 0 px that still holds focusable elements is "0px-focusable").
export const MEASURE = `(() => {
  const parts = ${JSON.stringify(PARTS)};
  const FOC = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])';
  const out = { parts: {} };
  for (const [k, s] of Object.entries(parts)) {
    const els = [...document.querySelectorAll(s)];
    const e = els.find((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; }) || els[0];
    if (!e) { out.parts[k] = { present: false, w: 0, h: 0, shown: false, focusable: 0 }; continue; }
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    const shown = r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    out.parts[k] = { present: true, w: Math.round(r.width), h: Math.round(r.height), shown, focusable: e.querySelectorAll(FOC).length };
  }
  const ed = document.querySelector('.part.editor');
  const er = ed ? ed.getBoundingClientRect() : { width: 0, height: 0, left: 0, top: 0 };
  out.editor = { w: Math.round(er.width), h: Math.round(er.height), left: Math.round(er.left), top: Math.round(er.top) };
  out.viewport = { w: innerWidth, h: innerHeight };
  out.title = document.title;
  const wb = document.querySelector('.monaco-workbench');
  out.workbenchClasses = wb ? [...wb.classList].filter((c) => /zen|fullscreen|centered|nosidebar|nopanel|noauxiliarybar|nostatusbar|noactivitybar|notitlebar|nomenubar|mac|web|linux/.test(c)) : [];
  const first = document.querySelector('.monaco-editor .margin-view-overlays .line-numbers');
  out.lineNumbers = !!first;
  out.centered = !!document.querySelector('.monaco-workbench.centered-editor-layout, .part.editor.centered');
  const sc = document.querySelector('.notifications-toasts');
  out.toasts = sc ? [...sc.querySelectorAll('.notification-toast')].map((t) => t.innerText.replace(/\\s+/g, ' ').trim()).filter(Boolean) : [];
  return out;
})()`;

export const READY = `!!document.querySelector('.monaco-editor .view-line') || !!document.querySelector('.monaco-workbench .part.editor .monaco-editor')`;

// Records a frame-by-frame view of which unwanted parts are on screen, from the first script run of the new document.
export const FLASH_RECORDER = `(() => {
  if (window.__flash) return;
  const sel = ${JSON.stringify(PARTS)};
  const f = window.__flash = { t0: performance.now(), frames: [], done: false };
  const shown = (s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const tick = () => {
    const t = Math.round(performance.now() - f.t0);
    const wb = !!document.querySelector('.monaco-workbench');
    const vis = wb ? Object.entries(sel).filter(([, s]) => shown(s)).map(([k]) => k) : [];
    const editor = !!document.querySelector('.monaco-editor .view-line');
    f.frames.push({ t, wb, vis, editor });
    if (!f.done) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setTimeout(() => { f.done = true; }, 25000);
})()`;

// Page script, route "dispatch the close commands": a key chord is bound to each `close` command in the seeded
// keybindings (workbench.action.closeSidebar etc.), and the script presses it only when the part shows.
export const CLOSE_CHORDS = [
  { part: "sideBar", sel: PARTS.sideBar, command: "workbench.action.closeSidebar", key: "1", code: "Digit1", keyCode: 49 },
  { part: "secondarySideBar", sel: PARTS.secondarySideBar, command: "workbench.action.closeAuxiliaryBar", key: "2", code: "Digit2", keyCode: 50 },
  { part: "panel", sel: PARTS.panel, command: "workbench.action.closePanel", key: "3", code: "Digit3", keyCode: 51 },
];
export const PAGE_CLOSE_SCRIPT = (hold) => `(async () => {
  const chords = ${JSON.stringify(CLOSE_CHORDS)};
  const shown = (s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const press = (c) => {
    const o = { key: c.key, code: c.code, keyCode: c.keyCode, which: c.keyCode, ctrlKey: true, altKey: true, shiftKey: true, bubbles: true, cancelable: true };
    const target = document.activeElement || document.body;
    for (const t of ['keydown', 'keyup']) target.dispatchEvent(new KeyboardEvent(t, o));
  };
  const sweep = () => { let n = 0; for (const c of chords) if (shown(c.sel)) { press(c); n++; } return n; };
  const first = sweep();
  if (${hold ? "true" : "false"} && !window.__holdClosed) {
    window.__holdClosed = { undone: 0 };
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; window.__holdClosed.undone += sweep(); });
    }).observe(document.body, { subtree: true, attributes: true, childList: true, attributeFilter: ['class', 'style'] });
  }
  return first;
})()`;

// Page script, route "CSS": hide the parts with display none and ask the layout to recompute.
export const PAGE_CSS_SCRIPT = `(() => {
  const s = document.createElement('style');
  s.textContent = ${JSON.stringify(Object.values(PARTS).map((x) => `${x}`).join(",") + "{display:none !important}")};
  document.head.appendChild(s);
  window.dispatchEvent(new Event('resize'));
  return true;
})()`;

// What the editor shows now: the file's URI (data-uri on the editor), the active line number, the window title.
export const EDITOR_NOW = `(() => {
  const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const eds = [...document.querySelectorAll('.monaco-editor[data-uri]')].filter(shown);
  const ed = eds[0] || null;
  const al = document.querySelector('.monaco-editor .line-numbers.active-line-number');
  return { uri: ed ? ed.getAttribute('data-uri') : null, editors: eds.length, line: al ? Number(al.textContent) : null, title: document.title, tabs: document.querySelectorAll('.monaco-workbench .tab').length };
})()`;

// Page script that reports the open file and line whenever either changes, through console.log only.
export const S2_WATCH = `(() => {
  if (window.__s2watch) return 'already';
  const log = console.log.bind(console);
  window.__s2watch = true;
  let last = '';
  const read = ${JSON.stringify(EDITOR_NOW)};
  const look = () => {
    const eds = [...document.querySelectorAll('.monaco-editor[data-uri]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    const al = document.querySelector('.monaco-editor .line-numbers.active-line-number');
    const state = { uri: eds[0] ? eds[0].getAttribute('data-uri') : null, line: al ? Number(al.textContent) : null };
    const s = JSON.stringify(state);
    if (s !== last) { last = s; log('__s2__:' + s); }
  };
  new MutationObserver(() => setTimeout(look, 30)).observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true, attributeFilter: ['data-uri', 'class'] });
  look();
  return 'installed';
})()`;

// Moves the cursor of the open editor to a line with synthetic events only: Ctrl+G, the number, Enter.
export const GOTO_LINE_SYNTHETIC = (n) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fire = (target, type, o) => target.dispatchEvent(new KeyboardEvent(type, Object.assign({ bubbles: true, cancelable: true }, o)));
  const g = { key: 'g', code: 'KeyG', keyCode: 71, which: 71, ctrlKey: true };
  const t = document.activeElement || document.body;
  fire(t, 'keydown', g); fire(t, 'keyup', g);
  let input = null;
  for (let i = 0; i < 30 && !input; i++) { await sleep(100); input = document.querySelector('.quick-input-widget input'); }
  if (!input) return 'no quick input';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, ':' + ${n});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(300);
  const e = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
  fire(input, 'keydown', e); fire(input, 'keyup', e);
  await sleep(500);
  return 'sent';
})()`;

// The state database of the workbench: every key whose name looks like layout state.
export const LAYOUT_DUMP = `(async () => {
  const names = (await indexedDB.databases()).map((d) => d.name).filter((n) => /^vscode-web-state-db/.test(n));
  const out = [];
  for (const name of names) {
    const db = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    for (const store of [...db.objectStoreNames]) {
      const rows = await new Promise((res, rej) => {
        const tx = db.transaction(store);
        const os = tx.objectStore(store);
        const keys = os.getAllKeys(); const vals = os.getAll();
        tx.oncomplete = () => res(keys.result.map((k, i) => [k, vals.result[i]]));
        tx.onerror = () => rej(tx.error);
      });
      for (const [k, v] of rows) if (/sidebar|panel|auxiliarybar|hidden|zen|layout|activitybar|statusbar|titlebar|visible|tabs|breadcrumb/i.test(String(k))) out.push({ db: name, version: db.version, store, key: k, value: v });
    }
    db.close();
  }
  return out;
})()`;

export const LAYOUT_SEED = (rows) => `(async () => {
  const rows = ${JSON.stringify(rows)};
  const byDb = new Map();
  for (const r of rows) { if (!byDb.has(r.db)) byDb.set(r.db, []); byDb.get(r.db).push(r); }
  let n = 0;
  for (const [name, list] of byDb) {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(name, list[0].version);
      r.onupgradeneeded = () => { for (const x of list) if (!r.result.objectStoreNames.contains(x.store)) r.result.createObjectStore(x.store); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    await new Promise((res, rej) => {
      const tx = db.transaction([...new Set(list.map((x) => x.store))], 'readwrite');
      for (const x of list) { tx.objectStore(x.store).put(x.value, x.key); n++; }
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
    db.close();
  }
  return n;
})()`;


export const ZEN = {
  "zenMode.fullScreen": false,
  "zenMode.silentNotifications": false,
  "zenMode.centerLayout": false,
  "zenMode.hideLineNumbers": false,
  "zenMode.restore": true,
};
export const TABS_NONE = { "workbench.editor.showTabs": "none" };
export const BREADCRUMBS_OFF = { "breadcrumbs.enabled": false };
export const OTHER = {
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "workbench.layoutControl.enabled": false,
  "window.menuBarVisibility": "hidden",
  "window.commandCenter": false,
  "workbench.editor.editorActionsLocation": "hidden",
  "workbench.editor.enablePreview": false,
  "workbench.statusBar.visible": false,
  "workbench.activityBar.location": "hidden",
  "workbench.sideBar.location": "right",
  "workbench.panel.defaultLocation": "bottom",
  "workbench.startupEditor": "none",
};
export const USER_CLOSE_CHORDS = CLOSE_CHORDS.map((c) => ({ key: `ctrl+alt+shift+${c.key}`, command: c.command }));
export const CLOSE_OTHERS_CHORD = { key: "ctrl+alt+shift+4", command: "workbench.action.closeOtherEditors" };
export const CLOSE_ACTIVE_CHORD = { key: "ctrl+alt+shift+5", command: "workbench.action.closeActiveEditor" }; // S2: puts the first tab's editor back

// The chords S3 is about. `-command` entries removing the default rule of each; both the Mac and the Linux/Windows
// spelling are listed because a removal only matches the rule written the same way.
export const CHORD_REMOVALS = [
  ["workbench.action.toggleSidebarVisibility", ["cmd+b", "ctrl+b"]],
  ["workbench.action.togglePanel", ["cmd+j", "ctrl+j"]],
  ["workbench.action.toggleZenMode", ["cmd+k z", "ctrl+k z"]],
  ["workbench.action.closeActiveEditor", ["cmd+w", "ctrl+w", "ctrl+f4"]],
  ["workbench.action.exitZenMode", ["escape escape"]],
  ["workbench.action.toggleAuxiliaryBar", ["cmd+alt+b", "ctrl+alt+b"]],
].flatMap(([command, keys]) => keys.map((key) => ({ key, command: "-" + command })));
export const DISABLE_ENTRIES = CHORD_REMOVALS;
