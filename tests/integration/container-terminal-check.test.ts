/**
 * tests/render/container-terminal-check.py: the helper the tester runs inside the Obsidian container for GP2, S2 and E7/S1
 * (ticket warkworth-37, PR-1). What can be pinned without the container is pinned here: reading /proc (the new shell's cwd, the
 * tree), building and writing the request, the extension it writes, the seed script, the process-tree print, and the PASS/FAIL
 * logic of every check against a pretend machine (tests/fixtures/container_check_world.py). The pretend machine runs the helper's
 * own functions; only the process table, the page and the clock are replaced.
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BROWSER_APP_SETTINGS, buildBrowserSeedScript } from "../../src/settings";
import { WORKBENCH_DB_NAME, WORKBENCH_DB_VERSION, WORKBENCH_SETTINGS_KEY, WORKBENCH_USERDATA_STORE } from "../../src/workbench-db";
import { REPO_ROOT, tempDir } from "../helpers";

const HELPER = path.join(REPO_ROOT, "tests", "render", "container-terminal-check.py");
const FIXTURES = path.join(REPO_ROOT, "tests", "fixtures");
const PROBE = fs.readFileSync(path.join(REPO_ROOT, "tests", "render", "terminal-spike-check.mjs"), "utf8");
const EXTENSION_CJS = path.join(REPO_ROOT, "tests", "render", "terminal-at-extension.cjs");

/** Run a bit of Python with the helper loaded as `m` (and the pretend machine as `w`); the body prints one JSON value. Input arrives as `a`. */
function py<T = any>(body: string, input: unknown = {}): T {
  const prog = [
    "import json, sys, os, asyncio",
    `sys.path.insert(0, ${JSON.stringify(FIXTURES)})`,
    "import container_check_world as w",
    "m = w.m",
    "a = json.loads(sys.stdin.read())",
    body,
  ].join("\n");
  const out = execFileSync("python3", ["-c", prog], { input: JSON.stringify(input), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  return JSON.parse(out.trim().split("\n").pop() as string) as T;
}

describe("the process table, read from /proc", () => {
  /** A /proc-shaped folder: <pid>/stat, <pid>/cmdline (NUL separated) and <pid>/cwd as a symlink. */
  function fakeProc(procs: Array<{ pid: number; comm: string; state?: string; ppid: number; args: string[]; cwd?: string }>): string {
    const root = tempDir("ctc-proc-");
    for (const p of procs) {
      const d = path.join(root, String(p.pid));
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, "stat"), `${p.pid} (${p.comm}) ${p.state ?? "S"} ${p.ppid} ${p.pid} ${p.pid} 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 100 1000 100 18446744073709551615\n`);
      fs.writeFileSync(path.join(d, "cmdline"), p.args.length ? Buffer.from(p.args.join("\0") + "\0") : Buffer.alloc(0));
      if (p.cwd !== undefined) fs.symlinkSync(p.cwd, path.join(d, "cwd"));
    }
    fs.mkdirSync(path.join(root, "sys")); // not a process
    return root;
  }

  it("splits a stat line at the last ')' so a command name with spaces and brackets reads right", () => {
    expect(py(`print(json.dumps(m.parse_stat("812 (Web (Content) x) T 77 812 812 0 -1")))`)).toEqual({ pid: 812, comm: "Web (Content) x", state: "T", ppid: 77 });
    expect(py(`print(json.dumps(m.parse_stat("garbage")))`)).toBeNull();
  });

  it("reads rows (pid, ppid, state, arguments with spaces and non-ASCII kept whole) and names a kernel thread by its comm", () => {
    const root = fakeProc([
      { pid: 10, comm: "bash", ppid: 1, args: ["bash", "/opt/code", "serve-web", "--server-data-dir", "/data/with space/文件"] },
      { pid: 11, comm: "kworker", ppid: 2, args: [] },
      { pid: 12, comm: "sleep", state: "T", ppid: 10, args: ["sleep", "600"] },
    ]);
    const rows = py<any[]>(`print(json.dumps(m.read_proc_table(a["root"]), ensure_ascii=False))`, { root });
    expect(rows.map((r) => [r.pid, r.ppid, r.state])).toEqual(expect.arrayContaining([[10, 1, "S"], [11, 2, "S"], [12, 10, "T"]]));
    expect(rows.find((r) => r.pid === 10).args).toEqual(["bash", "/opt/code", "serve-web", "--server-data-dir", "/data/with space/文件"]);
    expect(rows.find((r) => r.pid === 11).cmd).toBe("[kworker]");
    expect(rows).toHaveLength(3);
  });

  it("readlink of /proc/<pid>/cwd: the folder with spaces and non-ASCII characters comes back exactly; a missing process reads as None", () => {
    const folder = path.join(tempDir("ctc-cwd-"), "estimaté tïme 文件", "Notes folder with spaces");
    fs.mkdirSync(folder, { recursive: true });
    const root = fakeProc([{ pid: 20, comm: "zsh", ppid: 1, args: ["/bin/zsh", "-il"], cwd: folder }]);
    const out = py<{ cwd: string; gone: unknown }>(`print(json.dumps({"cwd": m.read_cwd(20, a["root"]), "gone": m.read_cwd(21, a["root"])}, ensure_ascii=False))`, { root });
    expect(out.cwd).toBe(folder);
    expect(out.gone).toBeNull();
  });

  it("a cwd counts as the folder through symlinks, but a deleted one or another folder does not", () => {
    const base = fs.realpathSync(tempDir("ctc-same-"));
    const real = path.join(base, "real folder");
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(base, "link"));
    const r = py<boolean[]>(`print(json.dumps([m.same_folder(a["link"], a["real"]), m.same_folder(a["real"] + " (deleted)", a["real"]), m.same_folder(a["base"], a["real"]), m.same_folder(None, a["real"]), m.same_folder(a["real"], a["base"] + "/missing")]))`, { link: path.join(base, "link"), real, base });
    expect(r).toEqual([true, false, false, false, false]);
  });
});

describe("the server's process tree", () => {
  const ROWS = [
    ["100", "1", "S", ["bash", "/opt/code", "serve-web", "--server-data-dir", "/data dir/s"]],
    ["101", "100", "S", ["node", "cli.js", "serve-web", "--server-data-dir", "/data dir/s"]],
    ["102", "101", "S", ["node", "out/server-main.js"]],
    ["103", "102", "S", ["node", "out/bootstrap-fork", "--type=ptyHost"]],
    ["104", "103", "Ss", ["/bin/zsh", "-il"]],
    ["105", "103", "Ss", ["-zsh"]],
    ["106", "103", "Ts", ["/bin/bash", "-il"]], // a shell that stopped itself: still a live child of the pty host
    ["107", "104", "S", ["python3", "-m", "http.server", "8000"]],
    ["108", "102", "S", ["node", "out/bootstrap-fork", "--type=extensionHost"]],
    ["109", "1", "S", ["sleep", "700"]], // a nohup process re-parented to init: not in the tree
    ["200", "1", "S", ["bash", "/opt/code", "serve-web", "--server-data-dir", "/data dir/s"]], // another server on the same dir
    ["300", "1", "S", ["bash", "/opt/code", "serve-web", "--server-data-dir=/other"]],
  ].map(([pid, ppid, state, args]) => ({ pid: +pid, ppid: +ppid, state, args, cmd: (args as string[]).join(" ") }));

  it("shells are the pty host's children that are a shell (login '-zsh' and a stopped shell included); the http.server and the extension host are not", () => {
    const v = py<{ shells: number[]; tree: number[]; pty: number }>(
      `v = m.server_view(a["rows"], 100)\nprint(json.dumps({"shells": [r["pid"] for r in v["shells"]], "tree": [r["pid"] for r in v["tree"]], "pty": v["pty_host"]["pid"]}))`,
      { rows: ROWS },
    );
    expect(v.shells).toEqual([104, 105, 106]);
    expect(v.pty).toBe(103);
    expect(v.tree).toEqual([100, 101, 102, 103, 108, 104, 105, 106, 107]);
  });

  it("finds a leftover serve-web on the same server data dir (path with a space; both '--flag value' and '--flag=value'), and nothing for another dir", () => {
    const r = py<{ roots: number[]; left: number[]; other: number[]; dir: string }>(
      `print(json.dumps({"roots": m.serve_web_roots(a["rows"], "/data dir/s"), "left": m.leftover_roots(a["rows"], "/data dir/s", 100), "other": m.leftover_roots(a["rows"], "/other", 100), "dir": m.data_dir_of(a["rows"][1])}))`,
      { rows: ROWS },
    );
    expect(r.roots).toEqual([100, 200]);
    expect(r.left).toEqual([200]);
    expect(r.other).toEqual([300]);
    expect(r.dir).toBe("/data dir/s");
  });

  it("reads the server pid from the plugin's pidfile: the live vscode-server entry only", () => {
    const f = path.join(tempDir("ctc-pids-"), "pids.json");
    fs.writeFileSync(f, JSON.stringify([{ pid: 11, label: "vscode-server" }, { pid: 22, label: "other" }, { pid: 33, label: "vscode-server" }]));
    const got = py<Array<number | null>>(
      `print(json.dumps([m.server_pid_from_pidfile(a["f"], lambda p: p == 33), m.server_pid_from_pidfile(a["f"], lambda p: False), m.server_pid_from_pidfile(a["f"] + ".none")]))`,
      { f },
    );
    expect(got).toEqual([33, null, null]);
  });
});

describe("the tree print", () => {
  const PS = [
    "UID          PID    PPID  C STIME TTY          TIME CMD",
    "abc          100       1  0 10:00 ?        00:00:00 bash /opt/code serve-web",
    "abc          102     100  0 10:00 ?        00:00:03  \\_ node server-main.js",
    "abc         9000       1  0 10:00 ?        00:00:03 firefox",
    "abc          104     102  0 10:01 pts/0    00:00:00      \\_ /bin/zsh -il",
  ].join("\n");

  it("keeps the header and exactly the server's pids from `ps -ef --forest`, with ps's own indentation", () => {
    const out = py<string>(`print(json.dumps(m.filter_ps_forest(a["ps"], [100, 102, 104])))`, { ps: PS });
    expect(out.split("\n").filter(Boolean)).toEqual([PS.split("\n")[0], PS.split("\n")[1], PS.split("\n")[2], PS.split("\n")[4]]);
    expect(out).not.toContain("firefox");
  });

  it("draws the same tree from the process table where ps has no --forest (parents before children, a re-parented process on its own)", () => {
    const rows = [
      { pid: 100, ppid: 1, state: "S", args: ["bash", "code"], cmd: "bash code" },
      { pid: 104, ppid: 100, state: "Ss", args: ["/bin/zsh", "-il"], cmd: "/bin/zsh -il" },
      { pid: 109, ppid: 1, state: "SN", args: ["sleep", "700"], cmd: "sleep 700" },
      { pid: 55, ppid: 1, state: "S", args: ["unrelated"], cmd: "unrelated" },
    ];
    const out = py<string>(`print(json.dumps(m.render_forest(a["rows"], [100, 104, 109])))`, { rows });
    const lines = out.trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^\s+100\s+1 S\s+bash code$/);
    expect(lines[2]).toMatch(/^\s+104\s+100 Ss\s+ {2}\\_ \/bin\/zsh -il$/);
    expect(lines[3]).toMatch(/^\s+109\s+1 SN\s+sleep 700$/);
    expect(out).not.toContain("unrelated");
  });
});

