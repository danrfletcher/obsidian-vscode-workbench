/**
 * tests/render/container-chrome-check.py and tests/render/chrome-spike-pack.mjs (ticket warkworth-42, PR-1, review issue R1): S1 of the
 * chrome spike, measured in the Obsidian Code tab's <webview>. The pure parts are pinned here (reading a measurement, filling the
 * pack's placeholder origin, the layout seed, the verdicts) and `run_case` / `measure_all` run against a pretend Code tab: the real
 * functions, with the page, the <webview> loader and the clock replaced. The pack is built by the real script.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../helpers";

const HELPER = path.join(REPO_ROOT, "tests", "render", "container-chrome-check.py");
const PACK_SCRIPT = path.join(REPO_ROOT, "tests", "render", "chrome-spike-pack.mjs");

/** Run a bit of Python with the helper loaded as `m`; the body prints one JSON value. Input arrives as `a`. */
function py<T = any>(body: string, input: unknown = {}): T {
  const prog = [
    "import json, sys, asyncio, importlib.util",
    `spec = importlib.util.spec_from_file_location('container_chrome_check', ${JSON.stringify(HELPER)})`,
    "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    "a = json.loads(sys.stdin.read())",
    body,
  ].join("\n");
  const out = execFileSync("python3", ["-c", prog], { input: JSON.stringify(input), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  return JSON.parse(out.trim().split("\n").pop() as string) as T;
}

const PARTS = ["sideBar", "secondarySideBar", "activityBar", "statusBar", "titleBar", "panel", "tabStrip", "breadcrumb"];
const part = (w: number, h: number, focusable = 0) => ({ present: true, w, h, shown: w > 0 && h > 0, focusable });
/** A MEASURE result: every part hidden except those named. */
function measure(shown: Record<string, [number, number]> = {}, focusable: Record<string, number> = {}) {
  const parts: Record<string, unknown> = {};
  for (const p of PARTS) parts[p] = shown[p] ? part(shown[p][0], shown[p][1]) : part(0, 0, focusable[p] ?? 0);
  return { parts, editor: { w: 672, h: 654, left: 4, top: 4 }, viewport: { w: 680, h: 662 } };
}

describe("reading a measurement", () => {
  it("lists the parts that are not shown, in the report's order", () => {
    const m = measure({ sideBar: [166, 654], tabStrip: [500, 32] });
    expect(py("print(json.dumps(m.hidden_parts(a['m'], a['names'])))", { m, names: PARTS })).toEqual(["secondarySideBar", "activityBar", "statusBar", "titleBar", "panel", "breadcrumb"]);
  });

  it("writes WxH, and marks a 0x0 part that still holds focusable elements the way the host report does", () => {
    const m = measure({ sideBar: [166, 654] }, { panel: 3 });
    expect(py("print(json.dumps([m.px(a['m'], 'sideBar'), m.px(a['m'], 'panel'), m.px(a['m'], 'statusBar')]))", { m })).toEqual(["166x654", "0x0 (0px, focusable)", "0x0"]);
  });

  it("puts every measured case on one line per part and skips a case that did not render", () => {
    const out = { "R0 first load": measure({ sideBar: [166, 654] }), "R1 Zen": measure(), "R2": null };
    expect(py("print(json.dumps(m.route_row(a['out'], 'sideBar')))", { out })).toBe("R0 first load 166x654; R1 Zen 0x0");
  });
});

describe("the pack's placeholder origin and layout seed", () => {
  it("replaces the placeholder host and port everywhere in a script, and only the placeholder", () => {
    const script = 'const o = "http://127.0.0.1:1"; const a = {"authority":"127.0.0.1:1"}; const p = "127.0.0.1:12345";';
    expect(py("print(json.dumps(m.fill_origin(a['s'], '127.0.0.1:42733')))", { s: script })).toBe(
      'const o = "http://127.0.0.1:42733"; const a = {"authority":"127.0.0.1:42733"}; const p = "127.0.0.1:12345";',
    );
  });

  it("puts the dumped rows in place of null in the layout seed template and refuses a template without the line", () => {
    const rows = [{ db: "vscode-web-state-db-abc", version: 1, store: "ItemTable", key: "workbench.sideBar.hidden", value: "true" }];
    const got = py<string>("print(json.dumps(m.layout_seed_script('x\\nconst rows = null;\\ny', a['rows'])))", { rows });
    expect(got).toBe(`x\nconst rows = ${JSON.stringify(rows)};\ny`);
    expect(() => py("m.layout_seed_script('no such line', [])")).toThrow(/const rows = null/);
  });

  it("never prints a token in a message", () => {
    expect(py("print(json.dumps(m.strip_token('http://127.0.0.1:5/?tkn=SECRET123&folder=%2Fv')))")).toBe("http://127.0.0.1:5/?tkn=(hidden)&folder=%2Fv");
  });
});

describe("the Code tab the helper opens for R0", () => {
  it("closes only the plugin's Code tabs and opens a new one in the plugin's view type on the given file", () => {
    const [close, open] = py<string[]>("print(json.dumps([m.close_code_tabs_js(), m.open_code_tab_js(a['f'])]))", { f: "notes/a b.js" });
    expect(close).toBe("(() => { window.app.workspace.detachLeavesOfType(\"vscode-workbench-code\"); return 'closed'; })()");
    expect(open).toContain('type: "vscode-workbench-code"');
    expect(open).toContain('state: { file: "notes/a b.js" }');
  });

  it("uses the view type src/code-view.ts registers", () => {
    expect(fs.readFileSync(path.join(REPO_ROOT, "src/code-view.ts"), "utf8")).toContain('VIEW_TYPE_CODE = "vscode-workbench-code"');
  });
});

describe("the verdicts", () => {
  it("says the side bar can be hidden when any route past R0 hid it, and reports the best route in each state", () => {
    const out = {
      "R0 first load": measure({ sideBar: [166, 654] }),
      "R1 Zen": measure(),
      "best first load": measure(),
      "best after reload": measure(),
      "best on a profile with saved layout": measure({ sideBar: [166, 654] }),
    };
    const v = py<any>("print(json.dumps(m.verdicts(a['out'], a['names'])))", { out, names: PARTS });
    expect(v.sideBarHideableByAnyRoute).toBe(true);
    expect(v.sideBarHiddenByBest).toEqual({ "best first load": true, "best after reload": true, "best on a profile with saved layout": false });
    expect(v.bestHidesAll["best on a profile with saved layout"]).not.toContain("sideBar");
  });

  it("does not count R0 or the prior-state profile as a route that hid the side bar", () => {
    const out = { "R0 first load": measure(), "prior state (R0 + panel + secondary side bar opened)": measure(), "R2": measure({ sideBar: [166, 628] }) };
    expect(py<any>("print(json.dumps(m.verdicts(a['out'], a['names'])))", { out, names: PARTS }).sideBarHideableByAnyRoute).toBe(false);
  });
});

describe("run_case, with a pretend Code tab", () => {
  /** Runs the real run_case against a Tab whose <webview> and page are replaced; returns the order of what was done. */
  function runCase(caseOverrides: Record<string, unknown> = {}, rows: unknown = null, keep = false) {
    const pack = {
      partNames: PARTS,
      scripts: { TRUST: 'TRUST authority "127.0.0.1:1"', LAYOUT_SEED_TEMPLATE: "const rows = null;" },
    };
    const kase = { id: "best", label: "best", seed: 'SEED origin "http://127.0.0.1:1"', pageScript: "PAGE_SCRIPT", enterZen: false, ...caseOverrides };
    return py<any>(
      [
        "ctc = m.load_terminal_check()",
        "log = []",
        "class FakePage:",
        "    async def ev(self, script, timeout=30):",
        "        log.append(('ev', script)); return 'ok'",
        "class FakeTab:",
        "    def __init__(self):",
        "        self.pack = a['pack']; self.rep = ctc.Reporter(echo=False); self.base = 'http://127.0.0.1:42733'; self.host = '127.0.0.1:42733'",
        "        self.href = 'http://127.0.0.1:42733/?folder=%2Fv'; self.page = FakePage()",
        "    async def clear(self): log.append(('clear',)); return 'cleared'",
        "    async def load(self, href): log.append(('load', href))",
        "    async def ready(self, seconds=90): log.append(('ready',)); return True",
        "    async def palette(self, text): log.append(('palette', text))",
        "    async def measure(self): log.append(('measure',)); return {'parts': {}, 'editor': {'w': 1, 'h': 2}, 'viewport': {'w': 3, 'h': 4}}",
        "    async def shot(self, name): log.append(('shot', name))",
        "tab = FakeTab()",
        "async def nosleep(_s): pass",
        "m.asyncio.sleep = nosleep",
        "res = asyncio.run(m.run_case(tab, a['case'], rows=a['rows'], keep=a['keep']))",
        "print(json.dumps({'log': log, 'res': res, 'text': tab.rep.lines}))",
      ].join("\n"),
      { pack, case: kase, rows, keep },
    );
  }

  it("clears the profile, seeds on the bare origin with the real host, loads the tab's address, then runs the page script and measures", () => {
    const r = runCase();
    const steps = r.log.map((e: any[]) => (e[0] === "ev" ? `ev:${String(e[1]).split(" ")[0]}` : e[0] === "load" ? `load:${e[1]}` : e[0]));
    expect(steps).toEqual([
      "clear",
      "load:http://127.0.0.1:42733/",
      "ev:SEED", // the route's browser seed
      "ev:TRUST", // the Workspace Trust record, as a Code tab writes it
      "load:http://127.0.0.1:42733/?folder=%2Fv",
      "ready",
      "ev:(()", // the cancel-a-dialog script
      "ev:PAGE_SCRIPT",
      "measure",
    ]);
    const evs = r.log.filter((e: any[]) => e[0] === "ev").map((e: any[]) => e[1]);
    expect(evs[0]).toBe('SEED origin "http://127.0.0.1:42733"'); // placeholder replaced
    expect(evs[1]).toBe('TRUST authority "127.0.0.1:42733"');
    expect(r.res.editor).toEqual({ w: 1, h: 2 });
  });

  it("keeps the profile when asked, writes the layout rows before loading, and presses Zen from the palette", () => {
    const rows = [{ db: "d", version: 1, store: "s", key: "k", value: "v" }];
    const r = runCase({ enterZen: true, pageScript: null }, rows, true);
    const names = r.log.map((e: any[]) => e[0]);
    expect(names).not.toContain("clear");
    const layoutEv = r.log.find((e: any[]) => e[0] === "ev" && String(e[1]).startsWith("const rows = "));
    expect(layoutEv?.[1]).toBe(`const rows = ${JSON.stringify(rows)};`);
    expect(names.indexOf("ev")).toBeLessThan(names.lastIndexOf("load"));
    expect(r.log.find((e: any[]) => e[0] === "palette")).toEqual(["palette", "View: Toggle Zen Mode"]);
  });

  it("returns nothing and records a FAIL when the page never renders", () => {
    const prog = [
      "ctc = m.load_terminal_check()",
      "class P:",
      "    async def ev(self, s, t=30): return 'ok'",
      "class T:",
      "    def __init__(self): self.pack = {'partNames': [], 'scripts': {'TRUST': '', 'LAYOUT_SEED_TEMPLATE': ''}}; self.rep = ctc.Reporter(echo=False); self.base = 'http://127.0.0.1:2'; self.host = '127.0.0.1:2'; self.href = 'http://127.0.0.1:2/?x'; self.page = P()",
      "    async def clear(self): return 'cleared'",
      "    async def load(self, h): pass",
      "    async def ready(self, seconds=90): return False",
      "    async def shot(self, n): pass",
      "t = T()",
      "async def nosleep(_s): pass",
      "m.asyncio.sleep = nosleep",
      "res = asyncio.run(m.run_case(t, {'id': 'r2', 'label': 'R2', 'seed': 's'}))",
      "print(json.dumps({'res': res, 'fails': t.rep.fails}))",
    ].join("\n");
    const r = py<any>(prog);
    expect(r.res).toBeNull();
    expect(r.fails).toEqual(["r2: the Code tab's page rendered"]);
  });
});

describe("measure_all, with a pretend Code tab", () => {
  /** Runs the real measure_all against a Tab whose <webview> and page are replaced; the profile is a dict that remembers what was written. */
  function measureAll() {
    const ids = ["r0", "r1", "r2", "r3", "r4", "r234", "r5-discover", "r6a", "r6b", "best"];
    const cases = ids.map((id) => ({ id, label: `label ${id}`, seed: `SEED:${id}`, enterZen: id === "r1", pageScript: id === "r6a" || id === "best" ? `SCRIPT:${id}` : null }));
    const pack = { partNames: PARTS, scripts: { TRUST: "TRUST", LAYOUT_SEED_TEMPLATE: "const rows = null;", LAYOUT_DUMP: "LAYOUT_DUMP" } };
    return py<any>(
      [
        "ctc = m.load_terminal_check()",
        "log = []",
        "state = {'seed': None, 'opened': False}",
        "class FakePage:",
        "    async def ev(self, script, timeout=30):",
        "        log.append(('ev', script))",
        "        if script.startswith('SEED:'): state['seed'] = script[5:]",
        "        if script == 'LAYOUT_DUMP': return [{'db': 'd', 'version': 1, 'store': 's', 'key': 'k', 'value': 'v'}]",
        "        return 'ok'",
        "class FakeTab:",
        "    def __init__(self):",
        "        self.pack = a['pack']; self.rep = ctc.Reporter(echo=False); self.base = 'http://127.0.0.1:42733'; self.host = '127.0.0.1:42733'",
        "        self.href = 'http://127.0.0.1:42733/?folder=%2Fv'; self.page = FakePage()",
        "    async def clear(self): log.append(('clear',)); state['seed'] = None; state['opened'] = False; return 'cleared'",
        "    async def load(self, href): log.append(('load', href))",
        "    async def reload(self): log.append(('reload', state['seed']))",
        "    async def ready(self, seconds=90): return True",
        "    async def palette(self, text):",
        "        log.append(('palette', text)); state['opened'] = True",
        "    async def measure(self):",
        "        log.append(('measure', state['seed'], state['opened']))",
        "        side = {'present': True, 'w': 166, 'h': 654, 'shown': True, 'focusable': 0} if state['opened'] else {'present': True, 'w': 0, 'h': 0, 'shown': False, 'focusable': 0}",
        "        parts = {p: {'present': True, 'w': 0, 'h': 0, 'shown': False, 'focusable': 0} for p in a['pack']['partNames']}",
        "        parts['sideBar'] = side",
        "        return {'parts': parts, 'editor': {'w': 1, 'h': 2}, 'viewport': {'w': 3, 'h': 4}}",
        "    async def shot(self, name): log.append(('shot', name))",
        "tab = FakeTab()",
        "async def nosleep(_s): pass",
        "m.asyncio.sleep = nosleep",
        "by_id = {c['id']: c for c in a['cases']}",
        "out = asyncio.run(m.measure_all(tab, by_id, tab.rep))",
        "print(json.dumps({'keys': list(out.keys()), 'none': [k for k, v in out.items() if v is None], 'log': log, 'side': {k: (v or {}).get('parts', {}).get('sideBar', {}).get('shown') for k, v in out.items()}}))",
      ].join("\n"),
      { pack, cases },
    );
  }

  it("measures every route on a fresh profile, after a reload and on a profile holding saved layout state", () => {
    const r = measureAll();
    const keysOf: Record<string, [string, string]> = {
      "R1 Zen": ["R1 Zen after reload", "R1 Zen on saved layout"],
      R2: ["R2 after reload", "R2 on saved layout"],
      R3: ["R3 after reload", "R3 on saved layout"],
      R4: ["R4 after reload", "R4 on saved layout"],
      "R2+R3+R4": ["R2+R3+R4 after reload", "R2+R3+R4 on saved layout"],
      "R5b layout keys in a fresh profile": ["R5b after reload", "R5b on saved layout"],
      "R6a close commands via chords": ["R6a after reload", "R6a on saved layout"],
      "R6b CSS display none": ["R6b after reload", "R6b on saved layout"],
      "best first load": ["best after reload", "best on a profile with saved layout"],
      "R0 first load": ["R0 after reload", "R0 on saved layout"],
    };
    for (const [route, others] of Object.entries(keysOf)) expect(r.keys, route).toEqual(expect.arrayContaining([route, ...others]));
    expect(r.keys).toEqual(expect.arrayContaining(["R5 parts closed (close chords)", "R5a same profile, reload, no script", "R5 on saved layout"]));
    expect(r.none).toEqual([]);
  });

  it("reloads the same profile for the reload case, and keeps the storage (no clear) for the saved-layout case", () => {
    const r = measureAll();
    // For each route's seed: was the storage cleared since the previous seed? A route seeds three times: fresh (cleared), then the
    // saved-layout run (not cleared, because the profile was just made to hold saved layout state); a reload does not seed at all.
    const cleared: Record<string, boolean[]> = {};
    let clearedSince = false;
    for (const e of r.log as any[][]) {
      if (e[0] === "clear") clearedSince = true;
      if (e[0] === "ev" && /^SEED:(r2|r6a|best)\b/.test(String(e[1]))) {
        const id = String(e[1]).slice(5);
        (cleared[id] ??= []).push(clearedSince);
        clearedSince = false;
      }
      if (e[0] === "palette") clearedSince = false;
    }
    for (const id of ["r2", "r6a", "best"]) expect(cleared[id], id).toEqual([true, false]);
    // a reload leaves the seed that was written in place (the fake remembers it in `state`)
    const reloads = (r.log as any[][]).filter((e) => e[0] === "reload");
    expect(reloads.map((e) => e[1])).toEqual(expect.arrayContaining(["r2", "r6a", "best", "r1", "r3", "r4", "r234", "r6b", "r0"]));
  });

  it("shows a route that hides nothing on the saved-layout profile as not hidden (the saved state wins), and one that hides it as hidden", () => {
    const r = measureAll();
    // the fake side bar is open only after the palette opened it in the same profile, and a clear closes it again
    expect(r.side["R0 first load"]).toBe(false);
    expect(r.side["prior state (R0 + panel + secondary side bar opened)"]).toBe(true);
    expect(r.side["R2 on saved layout"]).toBe(true);
    expect(r.side["R2"]).toBe(false);
  });
});

describe("chrome-spike-pack.mjs", () => {
  // Not `tempDir`: that folder is removed after each test, and the pack is built once for the group.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-pack-"));
  const file = path.join(dir, "pack.json");
  let pack: any;
  let byId: Map<string, any>;
  beforeAll(() => {
    execFileSync("node", [PACK_SCRIPT, file, "/config/vault"], { encoding: "utf8" });
    pack = JSON.parse(fs.readFileSync(file, "utf8"));
    byId = new Map<string, any>(pack.cases.map((c: any) => [c.id, c]));
  }, 60_000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("holds one case per route of the report, in the order the helper runs them", () => {
    expect(pack.cases.map((c: any) => c.id)).toEqual(["r0", "r1", "r2", "r3", "r4", "r234", "r5-discover", "r6a", "r6b", "best"]);
    expect(pack.partNames).toEqual(PARTS);
  });

  it("builds each seed from the plugin's own settings: the routes' keys are in their seeds and not in R0's", () => {
    expect(byId.get("r0").seed).not.toContain("workbench.editor.showTabs");
    expect(byId.get("r2").seed).toContain("workbench.editor.showTabs");
    expect(byId.get("r3").seed).toContain("breadcrumbs.enabled");
    expect(byId.get("r1").seed).toContain("zenMode.restore");
    for (const key of ["workbench.editor.showTabs", "breadcrumbs.enabled", "workbench.secondarySideBar.defaultVisibility"]) expect(byId.get("best").seed).toContain(key);
    // today's plugin settings are laid under every route
    expect(byId.get("r0").seed).toContain("workbench.activityBar.location");
    expect(byId.get("r2").seed).toContain("workbench.activityBar.location");
  });

  it("keeps the watcher only in the best route and Zen only in R1", () => {
    expect(byId.get("best").pageScript).toContain("__holdClosed");
    expect(byId.get("r6a").pageScript).toContain("closeSidebar");
    expect(byId.get("r6a").pageScript).not.toContain("hold ? ");
    expect(byId.get("r1").enterZen).toBe(true);
    expect(pack.cases.filter((c: any) => c.enterZen).map((c: any) => c.id)).toEqual(["r1"]);
  });

  it("writes the trust record for the vault folder under the placeholder origin, and no token", () => {
    expect(pack.scripts.TRUST).toContain('"authority":"127.0.0.1:1"');
    expect(pack.scripts.TRUST).toContain('"path":"/config/vault"');
    expect(pack.scripts.LAYOUT_SEED_TEMPLATE).toContain("const rows = null;");
    expect(fs.readFileSync(file, "utf8")).not.toMatch(/tkn/);
  });

  it("is readable by the helper: every placeholder is replaced and the layout template accepts rows", () => {
    const filled = py<string>("pack = json.load(open(a['file'])); print(json.dumps(m.fill_origin(pack['scripts']['TRUST'], '127.0.0.1:42733')))", { file });
    expect(filled).not.toContain("127.0.0.1:1\"");
    expect(filled).toContain("127.0.0.1:42733");
  });
});
