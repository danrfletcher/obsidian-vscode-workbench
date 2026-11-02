// A stand-in for the page `code serve-web` serves, for the tests of the chrome-hiding step (fake-serve-web.mjs modes `workbench` and
// `workbench-renamed` serve it, importing it only then because other tests copy that file around alone). It is not VS Code: it has the parts the chrome spike measured (docs/spike-chrome.md) under their real
// class names, builds them a moment after the script starts (the real workbench is not there at dom-ready), and does the three things
// the hiding relies on:
//   - reads /User/settings.json from the browser profile's IndexedDB (the stores `buildBrowserSeedScript` writes) and hides the parts
//     those settings hide: the activity bar, status bar, title bar, tab strip and breadcrumbs, and the secondary side bar and panel
//     only on a profile with no saved layout;
//   - reads /User/keybindings.json from the same place and runs the close commands bound to a chord (closeSidebar, closeAuxiliaryBar,
//     closePanel, closeOtherEditors) when that chord is pressed (the last rule for a chord wins, like VS Code's);
//   - starts from the saved layout in `/layout` of that store when there is one (side bar and panel open, a previous editor open).
// With `renamed`, every class name of the parts is different (`x-` prefixed), as after a VS Code update that renamed them: the hiding
// has nothing to find. Sizes are CSS sizes in a browser; jsdom has no layout, so there `getBoundingClientRect` answers from the same
// open/closed state.

/** The parts, as the chrome spike measured them: name, CSS class list, and the size they take when shown. */
export const PARTS = [
  { name: "titleBar", classes: "part titlebar", size: 30 },
  { name: "activityBar", classes: "part activitybar", size: 48 },
  { name: "sideBar", classes: "part sidebar", size: 200 },
  { name: "tabStrip", classes: "tabs-and-actions-container", size: 32 },
  { name: "breadcrumbs", classes: "breadcrumbs-control", size: 22 },
  { name: "editor", classes: "part editor", size: 400 },
  { name: "secondarySideBar", classes: "part auxiliarybar", size: 200 },
  { name: "panel", classes: "part panel", size: 200 },
  { name: "statusBar", classes: "part statusbar", size: 22 },
];

/**
 * The HTML of the fake workbench page.
 * @param {{ renamed?: boolean, files?: string[] }} options `files`: the editor URIs the saved layout would restore, then the requested one last.
 */
export function fakeWorkbenchHtml(options = {}) {
  const renamed = options.renamed === true;
  const parts = PARTS.map((p) => ({ ...p, classes: renamed ? p.classes.split(" ").map((c) => `x-${c}`).join(" ") : p.classes }));
  return `<!doctype html><html><head><meta charset="utf-8"><title>fake workbench</title></head><body><script>
(() => {
  const parts = ${JSON.stringify(parts)};
  const requested = ${JSON.stringify(options.files ?? [])};
  const state = { open: {}, editors: [] };
  const els = {};
  window.__fake = { state, commands: [] };
  const jsdom = /jsdom/i.test(navigator.userAgent);
  const read = (db, key) => new Promise((resolve) => {
    try {
      const q = db.transaction("vscode-userdata-store").objectStore("vscode-userdata-store").get(key);
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => resolve(undefined);
    } catch (e) { resolve(undefined); }
  });
  const json = (v) => { try { return JSON.parse(typeof v === "string" ? v : new TextDecoder().decode(v)); } catch (e) { return undefined; } };
  const open = () => new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    const r = indexedDB.open("vscode-web-db", 3);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(null);
  });
  const render = () => {
    for (const p of parts) {
      const e = els[p.name];
      if (!e) continue;
      const size = state.open[p.name] ? p.size : 0;
      e.style.width = size + "px";
      e.style.height = size + "px";
      e.style.display = size ? "block" : "none";
      e.setAttribute("data-open", String(!!size));
    }
    const ed = els.editor;
    if (ed) {
      ed.innerHTML = "";
      for (const uri of state.editors) {
        const m = document.createElement("div");
        m.className = "monaco-editor";
        m.setAttribute("data-uri", uri);
        ed.appendChild(m);
      }
    }
  };
  if (jsdom) {
    Element.prototype.getBoundingClientRect = function () {
      const open = this.getAttribute("data-open") === "true" || (this.classList.contains("monaco-editor") && this.parentElement && this.parentElement.getAttribute("data-open") === "true");
      const n = open ? 100 : 0;
      return { width: n, height: n, top: 0, left: 0, right: n, bottom: n, x: 0, y: 0, toJSON: () => ({}) };
    };
  }
  const run = (command) => {
    window.__fake.commands.push(command);
    if (command === "workbench.action.closeSidebar") state.open.sideBar = false;
    else if (command === "workbench.action.closeAuxiliaryBar") state.open.secondarySideBar = false;
    else if (command === "workbench.action.closePanel") state.open.panel = false;
    else if (command === "workbench.action.closeOtherEditors") state.editors = state.editors.slice(-1);
    else return;
    render();
  };
  const chordOf = (e) => ["ctrl", "alt", "shift", "meta"].filter((m) => e[m + "Key"]).concat([String(e.key).toLowerCase()]).join("+");
  (async () => {
    const db = await open();
    const settings = (db && json(await read(db, "/User/settings.json"))) || {};
    const layout = db ? json(await read(db, "/layout")) : undefined;
    const rules = (db && json(await read(db, "/User/keybindings.json"))) || [];
    if (db) db.close();
    const bindings = new Map();
    for (const r of Array.isArray(rules) ? rules : []) if (r && typeof r.key === "string" && typeof r.command === "string") bindings.set(r.key, r.command);
    document.addEventListener("keydown", (e) => {
      const command = bindings.get(chordOf(e));
      if (command) { e.preventDefault(); run(command); }
    });
    // the workbench is built after the page's dom-ready, not at it
    setTimeout(() => {
      for (const p of parts) {
        const e = document.createElement("div");
        e.className = p.classes;
        document.body.appendChild(e);
        els[p.name] = e;
      }
      const saved = layout && typeof layout === "object" ? layout : null;
      state.open = {
        titleBar: settings["window.commandCenter"] !== false,
        activityBar: settings["workbench.activityBar.location"] !== "hidden",
        sideBar: saved ? saved.sideBar !== false : true,
        tabStrip: settings["workbench.editor.showTabs"] !== "none",
        breadcrumbs: settings["breadcrumbs.enabled"] !== false,
        editor: true,
        secondarySideBar: saved ? saved.secondarySideBar === true : settings["workbench.secondarySideBar.defaultVisibility"] === "visible",
        panel: saved ? saved.panel === true : false,
        statusBar: settings["workbench.statusBar.visible"] !== false,
      };
      state.editors = (saved && Array.isArray(saved.editors) ? saved.editors : []).concat(requested);
      render();
    }, 10);
  })();
})();
</script></body></html>`;
}