describe("the extension, the request and the seed", () => {
  it("installs the extension inside the server's extension dir, registers it once, and keeps other registered extensions", () => {
    const data = tempDir("ctc-ext-");
    fs.mkdirSync(path.join(data, "extensions"));
    fs.writeFileSync(path.join(data, "extensions", "extensions.json"), JSON.stringify([{ identifier: { id: "other.ext" }, version: "1.0.0" }, { identifier: { id: "obsidian-vscode-workbench.terminal-at" }, version: "0.0.0" }]));
    const run = () => py<{ ext_dir: string; kept_other_entries: number }>(`print(json.dumps(m.install_extension(a["data"], a["src"])))`, { data, src: EXTENSION_CJS });
    run();
    const second = run();
    expect(second.ext_dir).toBe(path.join(data, "extensions", "obsidian-vscode-workbench.terminal-at-0.0.1"));
    expect(second.kept_other_entries).toBe(1);
    expect(fs.readFileSync(path.join(second.ext_dir, "extension.js"), "utf8")).toBe(fs.readFileSync(EXTENSION_CJS, "utf8"));
    const manifest = JSON.parse(fs.readFileSync(path.join(second.ext_dir, "package.json"), "utf8"));
    expect(manifest).toMatchObject({ name: "terminal-at", publisher: "obsidian-vscode-workbench", main: "./extension.js", activationEvents: ["onStartupFinished"], extensionKind: ["workspace"] });
    expect(manifest.contributes.configuration.properties["obsidianWorkbench.terminalPage"]).toMatchObject({ type: "boolean", default: false });
    const reg = JSON.parse(fs.readFileSync(path.join(data, "extensions", "extensions.json"), "utf8"));
    expect(reg.map((e: any) => e.identifier.id)).toEqual(["other.ext", "obsidian-vscode-workbench.terminal-at"]);
    expect(reg[1]).toMatchObject({ relativeLocation: "obsidian-vscode-workbench.terminal-at-0.0.1", location: { path: second.ext_dir, scheme: "file" } });
  });

  it("uses the same extension id, folder name, setting and panel settings as the host probe (a rename on one side fails here)", () => {
    const c = py<Record<string, any>>(`print(json.dumps({"id": m.EXT_ID, "dir": m.EXT_DIR_NAME, "setting": m.TERMINAL_PAGE_SETTING, "panel": m.PANEL_SETTINGS, "folders": m.FOLDER_NAMES, "db": m.WORKBENCH_DB}, ensure_ascii=False))`);
    expect(PROBE).toContain(`const EXT_ID = "${c.id}";`);
    expect(PROBE).toContain("const EXT_DIR_NAME = `${EXT_ID}-0.0.1`;");
    expect(c.dir).toBe(`${c.id}-0.0.1`);
    expect(PROBE).toContain(`const TERMINAL_PAGE_SETTING = "${c.setting}";`);
    expect(PROBE).toContain('"workbench.panel.opensMaximized": "always", [TERMINAL_PAGE_SETTING]: true');
    expect(c.panel).toEqual({ "workbench.panel.opensMaximized": "always", "obsidianWorkbench.terminalPage": true });
    for (const name of Object.values(c.folders) as string[]) expect(PROBE).toContain(name);
    expect(c.db).toEqual({ name: WORKBENCH_DB_NAME, version: WORKBENCH_DB_VERSION, store: WORKBENCH_USERDATA_STORE, settingsKey: WORKBENCH_SETTINGS_KEY });
  });

  it("writes the request whole by rename (no temp file left, text exact) and the real extension acts on it: newWithCwd with the folder as given, then deletes it", async () => {
    const dir = tempDir("ctc-req-");
    const tmp = tempDir("ctc-reqtmp-");
    const folder = "/vault/estimaté tïme 文件/Notes folder with spaces";
    const calls: unknown[][] = [];
    const vscode = {
      workspace: { getConfiguration: (s: string) => ({ get: (k: string) => s === "obsidianWorkbench" && k === "terminalPage" }) },
      commands: { executeCommand: (...a: unknown[]) => { calls.push(a); return Promise.resolve(); } },
    };
    const mod: { exports: { activate?: (c: { extensionPath: string }) => void } } = { exports: {} };
    new Function("require", "exports", "module", fs.readFileSync(EXTENSION_CJS, "utf8"))((n: string) => (n === "vscode" ? vscode : n === "fs" ? fs : n === "path" ? path : null), mod.exports, mod);
    mod.exports.activate?.({ extensionPath: dir });
    const written = py<string>(`print(json.dumps(m.write_request(a["dir"], m.build_request("r1", a["folder"]), a["tmp"]), ensure_ascii=False))`, { dir, tmp, folder });
    expect(written).toBe(path.join(dir, "request.json"));
    expect(fs.readdirSync(tmp)).toEqual([]);
    // fs.watch can still be coming alive when the request is written, and an event in that window is never reported (the extension
    // has no timer to re-scan). While the request is unread, touch it now and then: a live watcher reports that and the extension reads it.
    const request = path.join(dir, "request.json");
    let last = 0;
    await vi.waitFor(() => {
      if (calls.length === 0 && fs.existsSync(request) && Date.now() - last > 250) {
        last = Date.now();
        try { const now = new Date(); fs.utimesSync(request, now, now); } catch { /* the extension read it just now */ }
      }
      expect(calls).toEqual([["workbench.action.terminal.newWithCwd", { cwd: folder }]]);
    }, { timeout: 10_000, interval: 10 });
    await vi.waitFor(() => expect(fs.existsSync(path.join(dir, "request.json"))).toBe(false));
  });

  /** The seed in IndexedDB: the helper's script and the plugin's own `buildBrowserSeedScript` must leave the same settings behind. */
  function fakeIdb(initial?: { settings?: string | null; stores?: boolean }) {
    const stores = new Map<string, Map<string, unknown>>();
    if (initial?.stores !== false) stores.set(WORKBENCH_USERDATA_STORE, new Map(initial?.settings != null ? [[WORKBENCH_SETTINGS_KEY, new TextEncoder().encode(initial.settings)]] : []));
    const openStores = initial?.stores === false ? new Set<string>() : null;
    return {
      stores,
      indexedDB: {
        open: () => {
          const r: { result: unknown; onsuccess?: () => void; onupgradeneeded?: () => void } = { result: null };
          const db = {
            objectStoreNames: { contains: (n: string) => stores.has(n) },
            createObjectStore: (n: string) => { if (!openStores) stores.set(n, new Map()); },
            close: () => undefined,
            transaction: (n: string) => {
              const tx: { oncomplete?: () => void; objectStore: (x: string) => unknown } = {
                objectStore: () => ({
                  get: (k: string) => { const q: { result?: unknown; onsuccess?: () => void } = {}; queueMicrotask(() => { q.result = stores.get(n)?.get(k); q.onsuccess?.(); }); return q; },
                  put: (v: unknown, k: string) => { stores.get(n)?.set(k, v); queueMicrotask(() => tx.oncomplete?.()); },
                }),
              };
              return tx;
            },
          };
          r.result = db;
          queueMicrotask(() => r.onsuccess?.());
          return r;
        },
      },
    };
  }
  async function runSeed(script: string, initial?: { settings?: string | null; stores?: boolean }) {
    const fake = fakeIdb(initial);
    const outcome = await (new Function("indexedDB", "TextEncoder", "TextDecoder", `return ${script}`) as (...a: unknown[]) => Promise<string>)(fake.indexedDB, TextEncoder, TextDecoder);
    const raw = fake.stores.get(WORKBENCH_USERDATA_STORE)?.get(WORKBENCH_SETTINGS_KEY) as Uint8Array | undefined;
    const text = raw === undefined ? undefined : new TextDecoder().decode(raw);
    let settings: unknown;
    try { settings = text === undefined ? undefined : JSON.parse(text); } catch { settings = "(not JSON)"; }
    return { outcome, text, settings };
  }

  it.each([
    ["an empty profile", {}],
    ["a profile with its own keys and a different value for ours", { settings: JSON.stringify({ "editor.fontSize": 17, "workbench.panel.opensMaximized": "never" }) }],
    ["a settings file with a comment (left alone)", { settings: '{ // hand edited\n}' }],
    ["a settings file that is an array (left alone)", { settings: "[1]" }],
    ["a database without the user-data store", { stores: false }],
  ])("the seed script leaves the same result as the plugin's own for %s", async (_name, initial) => {
    const theirs = await runSeed(buildBrowserSeedScript({ "workbench.panel.opensMaximized": "always", "obsidianWorkbench.terminalPage": true }), initial as never);
    const script = py<string>(`print(json.dumps(m.build_seed_script(m.PANEL_SETTINGS)))`);
    const ours = await runSeed(script, initial as never);
    expect(ours).toEqual(theirs);
    if (!("stores" in initial) && !("settings" in initial)) expect(ours.settings).toEqual({ "workbench.panel.opensMaximized": "always", "obsidianWorkbench.terminalPage": true });
    if ("settings" in initial && initial.settings?.startsWith("{ //")) expect(ours.outcome).toBe("kept");
    if ("stores" in initial) expect(ours.outcome).toBe("no-store");
    if ("settings" in initial && initial.settings?.includes("fontSize")) expect(ours.settings).toEqual({ "editor.fontSize": 17, "workbench.panel.opensMaximized": "always", "obsidianWorkbench.terminalPage": true });
  });

  it("(the plugin's off switches are untouched by the helper's seed: it writes only its two keys)", () => {
    expect(py<string>(`print(json.dumps(m.build_seed_script(m.PANEL_SETTINGS)))`)).not.toContain(Object.keys(BROWSER_APP_SETTINGS)[0] as string);
  });
});

describe("layout rules and which webview is which", () => {
  const P = { win: [1400, 900], titlebar: null, activitybar: null, sidebar: [0, 892], auxiliarybar: null, editor: [0, 0], panel: [1392, 892], statusbar: null };
  const CODE = { win: [1400, 900], titlebar: null, activitybar: null, sidebar: [296, 892], auxiliarybar: null, editor: [1092, 892], panel: null, statusbar: null };

  it("panel-only means every other part is 0 px or absent and the panel fills the window; a list on the right means two entries in the right half", () => {
    const r = py<boolean[]>(`print(json.dumps([m.panel_only(a["P"]), m.panel_only(a["CODE"]), m.panel_only({**a["P"], "editor": [100, 892]}), m.panel_only({**a["P"], "panel": [800, 300]}), m.list_on_right([[1280, 0, 100, 24], [1280, 30, 100, 24]], 1400), m.list_on_right([[1280, 0, 100, 24]], 1400), m.list_on_right([[10, 0, 100, 24], [1280, 30, 100, 24]], 1400)]))`, { P, CODE });
    expect(r).toEqual([true, false, false, false, true, false, false]);
  });

  it("picks the panel-only webview as the terminal page and the rest as Code tabs; an explicit hint wins; ambiguity stops the run", () => {
    const targets = [{ id: "A", url: "http://127.0.0.1:1/?x", title: "code" }, { id: "B", url: "http://127.0.0.1:1/?y", title: "term" }];
    const r = py<any>(
      `t, c = m.pick_targets(a["targets"], {"A": a["CODE"], "B": a["P"]})\nt2, c2 = m.pick_targets(a["targets"], {"A": a["P"], "B": a["P"]}, "1")\nt3, c3 = m.pick_targets(a["targets"], {"A": a["CODE"], "B": a["CODE"]}, "term")\n` +
        `try:\n    m.pick_targets(a["targets"], {"A": a["CODE"], "B": a["CODE"]})\n    err = None\nexcept m.CannotRun as e:\n    err = str(e)\n` +
        `try:\n    m.pick_targets([], {})\n    err0 = None\nexcept m.CannotRun as e:\n    err0 = str(e)\n` +
        `print(json.dumps({"auto": [t["id"], [x["id"] for x in c]], "index": t2["id"], "title": t3["id"], "err": err, "err0": err0}))`,
      { targets, P, CODE },
    );
    expect(r.auto).toEqual(["B", ["A"]]);
    expect(r.index).toBe("B");
    expect(r.title).toBe("B");
    expect(r.err).toContain("--terminal-target");
    expect(r.err0).toContain("no workbench webview");
  });

  it("lists only the workbench webviews of the CDP endpoint (loopback server, not the VS Code inner webview frames)", () => {
    const list = [
      { id: "1", type: "webview", url: "http://127.0.0.1:5000/?tkn=x&folder=/v", webSocketDebuggerUrl: "ws://x/1" },
      { id: "2", type: "page", url: "app://obsidian.md/index.html" },
      { id: "3", type: "webview", url: "https://abc.vscode-webview.net/index.html" },
      { id: "4", type: "webview", url: "http://127.0.0.1:5000/vscode-webview/x" },
    ];
    const ids = py<string[]>(`import io\nprint(json.dumps([t["id"] for t in m.list_targets("http://h", "webview", lambda url, timeout: io.StringIO(json.dumps(a)))]))`, list);
    expect(ids).toEqual(["1"]);
  });
});

describe("typing a line into the terminal and checking it arrived on the machine", () => {
  const body = (deliverText: string, deliverKeys: string) => `
world = w.World()
page = w.FakePage(world, w.PANEL_ONLY, deliver_text=${deliverText}, deliver_keys=${deliverKeys})
env = world.env()
flag = os.path.join(world.out, "flag")
async def go():
    return await m.type_line(env, page, "pwd | tee '" + flag + "'", lambda: os.path.exists(flag))
print(json.dumps(w.run(go())))`;

  it("sends the text in one go first", () => expect(py(body("True", "True"))).toBe("insertText"));
  it("falls back to key events one character at a time when the machine shows nothing", () => expect(py(body("False", "True"))).toBe("key events"));
  it("says so when neither way arrived", () => expect(py(body("False", "False"))).toBe("not delivered"));
});

describe("terminal-at against a pretend machine", () => {
  const go = (world: string, pages: string, check: string) => `
${world}
term = w.FakePage(world, w.PANEL_ONLY)
${pages}
env = world.env()
rep = m.Reporter(echo=False)
async def go():
    await m.run_terminal_at(env, rep, w.args(world), term, codes, {"pid": w.SERVER_PID, "data_dir": world.data}, m.__file__.replace("container-terminal-check.py", "terminal-at-extension.cjs"), world.out)
w.run(go())
${check}`;
  const REPORT = `print(json.dumps({"fails": rep.fails, "passes": rep.passes, "lines": rep.lines, "data": rep.data, "shots": [os.path.basename(s) for s in term.shots], "codeShots": [os.path.basename(s) for p in codes.values() for s in p.shots], "reloads": term.reloads, "seeded": world.seeded}, ensure_ascii=False))`;
  const CODE_PAGE = `codes = {"[1] code": w.FakePage(world, w.CODE_TAB)}`;

  it("passes when the extension takes each request: shells in the vault root and the asked folders, pwd read from the shell, a list on the right, Code tab unchanged", () => {
    const r = py<any>(go("world = w.World()", CODE_PAGE, REPORT));
    expect(r.fails).toEqual([]);
    expect(r.seeded).toBe(true);
    expect(r.reloads).toBe(1);
    expect(r.shots).toEqual(["shot-1-container-panel-only-two-terminals.png", "shot-3-container-terminal-at-folder-with-spaces.png"]);
    expect(r.codeShots).toEqual(["shot-4b-container-code-tab-beside.png"]);
    const lines = (r.lines as string[]).join("\n");
    expect(lines).toContain("PASS  GP2: one shell started with the panel");
    expect(lines).toContain("PASS  GP2: the shell's working directory is the vault root");
    expect(lines).toContain("PASS  GP2: with two terminals the terminal list sits on the right");
    expect(lines).toContain("PASS  S2: `pwd` in that terminal printed the spaces folder");
    expect(lines).toContain("PASS  S2: `pwd` in that terminal printed the unicode folder");
    expect(lines).toContain("PASS  S2: a folder that does not exist opens no terminal");
    expect(r.data.s2.spaces.shell_cwd).toMatch(/Notes folder with spaces$/);
    expect(r.data.s2.unicode.pwd_printed).toMatch(/estimaté tïme 文件$/);
    expect(r.data.s2.unicode.typed_with).toBe("insertText");
  });

  it("fails the S2 lines when nothing takes the request (the container's symptom: request.json stays where it is)", () => {
    const r = py<any>(go("world = w.World(consume=False)", CODE_PAGE, REPORT));
    expect(r.fails).toEqual(expect.arrayContaining([
      "S2: a request for the spaces folder opened a terminal",
      "S2: a request for the unicode folder opened a terminal",
      "S2: the new shell's working directory is the spaces folder (readlink of the process's cwd)",
    ]));
    expect(r.fails).not.toContain("S2: a folder that does not exist opens no terminal");
  });

  it("T64: the child the pty host forks for a folder that does not exist (no readable cwd, gone at once) is not a terminal, so the missing folder reads as no terminal opened", () => {
    for (const mode of ["gone", "flash"]) {
      const r = py<any>(go(`world = w.World(missing_child="${mode}")`, CODE_PAGE, REPORT));
      expect(r.fails).toEqual([]);
      const line = (r.lines as string[]).find((l) => l.includes("a folder that does not exist opens no terminal"))!;
      expect(line).toMatch(/^PASS/);
      expect(line).toMatch(/1 child process\(es\) seen and not alive with a cwd/);
      expect(r.data.s2.missing.new_shell).toBeNull();
      expect(r.data.s2.missing.children_that_did_not_live).toHaveLength(1);
      expect(r.data.s2.spaces.new_shell).not.toBeNull();
    }
  });

  it("T64: a real shell for the missing folder (one that stays alive with a cwd) still FAILs the 'opens no terminal' line", () => {
    const r = py<any>(go(`world = w.World()\n_t = world.tick\ndef tick():\n    f = os.path.join(world.ext_dir, "request.json")\n    if os.path.exists(f) and not os.path.isdir(json.load(open(f, encoding="utf8"))["cwd"]):\n        world.shell(world.vault)\n    _t()\nworld.tick = tick`, CODE_PAGE, REPORT));
    expect(r.fails).toEqual(["S2: a folder that does not exist opens no terminal"]);
  });

  it("fails when a leftover serve-web is still using the server data dir", () => {
    const r = py<any>(go("world = w.World(extra_server=True)", CODE_PAGE, REPORT));
    expect(r.fails).toEqual(["no leftover serve-web uses this server data dir"]);
  });

  it("fails when GP2 does not hold: two shells at the start, or a shell that is not in the vault root", () => {
    const two = py<any>(go("world = w.World()\nworld.shell(world.vault)", CODE_PAGE, REPORT));
    expect(two.fails).toEqual(["GP2: one shell started with the panel"]);
    const wrong = py<any>(go("world = w.World()\nworld.cwds[world.last_shell()] = '/tmp'", CODE_PAGE, REPORT));
    expect(wrong.fails).toEqual(["GP2: the shell's working directory is the vault root (readlink of the process's cwd)"]);
  });

  it("fails when the Code tab's layout changed while the terminal page was worked on, and when there is no Code tab to compare", () => {
    const changed = py<any>(go("world = w.World()", `codes = {"[1] code": w.FakePage(world, w.CODE_TAB, react_to_seed={**w.CODE_TAB, "panel": [1092, 292]})}`, REPORT));
    expect(changed.fails).toEqual(["S1: Code tab [1] code has the same side bar, panel and layout before and after"]);
    const none = py<any>(go("world = w.World()", "codes = {}", REPORT));
    expect(none.fails).toEqual(["S1: a Code tab beside the terminal page keeps its layout"]);
  });

  it("fails the panel-only line when the webview is not panel-only after the keys", () => {
    const r = py<any>(go("world = w.World()", `term.lay = w.CODE_TAB\n${CODE_PAGE}`, REPORT));
    expect(r.fails).toContain("S1: in the container's webview, every other part measures 0 px and the panel fills the window");
  });
});

describe("force-quit against a pretend machine (E7, shot 4)", () => {
  const PREP = `
world = w.World()
term = w.FakePage(world, w.PANEL_ONLY)
codes = {"[1] code": w.FakePage(world, w.CODE_TAB)}
env = world.env()
def run(phase_coro):
    rep = m.Reporter(echo=False)
    w.run(phase_coro(rep))
    return rep
prep = run(lambda rep: m.run_force_quit_prepare(env, rep, w.args(world), term, codes, {"pid": w.SERVER_PID, "data_dir": world.data}, world.out))
`;
  const out = (extra = "") => `${extra}\nprint(json.dumps(res, ensure_ascii=False))`;

  it("prepare starts an http.server and a nohup/disown process in two terminals, checks both are in the server's tree, and saves what to watch", () => {
    const r = py<any>(PREP + out(`st = json.load(open(os.path.join(world.out, "force-quit-state.json")))\nres = {"fails": prep.fails, "lines": prep.lines, "st": st, "shots": [os.path.basename(s) for s in term.shots]}`));
    expect(r.fails).toEqual([]);
    expect(r.st.http_port).toBe(45678);
    expect(r.st.nohup_marker).toMatch(/^sleep \d+$/);
    expect(r.st.watched).toEqual(expect.arrayContaining([100, 102, 103, r.st.http_pid, r.st.nohup_pid]));
    expect(r.shots).toEqual(["shot-4a-container-ps-before-force-quit.png"]);
    expect((r.lines as string[]).join("\n")).toContain("ps -ef --forest, server tree, before the force-quit");
  });

  it("kill SIGKILLs only the Obsidian pid, prints the tree before and after, and checks the server, shells, http.server and nohup process survived", () => {
    const r = py<any>(PREP + out(`kill = run(lambda rep: m.run_force_quit_kill(env, rep, w.args(world)))\nres = {"fails": kill.fails, "lines": kill.lines, "signals": world.signals}`));
    expect(r.fails).toEqual([]);
    expect(r.signals).toEqual([[5000, 9]]);
    const text = (r.lines as string[]).join("\n");
    expect(text).toContain("immediately before the force-quit");
    expect(text).toContain("after the force-quit, before the next plugin start");
    expect(text).toContain("PASS  after the force-quit the server is still running");
  });

  it("kill refuses a pid that is not Obsidian and signals nothing", () => {
    const r = py<any>(PREP + out(`world.rows.append(w.row(7777, 1, ["bash", "-c", "someone else"]))\ntry:\n    run(lambda rep: m.run_force_quit_kill(env, rep, w.args(world, obsidian_pid=[7777])))\n    err = None\nexcept m.CannotRun as e:\n    err = str(e)\nres = {"err": err, "signals": world.signals}`));
    expect(r.err).toContain("not an Obsidian process");
    expect(r.signals).toEqual([]);
  });

  it("after passes when the sweep took the server, shells and http.server, reports the nohup process without judging it, and stops only what the check started", () => {
    const r = py<any>(PREP + out(`run(lambda rep: m.run_force_quit_kill(env, rep, w.args(world)))\nworld.sweep()\naft = run(lambda rep: m.run_force_quit_after(env, rep, w.args(world)))\nres = {"fails": aft.fails, "lines": aft.lines, "signals": world.signals}`));
    expect(r.fails).toEqual([]);
    const text = (r.lines as string[]).join("\n");
    expect(text).toMatch(/INFO  nohup\/disown process after the sweep: STILL RUNNING pid \d+ \(ppid 1\)/);
    expect(text).toContain("INFO  stopped pid");
    expect(r.signals.filter((s: number[]) => s[1] === 15)).toHaveLength(1);
  });

  it("a zombie (killed, not yet reaped by its parent) counts as gone, for the server and for the Obsidian pid", () => {
    const r = py<any>(PREP + out(`run(lambda rep: m.run_force_quit_kill(env, rep, w.args(world)))\nfor x in world.rows:\n    if x["pid"] == w.SERVER_PID: x["state"] = "Z"\naft = run(lambda rep: m.run_force_quit_after(env, rep, w.args(world)))\nres = {"fails": aft.fails, "running": [m.running(world.rows, w.SERVER_PID), m.running(world.rows, 101), m.running(world.rows, 424242)]}`));
    expect(r.running).toEqual([false, true, false]);
    expect(r.fails).not.toContain("after the next plugin start the sweep took the server down");
  });

  it("after fails when nothing swept: the server, the shells and the http.server are still there", () => {
    const r = py<any>(PREP + out(`run(lambda rep: m.run_force_quit_kill(env, rep, w.args(world)))\naft = run(lambda rep: m.run_force_quit_after(env, rep, w.args(world)))\nres = {"fails": aft.fails}`));
    expect(r.fails).toEqual([
      "after the next plugin start the sweep took the server down",
      "after the sweep no interactive shell of that server is left",
      "after the sweep the http.server no longer answers",
    ]);
  });
});

describe("trust-plugins (T18: the vault trust prompt keeps every plugin from loading)", () => {
  const go = (obs: string) => `
obs = ${obs}
env = w.World().env()
rep = m.Reporter(echo=False)
async def go():
    await m.run_trust_plugins(env, rep, obs, m.PLUGIN_ID, w.World().out, 1)
w.run(go())
print(json.dumps({"fails": rep.fails, "lines": rep.lines, "calls": obs.calls, "shots": obs.shots, "modal": obs.modal, "loaded": obs.loaded}, ensure_ascii=False))`;

  it("presses \"Trust author and enable plugins\" and passes once the plugin has an instance and commands", () => {
    const r = py<any>(go("w.FakeObsidian()"));
    expect(r.calls).toEqual(["click"]);
    expect(r.fails).toEqual([]);
    expect(r.loaded).toBe(true);
    expect(r.shots).toEqual(["obsidian-trust-prompt.png", "obsidian-after-trust.png"]);
    expect(r.lines.some((l: string) => l.startsWith('PASS  pressed "Trust author and enable plugins"'))).toBe(true);
  });

  it("falls back to setEnable(true) + enablePluginAndSave when the button does nothing", () => {
    const r = py<any>(go("w.FakeObsidian(button_works=False)"));
    expect(r.calls).toEqual(["click", "enable"]);
    expect(r.fails).toEqual([]);
  });

  it("with no prompt but a plugin that is not loaded (plugin loading switched off), only the fallback is used", () => {
    const r = py<any>(go("w.FakeObsidian(modal=False)"));
    expect(r.calls).toEqual(["enable"]);
    expect(r.fails).toEqual([]);
  });

  it("fails, saying so, when the plugin still has no instance after both ways (the container symptom)", () => {
    const r = py<any>(go("w.FakeObsidian(button_works=False, enable_works=False)"));
    expect(r.calls).toEqual(["click", "enable"]);
    expect(r.fails).toHaveLength(1);
    expect(r.fails[0]).toContain("is loaded");
  });

  it("does nothing when the plugin is already loaded and no prompt is showing", () => {
    const r = py<any>(go("w.FakeObsidian(modal=False, loaded=True)"));
    expect(r.calls).toEqual([]);
    expect(r.fails).toEqual([]);
  });

  it("finds Obsidian's own window (app://obsidian.md, type page) and not the workbench webviews", () => {
    const list = [
      { id: "1", type: "webview", url: "http://127.0.0.1:5000/?tkn=x", webSocketDebuggerUrl: "ws://x/1" },
      { id: "2", type: "page", url: "app://obsidian.md/index.html", webSocketDebuggerUrl: "ws://x/2" },
      { id: "3", type: "page", url: "http://127.0.0.1:5000/" },
    ];
    const ids = py<string[]>(`import io\nprint(json.dumps([t["id"] for t in m.obsidian_window_targets("http://h", lambda url, timeout: io.StringIO(json.dumps(a)))]))`, list);
    expect(ids).toEqual(["2"]);
  });

  it("the page script presses the button by its text and the state query reads the prompt, the instance and the commands (the strings the page runs)", () => {
    const r = py<any>(`print(json.dumps({"click": m.CLICK_TRUST_JS, "state": m.plugin_state_js("obsidian-vscode-workbench")}))`);
    expect(r.click).toContain("Trust author and enable plugins");
    expect(r.state).toContain("app.plugins");
    expect(r.state).toContain('"obsidian-vscode-workbench"');
    expect(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "manifest.json"), "utf8")).id).toBe("obsidian-vscode-workbench");
  });
});

describe("open-page (T29: nothing in the plugin opens a panel-only page, so the helper builds it from the Obsidian window)", () => {
  const VAULT = "/config/w37/vault with spaces/估计 vault";
  const PARTITION = "persist:vscode-workbench-terminal-spike";

  /** The page script run for real in a jsdom window with a fake plugin and a fake <webview> (which fires dom-ready and runs the seed). */
  async function runPageScript(opts: { plugin?: "ok" | "none" | "fails"; domReady?: boolean; twice?: boolean; seed?: string; readyMs?: number; trust?: boolean; trustOutcome?: string } = {}) {
    const script = py<string>(`print(json.dumps(m.open_page_js(m.PLUGIN_ID, a["vault"], "SEED_SCRIPT_MARKER", ${opts.readyMs ?? 30000}, 3000${opts.trust ? ", m.trust_script_template()" : ""})))`, { vault: VAULT });
    const jsdom = "jsdom"; // no @types/jsdom in the project: loaded by name, typed here
    const { JSDOM } = (await import(jsdom)) as { JSDOM: new (html: string, o: Record<string, unknown>) => { window: unknown } };
    const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only", url: "app://obsidian.md/index.html" });
    const w = dom.window as unknown as Record<string, any>;
    const log: string[] = [];
    const webviews: any[] = [];
    const createElement = w.document.createElement.bind(w.document);
    w.document.createElement = (tag: string) => {
      const el = createElement(tag);
      if (tag !== "webview") return el;
      el.executeJavaScript = async (code: string) => { log.push(`seed:${code}`); return code.includes("content.trust.model.key") ? (opts.trustOutcome ?? "seeded") : (opts.seed ?? "seeded"); };
      const set = el.setAttribute.bind(el);
      el.setAttribute = (k: string, v: string) => {
        set(k, v);
        if (k === "src") { log.push(`src:${v}`); if (opts.domReady !== false && log.filter((l) => l.startsWith("src:")).length === 1) setTimeout(() => el.dispatchEvent(new w.Event("dom-ready")), 5); }
      };
      webviews.push(el);
      return el;
    };
    const server = { baseUrl: "http://127.0.0.1:45123", port: 45123, token: "tok-SECRET-123" };
    const plugin = { ensureServer: () => (opts.plugin === "fails" ? Promise.reject(new Error("licence declined\nsecond line")) : Promise.resolve(server)) };
    w.app = { plugins: { plugins: opts.plugin === "none" ? {} : { "obsidian-vscode-workbench": plugin } } };
    const first = JSON.parse(await w.eval(script));
    const second = opts.twice ? JSON.parse(await w.eval(script)) : null;
    return { first, second, log, webviews, dom, server };
  }

  it("docks a <webview> in a partition of its own, loads the origin, seeds the panel settings once dom-ready fires, then loads the vault folder; the token is in no result", async () => {
    const r = await runPageScript();
    expect(r.first).toEqual({ status: "opened", ready: true, seed: "seeded", partition: PARTITION });
    expect(PARTITION).not.toBe("persist:vscode-workbench");
    expect(JSON.stringify(r.first)).not.toContain("SECRET");
    expect(r.webviews).toHaveLength(1);
    const el = r.webviews[0];
    expect(el.getAttribute("partition")).toBe(PARTITION);
    expect(el.hasAttribute("allowpopups")).toBe(true);
    // the same order as a Code tab: origin first, the seed in that page, only then the workbench
    expect(r.log).toEqual([
      "src:http://127.0.0.1:45123/",
      "seed:SEED_SCRIPT_MARKER",
      `src:http://127.0.0.1:45123/?tkn=tok-SECRET-123&folder=${encodeURIComponent(VAULT)}`,
    ]);
    const holder = (r.dom.window as { document: Document }).document.getElementById("obsidian-workbench-terminal-spike-page") as HTMLElement;
    expect(holder.contains(el)).toBe(true);
    expect(holder.style.position).toBe("fixed");
    expect(holder.style.bottom).toBe("0px");
  });

  it("the folder in the URL is exactly what src/paths.ts buildFolderUrl builds (spaces, non-ASCII)", async () => {
    const { buildFolderUrl } = await import("../../src/paths");
    const r = await runPageScript();
    expect(r.log.at(-1)).toBe(`src:${buildFolderUrl(r.server.baseUrl, VAULT, r.server.token)}`);
  });

  it("a second run finds the page already docked and starts nothing", async () => {
    const r = await runPageScript({ twice: true });
    expect(r.second).toEqual({ status: "already-open" });
    expect(r.webviews).toHaveLength(1);
  });

  it("says no-plugin when the plugin is not there, and no-server (first line of the reason only, no token) when the server does not start", async () => {
    expect((await runPageScript({ plugin: "none" })).first).toEqual({ status: "no-plugin" });
    const failed = await runPageScript({ plugin: "fails" });
    expect(failed.first).toEqual({ status: "no-server", error: "licence declined" });
    expect(failed.webviews).toHaveLength(0);
  });

  it("a page that never reports dom-ready is reported as not ready and is not pointed at the workbench", async () => {
    const r = await runPageScript({ domReady: false, readyMs: 40 });
    expect(r.first).toMatchObject({ status: "opened", ready: false, seed: "timeout" });
    expect(r.log).toEqual(["src:http://127.0.0.1:45123/"]);
  });

  it("the Code tab script opens the plugin's view type for a named file", () => {
    const r = py<{ file: string }>(`print(json.dumps({"file": m.open_code_tab_js(m.PLUGIN_ID, "notes/a b.py")}))`);
    expect(r.file).toContain('"vscode-workbench-code"');
    expect(r.file).toContain('state: { file: "notes/a b.py" }');
    const src = fs.readFileSync(path.join(REPO_ROOT, "src", "code-view.ts"), "utf8");
    expect(src).toContain('export const VIEW_TYPE_CODE = "vscode-workbench-code";');
    expect(src).toContain('"persist:vscode-workbench"'); // the Code tab's partition: the helper's page must differ
  });

  /** T37: the default Code tab script, run for real in jsdom against a vault with no code file in it (a clean container vault). */
  async function runDefaultCodeTab(opts: { existing?: boolean; plugin?: "ok" | "none" } = {}) {
    const script = py<string>(`print(json.dumps({"script": m.open_code_tab_js(m.PLUGIN_ID), "file": m.DEFAULT_CODE_FILE}))`);
    const { script: js, file } = script as unknown as { script: string; file: string };
    const jsdom = "jsdom";
    const { JSDOM } = (await import(jsdom)) as { JSDOM: new (html: string, o: Record<string, unknown>) => { window: unknown } };
    const w = (new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" }).window) as unknown as Record<string, any>;
    const files = new Map<string, string>(opts.existing ? [[file, "already here"]] : []);
    const opened: string[] = [];
    const commandsRun: string[] = [];
    w.app = {
      vault: { getAbstractFileByPath: (p: string) => (files.has(p) ? { path: p } : null), create: async (p: string, text: string) => void files.set(p, text) },
      commands: { executeCommandById: (id: string) => (commandsRun.push(id), false) },
      plugins: { plugins: opts.plugin === "none" ? {} : { "obsidian-vscode-workbench": { openCodeFile: async (p: string) => void (files.has(p) ? opened.push(p) : opened.push(`MISSING ${p}`)) } } },
    };
    const answer = await w.eval(js);
    return { answer, files, opened, commandsRun, file };
  }

  it("the default Code tab script makes its own code file in a vault that has none, then opens it through the plugin (the open-spike-file command only shows a notice there)", async () => {
    const r = await runDefaultCodeTab();
    expect(r.answer).toBe("opened");
    const { decideFile } = await import("../../src/text-file-rules");
    expect(decideFile(r.file).kind).toBe("extension"); // a file the plugin opens in a Code tab (pickFile does the same check)
    expect(r.files.get(r.file)).toContain("terminal spike");
    expect(r.opened).toEqual([r.file]); // opened after it was made, not before
    expect(r.commandsRun).toEqual([]);
    const main = fs.readFileSync(path.join(REPO_ROOT, "src", "main.ts"), "utf8");
    expect(main).toMatch(/\n  async openCodeFile\(file: string[,)]/); // public: the helper calls it
    expect(main).toContain("open a code file first"); // what open-spike-file does with no code file in the vault
  });

  it("the default Code tab script leaves a file that is already in the vault as it is, and says so when the plugin is not there", async () => {
    const r = await runDefaultCodeTab({ existing: true });
    expect(r.files.get(r.file)).toBe("already here");
    expect(r.opened).toEqual([r.file]);
    expect((await runDefaultCodeTab({ plugin: "none" })).answer).toBe("no plugin");
  });

  it("never prints a connection token: the ambiguity message hides tkn=", () => {
    const targets = [{ id: "A", url: "http://127.0.0.1:1/?tkn=SECRET&folder=/v", title: "a" }, { id: "B", url: "http://127.0.0.1:1/?folder=/v&tkn=SECRET2", title: "b" }];
    const CODE = { win: [1400, 900], panel: null };
    const r = py<{ err: string; red: string }>(
      `try:\n    m.pick_targets(a["targets"], {"A": a["CODE"], "B": a["CODE"]})\n    err = ""\nexcept m.CannotRun as e:\n    err = str(e)\nprint(json.dumps({"err": err, "red": m.redact_url("http://h/?tkn=abc&folder=/x")}))`,
      { targets, CODE },
    );
    expect(r.err).toContain("[0] http://127.0.0.1:1/?tkn=(hidden)");
    expect(r.err).not.toContain("SECRET");
    expect(r.red).toBe("http://h/?tkn=(hidden)&folder=/x");
  });

  const go = (window: string, extra = "", wait = 0) => `
world = w.World()
win = ${window}
env = win.env()
rep = m.Reporter(echo=False)
${extra}
async def go():
    await m.run_open_page(env, rep, win, w.args(world, wait=${wait}${extra.includes("pidfile =") ? ", pidfile=pidfile" : ""}), world.out)
try:
    w.run(go())
    err = None
except m.CannotRun as e:
    err = str(e)
print(json.dumps({"fails": rep.fails, "lines": rep.lines, "err": err, "scripts": [s[0] for s in win.scripts], "code": [s[1] for s in win.scripts if s[0] == "code-tab"], "shots": [os.path.basename(s) for s in win.page.shots]}, ensure_ascii=False))`;

  it("opens the Code tab, then the page; finds the new webview, opens the panel with the keys, and passes with the page panel-only in its own partition", () => {
    const r = py<any>(go("w.FakeWindow(world)"));
    expect(r.err).toBeNull();
    expect(r.fails).toEqual([]);
    expect(r.scripts).toEqual(["code-tab", "page"]);
    expect(r.code[0]).toContain("openCodeFile");
    expect(r.shots).toEqual(["shot-0-container-page-opened.png"]);
    const text = (r.lines as string[]).join("\n");
    expect(text).toContain("PASS  a Code tab is open");
    expect(text).toContain("PASS  E3: the page is a <webview> in its own partition, not persist:vscode-workbench");
    expect(text).toContain("PASS  exactly one workbench webview target is the page");
    expect(text).toContain("PASS  S1: in the container's webview, every other part measures 0 px");
    expect(text).not.toContain("SECRET");
  });

  it("--code-file names the Code tab's file; the pidfile line passes only when the plugin's pidfile names a live vscode-server", () => {
    const body = `
pidfile = os.path.join(world.out, "pids.json")
json.dump([{"pid": w.SERVER_PID, "label": "vscode-server"}], open(pidfile, "w"))`;
    const r = py<any>(go("w.FakeWindow(world)", body).replace("wait=0, pidfile=pidfile", 'wait=0, pidfile=pidfile, code_file="notes/a b.py"'));
    expect(r.fails).toEqual([]);
    expect(r.code[0]).toContain("setViewState");
    expect(r.code[0]).toContain("notes/a b.py");
    expect((r.lines as string[]).join("\n")).toContain("PASS  the plugin's pidfile names the live vscode-server");
    const none = py<any>(go("w.FakeWindow(world)", `pidfile = os.path.join(world.out, "missing.json")`));
    expect(none.fails).toEqual(["the plugin's pidfile names the live vscode-server"]);
  });

  it("stops with a plain message (exit 2) when the plugin is not loaded, and when the server does not start, naming the licence prompt", () => {
    const notLoaded = py<any>(go("w.FakeWindow(world, loaded=False)"));
    expect(notLoaded.err).toContain("run `trust-plugins` first");
    expect(notLoaded.scripts).toEqual([]);
    const noServer = py<any>(go("w.FakeWindow(world, page_status='no-server')"));
    expect(noServer.err).toContain("the plugin's server did not start");
    expect(noServer.err).toContain("licence prompt");
  });

  it("an already-docked page starts nothing and checks nothing", () => {
    const r = py<any>(go("w.FakeWindow(world, page_status='already-open')"));
    expect(r.fails).toEqual([]);
    expect((r.lines as string[]).join("\n")).toContain("the terminal page is already docked");
    expect(r.shots).toEqual([]);
  });

  it("fails, by name, a Code tab that never appears, a partition shared with the Code tabs, a seed that did not apply, and a page that is not panel-only", () => {
    // T56: with no Code tab the layout guard FAILs by name too; it cannot pass by finding nothing to measure
    expect(py<any>(go("w.FakeWindow(world, code_target=False)")).fails).toEqual(["a Code tab is open: a workbench webview in the default partition", "S1: a Code tab beside the terminal page keeps its layout"]);
    expect(py<any>(go("w.FakeWindow(world, partition='persist:vscode-workbench')")).fails).toEqual(["E3: the page is a <webview> in its own partition, not persist:vscode-workbench"]);
    expect(py<any>(go("w.FakeWindow(world, seed='version-mismatch')")).fails[0]).toContain("the panel-only settings");
    expect(py<any>(go("w.FakeWindow(world, panel=w.CODE_TAB)")).fails).toEqual(["S1: in the container's webview, every other part measures 0 px and the panel fills the window"]);
    expect(py<any>(go("w.FakeWindow(world, page_target=False)")).fails).toEqual(["exactly one workbench webview target is the page (it carries the page's own settings; a Code tab's partition does not)"]);
  });

  it("with --no-code-tab no Code tab is opened", () => {
    const r = py<any>(go("w.FakeWindow(world)").replace("wait=0", "wait=0, no_code_tab=True"));
    expect(r.scripts).toEqual(["page"]);
    expect(r.fails).toEqual([]);
  });

  it("T44: a Code tab that goes through two webviews (Welcome, then the file) is not counted as a second page: the page is the one in its own partition", () => {
    const r = py<any>(go("w.FakeWindow(world, late_code=True)"));
    expect(r.err).toBeNull();
    expect(r.fails).toEqual([]);
    const text = (r.lines as string[]).join("\n");
    expect(text).toContain("PASS  exactly one workbench webview target is the page");
    expect(text).toContain("the Code tab settled: 2 workbench webview target(s) listed");
    expect(text).toContain("PASS  S1: in the container's webview");
  });

  it("T44: a Code tab that was open before the run still counts as a Code tab, and a Code tab that adds a webview after the page opened is not mistaken for the page", () => {
    const r = py<any>(go("w.FakeWindow(world, late_code=True)").replace("env = win.env()", "win.targets.append({'id': 'code-0', 'type': 'webview', 'url': 'http://127.0.0.1:5000/?folder=%2Fv', 'webSocketDebuggerUrl': 'ws://x/code-0'})\nenv = win.env()"));
    expect(r.fails).toEqual([]);
    expect((r.lines as string[]).join("\n")).toContain("PASS  a Code tab is open");
  });

  it("T51: open-page measures the Code tab's layout before the page is opened and again after its layout was made; a changed Code tab is a FAIL by name, and a leftover page of an earlier run is not taken for a Code tab", () => {
    const r = py<any>(go("w.FakeWindow(world)"));
    expect(r.fails).toEqual([]);
    const text = (r.lines as string[]).join("\n");
    expect(text).toContain("INFO  Code tabs before: code-1: ");
    expect(text).toContain("PASS  S1: Code tab code-1 has the same side bar, panel and layout before and after");
    expect(text.indexOf("Code tabs before")).toBeLessThan(text.indexOf("PASS  E3"));
    expect(text.indexOf("PASS  S1: in the container's webview")).toBeLessThan(text.indexOf("PASS  S1: Code tab code-1"));
    const changed = py<any>(go("w.FakeWindow(world, code_changes=True)"));
    expect(changed.fails).toEqual(["S1: Code tab code-1 has the same side bar, panel and layout before and after"]);
    const leftover = py<any>(go("w.FakeWindow(world)").replace("env = win.env()", "win.targets.append({'id': 'term-0', 'type': 'webview', 'url': 'http://127.0.0.1:5000/?folder=%2Fv', 'webSocketDebuggerUrl': 'ws://x/term-0'})\nenv = win.env()"));
    expect((leftover.lines as string[]).join("\n")).not.toContain("Code tab term-0");
    const none = py<any>(go("w.FakeWindow(world)").replace("wait=0", "wait=0, no_code_tab=True"));
    expect((none.lines as string[]).join("\n")).not.toContain("Code tabs before");
  });

  it("T51: the Code tab is still measured after the page when the page did not paint, and when the page could not be told from a Code tab", () => {
    const blank = py<any>(go("w.FakeWindow(world, page_target=False)"));
    expect(blank.fails).toEqual(["exactly one workbench webview target is the page (it carries the page's own settings; a Code tab's partition does not)", ]);
    expect((blank.lines as string[]).join("\n")).toContain("PASS  S1: Code tab code-1");
    const moved = py<any>(go("w.FakeWindow(world, page_target=False, code_changes=True)"));
    expect(moved.fails).toContain("S1: Code tab code-1 has the same side bar, panel and layout before and after");
  });

  it("T56: a Code tab whose partition cannot be read is still measured (it is not the page, which is not open yet), and says so", () => {
    const r = py<any>(go("w.FakeWindow(world)").replace("env = win.env()", `env = win.env()
_connect = env.connect
async def connect(t):
    p = await _connect(t)
    if not t["id"].startswith("term"):
        _ev = p.ev
        async def ev(expr, timeout=30):
            return "ERROR TypeError: not readable" if expr == m.PAGE_MARK_JS else await _ev(expr, timeout)
        p.ev = ev
    return p
env.connect = connect`));
    expect(r.fails).toEqual([]);
    const text = (r.lines as string[]).join("\n");
    expect(text).toContain("INFO  Code tabs before: code-1: ");
    expect(text).toContain("counted as a Code tab because the terminal page is not open yet");
    expect(text).toContain("PASS  S1: Code tab code-1 has the same side bar, panel and layout before and after");
  });

  it("T56: a Code tab webview that cannot be connected to is a FAIL by name, and a Code tab that is open is measured even when the page was already docked", () => {
    const r = py<any>(go("w.FakeWindow(world)").replace("env = win.env()", `env = win.env()
_connect = env.connect
async def connect(t):
    if t["id"] == "code-1":
        raise ConnectionError("refused")
    return await _connect(t)
env.connect = connect`));
    expect(r.fails).toContain("S1: Code tab code-1 can be connected to and measured");
    expect(r.fails).toContain("S1: a Code tab beside the terminal page keeps its layout");
    const docked = py<any>(go("w.FakeWindow(world, page_status='already-open')"));
    expect(docked.fails).toEqual([]);
    expect((docked.lines as string[]).join("\n")).toContain("PASS  S1: Code tab code-1 has the same side bar, panel and layout before and after");
  });

  it("T56: --no-code-tab skips the guard on purpose (no FAIL, no 'Code tabs before'); without the flag every listed Code tab is measured", () => {
    const none = py<any>(go("w.FakeWindow(world)").replace("wait=0", "wait=0, no_code_tab=True"));
    expect(none.fails).toEqual([]);
    expect((none.lines as string[]).join("\n")).not.toContain("S1: a Code tab beside");
    const two = py<any>(go("w.FakeWindow(world, late_code=True)"));
    expect(two.fails).toEqual([]);
    const text = (two.lines as string[]).join("\n");
    expect(text).toContain("PASS  S1: Code tab code-1 has the same side bar");
    expect(text).toContain("PASS  S1: Code tab code-2 has the same side bar");
  });

  it("T44: two webviews in the page's partition are not one page", () => {
    const r = py<any>(go("w.FakeWindow(world)").replace("env = win.env()", "win.targets.append({'id': 'term-0', 'type': 'webview', 'url': 'http://127.0.0.1:5000/?folder=%2Fv', 'webSocketDebuggerUrl': 'ws://x/term-0'})\nenv = win.env()"));
    expect(r.fails).toContain("exactly one workbench webview target is the page (it carries the page's own settings; a Code tab's partition does not)");
  });

  describe("T34: the licence prompt of a first run holds the server back until it is accepted", () => {
    const withLicence = (opts: string, accept: boolean) => py<any>(go(`w.FakeWindow(world, licence_modal=True${opts})`).replace("wait=0", `wait=0, accept_licence=${accept ? "True" : "False"}`));

    it("without --accept-licence it stops with exit 2 and says which flag gets past the prompt; nothing is armed", () => {
      const r = withLicence("", false);
      expect(r.err).toContain("the plugin's server did not start");
      expect(r.err).toContain("--accept-licence");
      expect(r.scripts).toEqual(["code-tab", "page"]);
      expect((r.lines as string[]).join("\n")).toContain("FAIL  a Code tab is open");
    });

    it("with --accept-licence it arms the window's timer first, runs the whole open-page, and stops the timer after, saying how often it pressed", () => {
      const r = withLicence("", true);
      expect(r.err).toBeNull();
      expect(r.fails).toEqual([]);
      expect(r.scripts).toEqual(["arm-licence", "code-tab", "page", "disarm-licence"]);
      const text = (r.lines as string[]).join("\n");
      expect(text).toContain('INFO  licence prompt: "Accept and download" was pressed 1 time(s)');
      expect(text).toContain("PASS  S1: in the container's webview");
    });

    it("with --accept-licence and no prompt (already accepted) it presses nothing and says so", () => {
      const r = py<any>(go("w.FakeWindow(world)").replace("wait=0", "wait=0, accept_licence=True"));
      expect(r.fails).toEqual([]);
      expect((r.lines as string[]).join("\n")).toContain("was pressed 0 time(s) (no prompt appeared: already accepted)");
    });

    it("stops the timer even when open-page ends early (exit 2), and does not arm one at all for a plugin that is not loaded", () => {
      const early = py<any>(go("w.FakeWindow(world, page_status='no-server')").replace("wait=0", "wait=0, accept_licence=True"));
      expect(early.err).toContain("the plugin's server did not start");
      expect(early.scripts).toEqual(["arm-licence", "code-tab", "page", "disarm-licence"]);
      const notLoaded = py<any>(go("w.FakeWindow(world, loaded=False)").replace("wait=0", "wait=0, accept_licence=True"));
      expect(notLoaded.err).toContain("run `trust-plugins` first");
      expect(notLoaded.scripts).toEqual([]);
    });

    /** The timer scripts run for real in a jsdom window with Obsidian-shaped modals (h2, p, .modal-button-container, buttons). */
    async function armed(modals: string[], pressAfterMs = 0) {
      const arm = py<string>("print(json.dumps(m.accept_licence_js(5000, 10)))");
      const disarm = py<string>("print(json.dumps(m.disarm_licence_js()))");
      const jsdom = "jsdom";
      const { JSDOM } = (await import(jsdom)) as { JSDOM: new (html: string, o: Record<string, unknown>) => { window: unknown } };
      const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only", url: "app://obsidian.md/index.html" });
      const w = dom.window as unknown as Record<string, any>;
      const clicks: string[] = [];
      const add = () => {
        for (const html of modals) {
          const el = w.document.createElement("div");
          el.className = "modal";
          el.innerHTML = html;
          for (const b of el.querySelectorAll("button")) b.addEventListener("click", () => { clicks.push(b.textContent); el.remove(); });
          w.document.body.appendChild(el);
        }
      };
      const first = w.eval(arm);
      const again = w.eval(arm);
      if (pressAfterMs) await new Promise((r) => setTimeout(r, pressAfterMs));
      add();
      await new Promise((r) => setTimeout(r, 80));
      const result = JSON.parse(w.eval(disarm));
      const after = JSON.parse(w.eval(disarm));
      return { first, again, clicks, result, after, left: w.document.querySelectorAll(".modal").length };
    }
    const LICENCE = `<h2>VS Code server licence</h2><p>Code tabs run ...</p><div class="modal-button-container"><button>Decline</button><button class="mod-cta">Accept and download</button></div>`;

    it("the window timer presses Accept (and only Accept) on the licence modal, once, and leaves other modals alone", async () => {
      const other = `<h2>Something else</h2><div class="modal-button-container"><button>Accept and download</button><button>Decline</button></div>`;
      const r = await armed([other, LICENCE], 30);
      expect(r.first).toBe("armed");
      expect(r.again).toBe("already armed");
      expect(r.clicks).toEqual(["Accept and download"]);
      expect(r.left).toBe(1); // the other modal is still up
      expect(r.result).toEqual({ armed: true, pressed: 1 });
      expect(r.after).toEqual({ armed: false, pressed: 0 });
    });

    it("never presses Decline: a licence modal without the Accept button is left as it is", async () => {
      const r = await armed([`<h2>VS Code server licence</h2><div class="modal-button-container"><button>Decline</button></div>`]);
      expect(r.clicks).toEqual([]);
      expect(r.result).toEqual({ armed: true, pressed: 0 });
    });

    it("its text is the plugin's own: src/modals.ts has that title and that button, and the Accept choice is the one that resolves true", () => {
      const src = fs.readFileSync(path.join(REPO_ROOT, "src", "modals.ts"), "utf8");
      const r = py<{ title: string; accept: string }>('print(json.dumps({"title": m.LICENCE_MODAL_TITLE, "accept": m.LICENCE_ACCEPT_TEXT}))');
      expect(src).toContain(`title: "${r.title}"`);
      expect(src).toContain(`{ label: "${r.accept}", value: true, cta: true }`);
    });

    it("is a flag of open-page on the command line, off by default, and the docs say so", () => {
      const help = spawnSync("python3", [HELPER, "open-page", "--help"], { encoding: "utf8" });
      expect(help.stdout).toContain("--accept-licence");
      const doc = fs.readFileSync(path.join(REPO_ROOT, "docs", "terminal-spike.md"), "utf8");
      expect(doc).toContain("--accept-licence");
    });
  });

  it("is a mode of the command line, exits 2 when no Obsidian window answers, and the docs name it", () => {
    const run = spawnSync("python3", [HELPER, "open-page", "--vault", os.tmpdir(), "--cdp", "http://127.0.0.1:1", "--out-dir", tempDir("ctc-cli-")], { encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("CANNOT RUN: cannot read http://127.0.0.1:1/json/list");
    const doc = fs.readFileSync(path.join(REPO_ROOT, "docs", "terminal-spike.md"), "utf8");
    expect(doc).toContain("container-terminal-check.py open-page");
    expect(doc).toContain("persist:vscode-workbench-terminal-spike");
  });
});

describe("T37: the panel-only page opens in the Code tab's profile (trust record) and the layout keys are checked, not assumed", () => {
  const VAULTS = ["/config/w37/vault", "/config/w37/vault with spaces/估计 vault/", "/Users/dan/My Vault"];

  it.each(VAULTS)("the helper's trust seed is byte for byte the plugin's buildTrustSeedScript for %s", async (vault) => {
    const { buildTrustSeedScript } = await import("../../src/trust/trust-seed");
    const { buildFileUri } = await import("../../src/paths");
    const origin = "http://127.0.0.1:45123";
    const ours = py<string>(`print(json.dumps(m.build_trust_script(m.trust_entry("127.0.0.1:45123", a["vault"]))))`, { vault });
    expect(ours).toBe(buildTrustSeedScript({ origin, folderUri: buildFileUri(origin, vault), heldPorts: [] }));
  });

  it("the database, store and key the helper names are the plugin's", async () => {
    const t = await import("../../src/trust/trust-seed");
    expect(py(`print(json.dumps(m.TRUST_DB))`)).toEqual({ name: t.TRUST_DB_NAME, store: t.TRUST_STORE, key: t.TRUST_KEY });
  });

  async function pageRun(opts: { trust?: boolean; trustOutcome?: string }) {
    const VAULT = "/config/w37/vault with spaces/估计 vault";
    const script = py<string>(`print(json.dumps(m.open_page_js(m.PLUGIN_ID, a["vault"], "SEED_SCRIPT_MARKER", 30000, 3000, m.trust_script_template())))`, { vault: VAULT });
    const jsdom = "jsdom";
    const { JSDOM } = (await import(jsdom)) as { JSDOM: new (html: string, o: Record<string, unknown>) => { window: unknown } };
    const w = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only", url: "app://obsidian.md/index.html" }).window as unknown as Record<string, any>;
    const log: string[] = [];
    const createElement = w.document.createElement.bind(w.document);
    w.document.createElement = (tag: string) => {
      const el = createElement(tag);
      if (tag !== "webview") return el;
      el.executeJavaScript = async (code: string) => { log.push(code); return code.includes("content.trust.model.key") ? (opts.trustOutcome ?? "seeded") : "seeded"; };
      const set = el.setAttribute.bind(el);
      el.setAttribute = (k: string, v: string) => { set(k, v); if (k === "src" && log.length === 0 && !el.__fired) { el.__fired = true; setTimeout(() => el.dispatchEvent(new w.Event("dom-ready")), 5); } };
      return el;
    };
    const server = { baseUrl: "http://127.0.0.1:45123", port: 45123, token: "tok-SECRET-123" };
    w.app = { plugins: { plugins: { "obsidian-vscode-workbench": { ensureServer: () => Promise.resolve(server) } } } };
    return { result: JSON.parse(await w.eval(script)), log, VAULT, server };
  }

  it("the page script writes the vault's trust record in the same page right after the settings, the way a Code tab does, and reports the outcome", async () => {
    const { buildTrustSeedScript } = await import("../../src/trust/trust-seed");
    const { buildFileUri } = await import("../../src/paths");
    const r = await pageRun({});
    expect(r.log).toEqual(["SEED_SCRIPT_MARKER", buildTrustSeedScript({ origin: r.server.baseUrl, folderUri: buildFileUri(r.server.baseUrl, r.VAULT), heldPorts: [] })]);
    expect(r.result).toMatchObject({ status: "opened", ready: true, seed: "seeded", trust: "seeded" });
    expect(JSON.stringify(r.result)).not.toContain("SECRET");
    expect((await pageRun({ trustOutcome: "version-mismatch" })).result.trust).toBe("version-mismatch");
  });

  it("open-page fails by name when the trust record was not written", () => {
    const r = py<any>(`
world = w.World()
win = w.FakeWindow(world, trust="version-mismatch")
env = win.env()
rep = m.Reporter(echo=False)
w.run(m.run_open_page(env, rep, win, w.args(world), world.out))
print(json.dumps({"fails": rep.fails}))`);
    expect(r.fails).toHaveLength(1);
    expect(r.fails[0]).toContain("Workspace Trust record");
  });

  const PANEL = (page: string, extra = "") => `
world = w.World()
page = ${page}
env = w.FakeWindow(world, page=page).env()
rep = m.Reporter(echo=False)
${extra}
lay = w.run(m.make_panel_only(env, page, rep))
print(json.dumps({"panel_only": m.panel_only(lay), "info": rep.lines, "pressed": page.pressed, "lay": page.lay, "events": page.events, "mod": m.SIDEBAR_MOD, "alt": m.ALT}))`;

  it("opens the panel and hides the side bar with the two keys when nothing is in the way", () => {
    const r = py<any>(PANEL('w.FakePage(world, w.SIDE_BAR_SHOWING, keys_work=True)'));
    expect(r.panel_only).toBe(true);
    expect(r.info).toEqual([]);
  });

  /** What the page was sent, in order, as short strings: "press sidebar", "key KeyB". */
  const sent = (r: any) => (r.events as any[]).map((e) => (e[0] === "key" ? `key ${e[1]}${e[2] === 2 ? "+ctrl" : e[2] === r.mod ? "+side" : e[2] === (r.mod | r.alt) ? "+side+alt" : `+${e[2]}`}` : `${e[0]} ${e[1]}`));

  it("T50: the bars are hidden first, each with a press inside that bar, the panel is opened last with a press on the editor, and nothing is pressed at the window centre", () => {
    const r = py<any>(PANEL("w.FakePage(world, w.SIDE_BAR_SHOWING, keys_work=True, needs_real_click=True)"));
    expect(r.panel_only).toBe(true);
    expect(r.info).toEqual([]);
    expect(sent(r)).toEqual(["press sidebar", `key KeyB${r.mod === 2 ? "+ctrl" : "+side"}`, "press auxiliarybar", "key KeyB+side+alt", "press editor", "key Backquote+ctrl"]);
    expect((r.events as any[]).filter((e) => e[0] === "press-center")).toEqual([]);
  });

  it("T50: no press is ever dispatched at the centre while the panel is open, or on the panel: with the panel already open the bars are still hidden by presses inside them", () => {
    const open = `{**w.SIDE_BAR_SHOWING, "panel": [508, 300]}`;
    const r = py<any>(PANEL(`w.FakePage(world, ${open}, keys_work=True, needs_real_click=True)`));
    expect(r.lay.sidebar[0]).toBe(0);
    expect(r.lay.auxiliarybar[0]).toBe(0);
    expect(sent(r)).toEqual(["press sidebar", expect.stringMatching(/^key KeyB/), "press auxiliarybar", "key KeyB+side+alt"]);
    expect((r.events as any[]).filter((e) => e[0] === "press-center" || (e[0] === "press" && e[1] === "panel"))).toEqual([]);
  });

  it("T50: a step whose outcome already holds is skipped: nothing is pressed or sent for a page that is panel-only, and a hidden bar is not pressed", () => {
    expect(py<any>(PANEL("w.FakePage(world, w.PANEL_ONLY, keys_work=True, needs_real_click=True)")).events).toEqual([]);
    const aux = `{**w.SIDE_BAR_SHOWING, "sidebar": [0, 892]}`;
    const r = py<any>(PANEL(`w.FakePage(world, ${aux}, keys_work=True, needs_real_click=True)`));
    expect(sent(r)).toEqual(["press auxiliarybar", "key KeyB+side+alt", "press editor", "key Backquote+ctrl"]);
    expect(r.panel_only).toBe(true);
  });

  it("T50: a key that was swallowed is tried again after a new press in the same part, never at the centre", () => {
    const r = py<any>(PANEL("w.FakePage(world, w.SIDE_BAR_SHOWING, keys_work=True, needs_real_click=True, drop_keys=2)"));
    expect(r.panel_only).toBe(true);
    expect(sent(r)).toEqual([
      "press sidebar", expect.stringMatching(/^key KeyB/), "press sidebar", expect.stringMatching(/^key KeyB/), "press sidebar", expect.stringMatching(/^key KeyB/),
      "press auxiliarybar", "key KeyB+side+alt", "press editor", "key Backquote+ctrl",
    ]);
    expect((r.events as any[]).filter((e) => e[0] === "press-center")).toEqual([]);
  });

  it("T50: a page that takes the keys only when pressed inside a part gets nowhere if the helper never presses (the keys stay swallowed)", () => {
    const none = py<any>(PANEL("w.FakePage(world, w.SIDE_BAR_SHOWING, keys_work=True, needs_real_click=True)").replace("lay = w.run", "async def no_press(selector): return False\npage.click_part = no_press\nlay = w.run"));
    expect(none.panel_only).toBe(false);
    expect((none.info as string[]).join("\n")).toContain("pressed in no part: none of .part.sidebar is showing");
  });

  it("T50: the pressed part is looked up in the page: the middle of the part, or nothing when it is absent or 0 px (the script run in jsdom with a stubbed getBoundingClientRect)", async () => {
    const jsdom = "jsdom";
    const { JSDOM } = (await import(jsdom)) as { JSDOM: new (html: string, o: Record<string, unknown>) => { window: unknown } };
    const w = new JSDOM('<body><div class="part sidebar"></div><div class="part panel"></div></body>', { runScripts: "outside-only" }).window as unknown as Record<string, any>;
    w.document.querySelector(".part.sidebar").getBoundingClientRect = () => ({ left: 10, top: 20, width: 101, height: 50 });
    w.document.querySelector(".part.panel").getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 300 });
    const js = (sel: string) => py<string>(`print(json.dumps(m.part_center_js(a["sel"])))`, { sel });
    expect(JSON.parse(w.eval(js(".part.sidebar")))).toEqual([61, 45]);
    expect(w.eval(js(".part.panel"))).toBeNull();
    expect(w.eval(js(".part.auxiliarybar"))).toBeNull();
  });

  it("T50: click_part sends mouseMoved, mousePressed and mouseReleased through CDP at the middle of the part it was told; a part that is not showing is not pressed", () => {
    const r = py<any>(`
class Cdp:
    def __init__(self, answer): self.sent = []; self.answer = answer
    async def send(self, method, params=None, timeout=30):
        self.sent.append((method, params))
        return {"result": {"value": self.answer}} if method == "Runtime.evaluate" else {}
shown, hidden_ = Cdp(json.dumps([61, 45])), Cdp(None)
got = [w.run(m.Page(shown, "p").click_part(".part.sidebar")), w.run(m.Page(hidden_, "p").click_part(".part.sidebar"))]
print(json.dumps({"got": got, "shown": shown.sent, "hidden": hidden_.sent}))`);
    expect(r.got).toEqual([true, false]);
    expect(r.shown[0][1].expression).toContain('".part.sidebar"');
    expect(r.shown.slice(1).map((c: any) => [c[0], c[1].type, c[1].x, c[1].y, c[1].button])).toEqual([
      ["Input.dispatchMouseEvent", "mouseMoved", 61, 45, "none"], ["Input.dispatchMouseEvent", "mousePressed", 61, 45, "left"], ["Input.dispatchMouseEvent", "mouseReleased", 61, 45, "left"],
    ]);
    expect(r.hidden.map((c: any) => c[0])).toEqual(["Runtime.evaluate"]);
  });

  it("T50: make_panel_only in the helper does not call click_center at all (a press at the centre is the terminal once the panel is open)", () => {
    const src = fs.readFileSync(HELPER, "utf8");
    const body = src.slice(src.indexOf("async def make_panel_only"), src.indexOf("def folders_for"));
    expect(body).not.toContain("click_center");
    expect(body).toContain("click_part");
  });

  it("T45: click_center sends mouseMoved, mousePressed and mouseReleased through CDP Input.dispatchMouseEvent at the centre of the window, and never a DOM click", () => {
    const r = py<any>(`
class Cdp:
    def __init__(self): self.sent = []
    async def send(self, method, params=None, timeout=30):
        self.sent.append((method, params))
        if method == "Runtime.evaluate":
            return {"result": {"value": json.dumps([1016, 323])}}
        return {}
cdp = Cdp()
w.run(m.Page(cdp, "p").click_center())
print(json.dumps(cdp.sent))`);
    expect(r.map((c: any) => c[0])).toEqual(["Runtime.evaluate", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent"]);
    expect(r.slice(1).map((c: any) => [c[1].type, c[1].x, c[1].y, c[1].button])).toEqual([["mouseMoved", 508, 161, "none"], ["mousePressed", 508, 161, "left"], ["mouseReleased", 508, 161, "left"]]);
    expect(r[0][1].expression).not.toContain(".click()");
    const src = fs.readFileSync(HELPER, "utf8");
    expect(src).not.toContain('page.ev("document.body.click()")');
  });

  it("T44/T46: the partition script says 'page' for a database whose settings carry the terminal-page key, 'other' for a Code tab's, and creates nothing (jsdom, stubbed IndexedDB)", async () => {
    const jsdom = "jsdom";
    const { JSDOM } = (await import(jsdom)) as { JSDOM: new (html: string, o: Record<string, unknown>) => { window: unknown } };
    const { js, name, store, key } = py<{ js: string; name: string; store: string; key: string }>(`print(json.dumps({"js": m.PAGE_MARK_JS, "name": m.WORKBENCH_DB["name"], "store": m.WORKBENCH_DB["store"], "key": m.WORKBENCH_DB["settingsKey"]}))`);
    const run = async (opts: { exists: boolean; value?: unknown; hasStore?: boolean }) => {
      const w = new JSDOM("<body></body>", { runScripts: "outside-only" }).window as unknown as Record<string, any>;
      const created: string[] = [];
      w.TextDecoder = TextDecoder;
      w.indexedDB = {
        open: (n: string) => {
          expect(n).toBe(name); // no version asked for: nothing is upgraded
          const r: any = {};
          setTimeout(() => {
            if (!opts.exists) { created.push(n); r.transaction = { abort: () => setTimeout(() => { r.error = { name: "AbortError" }; r.onerror?.(); }, 0) }; r.onupgradeneeded?.(); return; }
            r.result = {
              objectStoreNames: { contains: (s: string) => s === store && opts.hasStore !== false },
              transaction: () => ({ objectStore: () => ({ get: (k: string) => { expect(k).toBe(key); const q: any = {}; setTimeout(() => { q.result = opts.value; q.onsuccess?.(); }, 0); return q; } }) }),
              close: () => {},
            };
            r.onsuccess?.();
          }, 0);
          return r;
        },
      };
      const answer = await w.eval(js);
      return { answer, created };
    };
    const bytes = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
    expect((await run({ exists: true, value: bytes({ "obsidianWorkbench.terminalPage": true, "workbench.panel.opensMaximized": "always" }) })).answer).toBe("page");
    expect((await run({ exists: true, value: JSON.stringify({ "obsidianWorkbench.terminalPage": true }) })).answer).toBe("page");
    expect((await run({ exists: true, value: bytes({ "workbench.colorTheme": "Default" }) })).answer).toBe("other");
    expect((await run({ exists: true, value: undefined })).answer).toBe("other");
    expect((await run({ exists: true, hasStore: false })).answer).toBe("other");
    expect((await run({ exists: true, value: "{not json" })).answer).toBe("unreadable");
    const fresh = await run({ exists: false });
    expect(fresh.answer).toBe("other");
    const src = fs.readFileSync(HELPER, "utf8");
    expect(src).not.toMatch(/PAGE_MARK_JS[^\n]*readwrite/);
    expect(js).not.toContain("readwrite");
    expect(js).not.toContain("createObjectStore");
  });

  it("a Workspace Trust question that blocks the keys is answered 'Yes, I trust' and then the keys work", () => {
    const dialog = `{"dialog": "Do you trust the authors of the files in this folder?", "buttons": ["Yes, I trust the authors", "No, I don't trust the authors"]}`;
    const r = py<any>(PANEL(`w.FakePage(world, w.SIDE_BAR_SHOWING, keys_work=True, dialog=${dialog})`));
    expect(r.pressed).toEqual(["trust"]);
    expect(r.panel_only).toBe(true);
    expect((r.info as string[]).join("\n")).toContain("a modal dialog is up in the page");
    expect((r.info as string[]).join("\n")).toContain("Do you trust the authors");
  });

  it("any other dialog is reported with its text and buttons and is never pressed; the layout stays as it was", () => {
    const dialog = `{"dialog": "Delete everything?", "buttons": ["Yes, I trust nothing", "Cancel"]}`;
    const r = py<any>(PANEL(`w.FakePage(world, w.SIDE_BAR_SHOWING, keys_work=True, dialog=${dialog})`));
    expect(r.pressed).toEqual([]);
    expect(r.panel_only).toBe(false);
    const text = (r.info as string[]).join("\n");
    expect(text).toContain("not a trust question");
    expect(text).toContain("Delete everything?");
    expect(text).toContain("after 3 tries the panel key did not change the layout");
  });

  it("keys that change nothing are tried three times, then the page's state is reported for the panel and the side bar", () => {
    const r = py<any>(PANEL("w.FakePage(world, w.SIDE_BAR_SHOWING, keys_work=False)"));
    expect(r.panel_only).toBe(false);
    const text = (r.info as string[]).join("\n");
    expect(text).toContain("after 3 tries the panel key did not change the layout (pressed in .part.editor before the key): no modal dialog; focus in body");
    expect(text).toContain("after 3 tries the sidebar key did not change the layout");
    expect(text).toContain("after 3 tries the auxiliarybar key did not change the layout");
  });

  it("the page-state script reads the dialog the way VS Code draws it (jsdom)", async () => {
    const jsdom = "jsdom";
    const { JSDOM } = (await import(jsdom)) as { JSDOM: new (html: string, o: Record<string, unknown>) => { window: unknown } };
    const html = `<body><div class="monaco-dialog-modal-block"><div class="monaco-dialog-box"><div class="dialog-message">Do you trust the authors?</div>
      <div class="dialog-buttons"><a class="monaco-button">Yes, I trust the authors</a><a class="monaco-button">No, I don't trust the authors</a></div></div></div></body>`;
    const w = new JSDOM(html, { runScripts: "outside-only" }).window as unknown as Record<string, any>;
    const { state, press } = py<{ state: string; press: string }>(`print(json.dumps({"state": m.PAGE_STATE_JS, "press": m.PRESS_TRUST_JS}))`);
    const st = JSON.parse(w.eval(state));
    expect(st).toMatchObject({ blocked: true, buttons: ["Yes, I trust the authors", "No, I don't trust the authors"] });
    expect(st.dialog).toContain("Do you trust the authors?");
    let clicked = "";
    for (const a of w.document.querySelectorAll(".dialog-buttons a")) a.addEventListener("click", () => (clicked = a.textContent));
    expect(w.eval(press)).toBe("pressed");
    expect(clicked).toBe("Yes, I trust the authors");
    expect(w.eval(`document.body.innerHTML = ''; ${press}`)).toBe("no dialog");
  });
});

describe("T38: a terminal page that does not paint after the reload says which target it reloaded and what PAINTED_JS saw", () => {
  const go = (term: string, env = "", tail = "") => `
world = w.World()
term = ${term}
codes = {"[1] code": w.FakePage(world, w.CODE_TAB, name="code-1")}
env = world.env()
${env}
rep = m.Reporter(echo=False)
async def go():
    await m.run_terminal_at(env, rep, w.args(world), term, codes, {"pid": w.SERVER_PID, "data_dir": world.data}, m.__file__.replace("container-terminal-check.py", "terminal-at-extension.cjs"), world.out)
    await asyncio.gather(*[p.close() for p in env.extra_pages])
w.run(go())
${tail}
print(json.dumps({"fails": rep.fails, "lines": rep.lines, "navigated": term.navigated, "extra": len(env.extra_pages), "slept": getattr(env, "slept", 0)}, ensure_ascii=False))`;

  it("a page that paints after the reload costs nothing extra: one reload, no navigation, no extra lines", () => {
    const r = py<any>(go("w.FakePage(world, w.PANEL_ONLY)"));
    expect(r.fails).toEqual([]);
    expect(r.navigated).toEqual([]);
    expect((r.lines as string[]).filter((l) => l.includes("did not paint"))).toEqual([]);
    expect((r.lines as string[]).some((l) => l.includes("reloading target term-1"))).toBe(true);
  });

  it("a page that stays blank: FAIL by name, with the target reloaded, what PAINTED_JS saw (address without the token, parts, text) and the targets listed", () => {
    const env = `env.list_webviews = lambda: [{"id": "term-1", "type": "webview", "url": "http://127.0.0.1:45123/?tkn=SECRET-TOKEN&folder=%2Fv", "title": ""}]`;
    const r = py<any>(go('w.FakePage(world, w.PANEL_ONLY, blank_after_reload="never")', env));
    expect(r.fails).toEqual(["the terminal page painted again after the reload"]);
    const text = (r.lines as string[]).join("\n");
    expect(text).toContain("reloading target term-1");
    expect(text).toContain("target term-1 did not paint within 45 s of the reload: PAINTED_JS saw painted=False; address http://127.0.0.1:45123/?tkn=(hidden)");
    expect(text).toContain("text 'ERR_CONNECTION_REFUSED'");
    expect(text).toContain("webview targets now: term-1 http://127.0.0.1:45123/?tkn=(hidden)&folder=%2Fv");
    expect(text).toContain("navigating target term-1 to its own address once more");
    expect(text).not.toContain("SECRET-TOKEN");
    expect(r.navigated).toHaveLength(1);
  });

  it("a page that paints again after being navigated to its own address passes", () => {
    const r = py<any>(go('w.FakePage(world, w.PANEL_ONLY, blank_after_reload="navigate")'));
    expect(r.fails).toEqual([]);
    expect(r.navigated).toEqual(["http://127.0.0.1:45123/?tkn=SECRET-TOKEN&folder=%2Fv"]);
    expect((r.lines as string[]).join("\n")).not.toContain("SECRET-TOKEN");
  });

  /** The reload leaves the endpoint listing `listed` (a function of the reload having happened) and a page for each id. */
  const RELOAD_TO = (listedAfter: string, pages: string) => `
fresh = w.FakePage(world, w.PANEL_ONLY, name="term-2")
fresh.reloaded = True
code2 = w.FakePage(world, w.CODE_TAB, name="code-2", is_terminal=False)
code1 = codes["[1] code"]
listed = [{"id": "term-1", "type": "webview", "url": "http://127.0.0.1:45123/", "title": ""}, {"id": "code-1", "type": "webview", "url": "http://127.0.0.1:45123/?payload=1", "title": ""}]
async def reload_and_replace():
    term.reloads += 1
    term.reloaded = True
    listed[:] = ${listedAfter}
term.reload = reload_and_replace
env.list_webviews = lambda: [dict(t) for t in listed]
async def connect(t):
    return ${pages}[t["id"]]
env.connect = connect`;
  const T = (id: string, extra = "") => `{"id": "${id}", "type": "webview", "url": "http://127.0.0.1:45123/?tkn=SECRET-TOKEN${extra}", "title": ""}`;

  it("T46: when the reload re-creates the page under another id, it is found again by its partition and the run goes on with it", () => {
    const env = RELOAD_TO(`[${T("code-1", "&payload=1")}, ${T("term-2")}]`, '{"term-2": fresh, "code-1": code1}');
    const r = py<any>(go('w.FakePage(world, w.PANEL_ONLY, blank_after_reload="never")', env));
    expect(r.fails).toEqual([]);
    expect(r.extra).toBe(1);
    const text = (r.lines as string[]).join("\n");
    expect(text).toContain("the reloaded target term-1 is no longer listed");
    expect(text).toContain("target term-2 is in the page's partition (it carries obsidianWorkbench.terminalPage); connecting to it instead");
    expect(text).not.toContain("SECRET-TOKEN");
  });

  it("T46: a Code tab's webview that appears after the reload is NOT taken for the page; the run fails by name and says the page's partition has no target", () => {
    const env = RELOAD_TO(`[${T("code-2", "&payload=1")}]`, '{"code-2": code2, "code-1": code1}');
    const r = py<any>(go('w.FakePage(world, w.PANEL_ONLY, blank_after_reload="never")', env));
    expect(r.fails).toEqual(["the terminal page painted again after the reload"]);
    expect(r.extra).toBe(0);
    const text = (r.lines as string[]).join("\n");
    expect(text).toContain("the reloaded target term-1 is no longer listed: the reload closed the webview");
    expect(text).toContain("no listed webview target is in the page's partition (checked ['code-2'])");
    expect(text).not.toContain("navigating target"); // the target is gone: nothing to navigate
    expect(text).not.toContain("PASS  GP2"); // nothing after the reload ran on the wrong page
  });

  it("T46: a reload that closes the page ends the wait at once (not after the 45 s), whatever the dead connection raises", () => {
    const env = RELOAD_TO(`[${T("code-1", "&payload=1")}]`, '{"code-1": code1}') + `
env.slept = 0
_sleep = env.sleep
async def counted(s):
    env.slept += s
    await _sleep(s)
env.sleep = counted
_ev = term.ev
async def dead_ev(expr, timeout=30):
    if term.reloaded:
        raise ConnectionError("no close frame received or sent")
    return await _ev(expr, timeout)
term.ev = dead_ev`;
    const r = py<any>(go('w.FakePage(world, w.PANEL_ONLY, blank_after_reload="never")', env));
    expect(r.fails).toEqual(["the terminal page painted again after the reload"]);
    expect(r.slept).toBeLessThan(40); // the old wait alone was 45 s; the page search after it is 20 s at most
    expect((r.lines as string[]).join("\n")).toContain("PAINTED_JS saw unreadable (no close frame received or sent)");
  });

  it("T46: a Code tab whose webview went away during the run is a FAIL line with the reason, not a traceback that loses the report", () => {
    const r = py<any>(`
world = w.World()
rep = m.Reporter(echo=False)
env = world.env()
page = w.FakePage(world, w.CODE_TAB, name="code-1", is_terminal=False)
async def dead():
    raise ConnectionError("no close frame received or sent")
page.layout = dead
w.run(m.code_tab_guard_after(rep, env, {"[1] code": w.CODE_TAB}, {"[1] code": page}))
print(json.dumps({"fails": rep.fails, "lines": rep.lines}, ensure_ascii=False))`);
    expect(r.fails).toEqual(["S1: Code tab [1] code has the same side bar, panel and layout before and after"]);
    expect((r.lines as string[]).join("\n")).toContain("could not be read (no close frame received or sent)");
  });

  it("T46: a page that stays listed but blank is looked for among the other targets once, not waited for", () => {
    const env = RELOAD_TO(`[${T("term-1")}, ${T("code-1", "&payload=1")}]`, '{"term-1": term, "code-1": code1}');
    const r = py<any>(go('w.FakePage(world, w.PANEL_ONLY, blank_after_reload="never")', env));
    expect(r.fails).toEqual(["the terminal page painted again after the reload"]);
    expect((r.lines as string[]).join("\n")).toContain("the reloaded target term-1 is still listed");
    expect(r.navigated).toHaveLength(1);
  });

  const STATE = (after: string) => `
async def state():
    return ${after} if term.reloaded else {"n": 1, "views": [{"url": "http://127.0.0.1:45123/?tkn=(hidden)&folder=%2Fv", "loading": False, "crashed": False, "connected": True}]}
env.webview_state = state`;

  it("T55: the Obsidian window's view of the <webview> is reported before the reload and again when the page did not come back (element gone vs present)", () => {
    const gone = RELOAD_TO(`[${T("code-1", "&payload=1")}]`, '{"code-1": code1}') + STATE('{"n": 0, "views": []}');
    const r = py<any>(go('w.FakePage(world, w.PANEL_ONLY, blank_after_reload="never")', gone));
    const text = (r.lines as string[]).join("\n");
    expect(text).toContain("the <webview> in the Obsidian window before the reload: 1 <webview> element(s) with partition persist:vscode-workbench-terminal-spike: address http://127.0.0.1:45123/?tkn=(hidden)&folder=%2Fv, loading=False, crashed=False, in the document=True");
    expect(text).toContain("the <webview> in the Obsidian window after the reload: 0 <webview> element(s) with partition persist:vscode-workbench-terminal-spike: the element is gone from the window");
    const present = RELOAD_TO(`[${T("code-1", "&payload=1")}]`, '{"code-1": code1}') + STATE('{"n": 1, "views": [{"url": "about:blank", "loading": False, "crashed": True, "connected": True}]}');
    const p = py<any>(go('w.FakePage(world, w.PANEL_ONLY, blank_after_reload="never")', present));
    expect((p.lines as string[]).join("\n")).toContain("after the reload: 1 <webview> element(s) with partition persist:vscode-workbench-terminal-spike: address about:blank, loading=False, crashed=True, in the document=True");
  });

  it("T55: with no Obsidian window to ask, the report says the state was not read and nothing else changes", () => {
    const r = py<any>(go("w.FakePage(world, w.PANEL_ONLY)"));
    expect(r.fails).toEqual([]);
    expect((r.lines as string[]).join("\n")).toContain("the <webview> in the Obsidian window before the reload: not read (no Obsidian window was connected)");
  });

  it("T55: a target that stays listed under the same id but whose old connection died is connected to afresh, not skipped", () => {
    const env = RELOAD_TO(`[${T("term-1")}, ${T("code-1", "&payload=1")}]`, '{"term-1": fresh, "code-1": code1}') + `
_ev = term.ev
async def dead_ev(expr, timeout=30):
    if term.reloaded:
        raise ConnectionError("no close frame received or sent")
    return await _ev(expr, timeout)
term.ev = dead_ev`;
    const r = py<any>(go('w.FakePage(world, w.PANEL_ONLY, blank_after_reload="never")', env));
    expect(r.fails).toEqual([]);
    expect(r.navigated).toEqual([]);
    const text = (r.lines as string[]).join("\n");
    expect(text).toContain("the reloaded target term-1 is still listed");
    expect(text).toContain("target term-1 is in the page's partition (it carries obsidianWorkbench.terminalPage); connecting to it instead");
    expect(text).toContain("PASS  GP2: one shell started with the panel");
  });

  it("T55: a document that still carries the mark set before the reload is the old one: it is not a repaint, and the report says the reload did not happen", () => {
    const env = `
_ev = term.ev
async def old_ev(expr, timeout=30):
    return True if expr == m.OLD_DOC_JS else await _ev(expr, timeout)
term.ev = old_ev`;
    const r = py<any>(go("w.FakePage(world, w.PANEL_ONLY)", env));
    const text = (r.lines as string[]).join("\n");
    expect(text).toContain("target term-1 did not paint within 45 s of the reload");
    expect(text).toContain("still shows the document that was there before the reload (the mark set before it is still in the page): the reload did not happen");
  });

  it("T55: the page is marked before the reload is asked for, and a fresh document (no mark) counts", () => {
    const r = py<any>(`
world = w.World()
term = w.FakePage(world, w.PANEL_ONLY)
seen = []
_ev = term.ev
async def spy(expr, timeout=30):
    if expr == m.OLD_DOC_SET_JS: seen.append("marked")
    return await _ev(expr, timeout)
term.ev = spy
env = world.env()
_rp = env.reload_page
async def reload_page(page):
    seen.append("reload")
    await _rp(page)
env.reload_page = reload_page
rep = m.Reporter(echo=False)
res = w.run(m.reload_and_wait(env, rep, term))
print(json.dumps({"seen": seen, "res": [res[0], res[2]]}))`);
    expect(r.seen).toEqual(["marked", "reload"]);
    expect(r.res).toEqual([true, false]);
  });

  it("T55: when no page comes back through its own target but the window still owns the element, the window points it at the address again; the repaint line stays a FAIL and the run goes on with the page that came back", () => {
    const env = RELOAD_TO(`[${T("code-1", "&payload=1")}]`, '{"term-2": fresh, "code-1": code1}') + `
async def load_page(href):
    listed[:] = [${T("term-2")}, ${T("code-1", "&payload=1")}]
    return None
env.load_page = load_page`;
    const r = py<any>(go('w.FakePage(world, w.PANEL_ONLY, blank_after_reload="never")', env));
    expect(r.fails).toEqual(["the terminal page painted again after the reload"]);
    const text = (r.lines as string[]).join("\n");
    expect(text).toContain("the <webview> in the Obsidian window was pointed at the page's address again (webview.loadURL)");
    expect(text).toContain("target term-2 painted after the window loaded the address again: the reload alone did not bring the page back");
    expect(text).toContain("PASS  GP2: one shell started with the panel"); // the run was not stopped
    expect(text).not.toContain("SECRET-TOKEN");
  });

  it("T55: when the window cannot load it either, the reason is reported and the run stops at the repaint line as before", () => {
    const env = RELOAD_TO(`[${T("code-1", "&payload=1")}]`, '{"code-1": code1}') + `
async def load_page(href): return "0 <webview> element(s) with partition x (exactly one is needed)"
env.load_page = load_page`;
    const r = py<any>(go('w.FakePage(world, w.PANEL_ONLY, blank_after_reload="never")', env));
    expect(r.fails).toEqual(["the terminal page painted again after the reload"]);
    const text = (r.lines as string[]).join("\n");
    expect(text).toContain("the <webview> was not pointed at the page's address again: 0 <webview> element(s)");
    expect(text).not.toContain("GP2");
  });

  it("the detail script reads a page the way PAINTED_JS does and hides the token in the address (jsdom)", async () => {
    const jsdom = "jsdom";
    const { JSDOM } = (await import(jsdom)) as { JSDOM: new (html: string, o: Record<string, unknown>) => { window: unknown } };
    const w = new JSDOM(`<body><div class="part editor"></div><div class="part statusbar">ready</div></body>`, { runScripts: "outside-only", url: "http://127.0.0.1:45123/?tkn=SECRET&folder=/v" }).window as unknown as Record<string, any>;
    const { js } = py<{ js: string }>(`print(json.dumps({"js": m.PAINTED_DETAIL_JS}))`);
    const d = JSON.parse(w.eval(js));
    expect(d.href).toBe("http://127.0.0.1:45123/?tkn=(hidden)&folder=/v");
    expect(d.parts).toMatchObject({ editor: "0x0", statusbar: "0x0", panel: null });
    expect(d.painted).toBe(false); // jsdom has no layout: offsetWidth is 0, the same answer PAINTED_JS gives
    expect(d.body).toContain("ready");
    expect(JSON.stringify(d)).not.toContain("SECRET");
  });
});

describe("T49: the terminal page is reloaded the way a webview is, from the Obsidian window, never through a CDP Page.reload on its own target", () => {
  const PARTITION = "persist:vscode-workbench-terminal-spike";

  async function runReloadScript(partitions: string[]) {
    const jsdom = "jsdom";
    const { JSDOM } = (await import(jsdom)) as { JSDOM: new (html: string, o: Record<string, unknown>) => { window: unknown } };
    const w = new JSDOM("<body></body>", { runScripts: "outside-only" }).window as unknown as Record<string, any>;
    const reloaded: string[] = [];
    for (const p of partitions) {
      const el = w.document.createElement("webview");
      el.setAttribute("partition", p);
      el.reload = () => void reloaded.push(p);
      w.document.body.appendChild(el);
    }
    const js = py<string>(`print(json.dumps(m.webview_reload_js()))`);
    return { result: JSON.parse(w.eval(js)), reloaded };
  }

  it("finds the page's own <webview> by its partition attribute and calls reload() on it, and on no other webview", async () => {
    const r = await runReloadScript(["persist:vscode-workbench", PARTITION]);
    expect(r.result).toEqual({ status: "reloaded" });
    expect(r.reloaded).toEqual([PARTITION]);
  });

  it("reloads nothing when there is no such webview, or two of them (it says how many)", async () => {
    expect(await runReloadScript(["persist:vscode-workbench"])).toEqual({ result: { status: "count", n: 0 }, reloaded: [] });
    expect(await runReloadScript([PARTITION, PARTITION])).toEqual({ result: { status: "count", n: 2 }, reloaded: [] });
  });

  it("the partition it looks for is the one open-page gives the page", () => {
    const js = py<string>(`print(json.dumps(m.webview_reload_js()))`);
    expect(js).toContain(JSON.stringify(PARTITION));
    expect(py<string>(`print(json.dumps(m.PAGE_PARTITION))`)).toBe(PARTITION);
  });

  it("the reloader answers None when the webview was reloaded, and why not when it was not (a count, an error, no answer)", () => {
    const r = py<any>(`
class Obs:
    def __init__(self, answer): self.answer = answer; self.sent = []
    async def ev(self, expr, timeout=30):
        self.sent.append(expr)
        if isinstance(self.answer, Exception): raise self.answer
        return self.answer
def ask(answer):
    obs = Obs(answer)
    return w.run(m.webview_reloader(obs)(None)), obs.sent
print(json.dumps([ask('{"status": "reloaded"}'), ask('{"status": "count", "n": 0}')[0], ask('{"status": "error", "error": "boom"}')[0], ask(ConnectionError("gone"))[0]]))`);
    expect(r[0][0]).toBeNull();
    expect(r[0][1]).toHaveLength(1);
    expect(r[1]).toContain("0 <webview> element(s) with partition persist:vscode-workbench-terminal-spike");
    expect(r[2]).toContain("webview.reload() raised: boom");
    expect(r[3]).toContain("did not answer");
  });

  const run = (env: string) => `
world = w.World()
term = w.FakePage(world, w.PANEL_ONLY)
codes = {"[1] code": w.FakePage(world, w.CODE_TAB, name="code-1")}
env = world.env()
${env}
rep = m.Reporter(echo=False)
async def go():
    await m.run_terminal_at(env, rep, w.args(world), term, codes, {"pid": w.SERVER_PID, "data_dir": world.data}, m.__file__.replace("container-terminal-check.py", "terminal-at-extension.cjs"), world.out)
w.run(go())
print(json.dumps({"fails": rep.fails, "lines": rep.lines, "reloads": term.reloads, "passes": rep.passes}, ensure_ascii=False))`;

  it("terminal-at reloads through the env's reload_page (the Obsidian window), not through the page's own connection", () => {
    const r = py<any>(run(`
asked = []
async def reload_page(page):
    asked.append(page.name)
env.reload_page = reload_page
async def never(): raise AssertionError("the page's own connection must not be used to reload")
term.reload = never`));
    expect(r.fails).toEqual([]);
    expect(r.reloads).toBe(0);
  });

  it("when the webview cannot be reloaded the run says why, fails the repaint line by name, runs nothing on the page, and still measures the Code tab", () => {
    const r = py<any>(run(`
async def reload_page(page): return "0 <webview> element(s) with partition x in the Obsidian window"
env.reload_page = reload_page`));
    expect(r.fails).toEqual(["the terminal page painted again after the reload"]);
    const text = (r.lines as string[]).join("\n");
    expect(text).toContain("INFO  the page was not reloaded: 0 <webview> element(s)");
    expect(text).toContain("PASS  S1: Code tab [1] code has the same side bar, panel and layout before and after");
    expect(text).not.toContain("GP2");
    expect(r.reloads).toBe(0);
  });

  it("a helper env with no Obsidian window to reload from says so rather than reloading through CDP; the Page class has no CDP reload any more", () => {
    const r = py<any>(`print(json.dumps({"why": w.run(m.Env().reload_page(None)), "has_reload": hasattr(m.Page, "reload")}))`);
    expect(r.why).toContain("no Obsidian window was connected");
    expect(r.has_reload).toBe(false);
    const src = fs.readFileSync(HELPER, "utf8");
    expect(src).not.toContain('"Page.reload"');
    expect(src).toContain("env.reload_page = webview_reloader(");
  });

  it("the docs describe what the reload does", () => {
    const doc = fs.readFileSync(path.join(REPO_ROOT, "docs", "terminal-spike.md"), "utf8");
    expect(doc).toContain("webview.reload()");
  });
});

describe("T55: what the Obsidian window says about the page's <webview>, and loading it again from there", () => {
  const PARTITION = "persist:vscode-workbench-terminal-spike";

  async function windowWith(views: Array<{ partition: string; url?: string; loading?: boolean; crashed?: boolean; throwsUrl?: boolean; loadFails?: string }>) {
    const jsdom = "jsdom";
    const { JSDOM } = (await import(jsdom)) as { JSDOM: new (html: string, o: Record<string, unknown>) => { window: unknown } };
    const w = new JSDOM("<body></body>", { runScripts: "outside-only" }).window as unknown as Record<string, any>;
    const loaded: string[] = [];
    for (const v of views) {
      const el = w.document.createElement("webview");
      el.setAttribute("partition", v.partition);
      el.getURL = () => {
        if (v.throwsUrl) throw new Error("The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.");
        return v.url ?? "about:blank";
      };
      el.isLoading = () => v.loading ?? false;
      el.isCrashed = () => v.crashed ?? false;
      el.loadURL = async (href: string) => {
        loaded.push(href);
        if (v.loadFails) throw new Error(v.loadFails);
      };
      w.document.body.appendChild(el);
    }
    return { w, loaded };
  }

  it("webview_state_js reports the page's own element(s) only, with the token hidden, and survives a method that throws before dom-ready", async () => {
    const { w } = await windowWith([{ partition: "persist:vscode-workbench", url: "http://x/other" }, { partition: PARTITION, url: "http://127.0.0.1:45123/?tkn=SECRET&folder=%2Fv", loading: true }]);
    const js = py<string>(`print(json.dumps(m.webview_state_js()))`);
    const st = JSON.parse(w.eval(js));
    expect(st).toEqual({ n: 1, views: [{ url: "http://127.0.0.1:45123/?tkn=(hidden)&folder=%2Fv", loading: true, crashed: false, connected: true }] });
    expect(JSON.stringify(st)).not.toContain("SECRET");
    const early = JSON.parse((await windowWith([{ partition: PARTITION, throwsUrl: true }])).w.eval(js));
    expect(early.views[0].url).toBe("n/a");
    expect(JSON.parse((await windowWith([])).w.eval(js))).toEqual({ n: 0, views: [] });
  });

  it("webview_load_js loads the address into the one element in the page's partition, counts elements otherwise, and never returns the token", async () => {
    const href = "http://127.0.0.1:45123/?tkn=SECRET&folder=%2Fv";
    const js = py<string>(`print(json.dumps(m.webview_load_js(a["href"])))`, { href });
    const one = await windowWith([{ partition: "persist:vscode-workbench" }, { partition: PARTITION }]);
    expect(JSON.parse(await one.w.eval(js))).toEqual({ status: "loaded" });
    expect(one.loaded).toEqual([href]);
    const two = await windowWith([{ partition: PARTITION }, { partition: PARTITION }]);
    expect(JSON.parse(await two.w.eval(js))).toEqual({ status: "count", n: 2 });
    expect(two.loaded).toEqual([]);
    const aborted = await windowWith([{ partition: PARTITION, loadFails: "ERR_ABORTED (-3) loading 'x'" }]);
    expect(JSON.parse(await aborted.w.eval(js))).toEqual({ status: "loaded" }); // a load that a redirect superseded is not a failure
    const failed = await windowWith([{ partition: PARTITION, loadFails: "ERR_CONNECTION_REFUSED (-102) loading '" + href + "'" }]);
    const res = JSON.parse(await failed.w.eval(js));
    expect(res.status).toBe("error");
    expect(res.error).toContain("ERR_CONNECTION_REFUSED");
    expect(JSON.stringify(res)).not.toContain("SECRET");
  });

  it("the state reader and the loader answer through the window, and say why when it does not answer", () => {
    const r = py<any>(`
class Obs:
    def __init__(self, answer): self.answer = answer; self.sent = []
    async def ev(self, expr, timeout=30):
        self.sent.append(expr)
        if isinstance(self.answer, Exception): raise self.answer
        return self.answer
st = w.run(m.webview_state_reader(Obs('{"n": 1, "views": []}'))())
bad = w.run(m.webview_state_reader(Obs(ConnectionError("gone")))())
ok = w.run(m.webview_loader(Obs('{"status": "loaded"}'))("http://x/"))
count = w.run(m.webview_loader(Obs('{"status": "count", "n": 0}'))("http://x/"))
err = w.run(m.webview_loader(Obs('{"status": "error", "error": "boom"}'))("http://x/"))
dead = w.run(m.webview_loader(Obs(ConnectionError("gone")))("http://x/"))
print(json.dumps({"st": st, "bad": bad, "ok": ok, "count": count, "err": err, "dead": dead, "text": [m.webview_text(None), m.webview_text({"n": 0, "views": []})]}))`);
    expect(r.st).toEqual({ n: 1, views: [] });
    expect(r.bad.error).toContain("did not answer");
    expect(r.ok).toBeNull();
    expect(r.count).toContain("0 <webview> element(s)");
    expect(r.err).toContain("webview.loadURL() raised: boom");
    expect(r.dead).toContain("did not answer the webview load script");
    expect(r.text[0]).toContain("not read");
    expect(r.text[1]).toContain("the element is gone from the window");
  });

  it("terminal-at hands the Obsidian window to the reload, the state report and the load", () => {
    const src = fs.readFileSync(HELPER, "utf8");
    expect(src).toContain("env.webview_state = webview_state_reader(obs)");
    expect(src).toContain("env.load_page = webview_loader(obs)");
  });
});

describe("the command line and the report", () => {
  it("writes the PASS/FAIL lines and a .json next to them, and exits 1 when a check failed", () => {
    const dir = tempDir("ctc-out-");
    const r = py<any>(`rep = m.Reporter(echo=False)\nrep.check(True, "good", "detail")\nrep.check(False, "bad")\nrep.info("two\\nlines")\nrep.write(a["f"])\nprint(json.dumps({"lines": rep.lines, "code": rep.exit_code(), "summary": rep.summary(), "txt": open(a["f"]).read(), "js": json.load(open(a["f"] + ".json"))}))`, { f: path.join(dir, "sub", "o.txt") });
    expect(r.lines).toEqual(["PASS  good  (detail)", "FAIL  bad", "INFO  two", "INFO  lines"]);
    expect(r.code).toBe(1);
    expect(r.summary).toBe("1 PASS, 1 FAIL: bad");
    expect(r.txt).toBe(r.lines.join("\n") + "\n");
    expect(r.js).toMatchObject({ passes: 1, fails: ["bad"] });
  });

  it("exits 2 with a plain message when there is no server to check, and --help runs without the websockets package", () => {
    const run = spawnSync("python3", [HELPER, "terminal-at", "--vault", os.tmpdir(), "--cdp", "http://127.0.0.1:1", "--server-pid", "999999", "--out-dir", tempDir("ctc-cli-")], { encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("CANNOT RUN: no running server");
    const noWindow = spawnSync("python3", [HELPER, "trust-plugins", "--cdp", "http://127.0.0.1:1", "--out-dir", tempDir("ctc-cli-")], { encoding: "utf8" });
    expect(noWindow.status).toBe(2);
    expect(noWindow.stderr).toContain("CANNOT RUN: cannot read http://127.0.0.1:1/json/list");
    const help = spawnSync("python3", [HELPER, "force-quit", "kill", "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--obsidian-pid");
  });
});
