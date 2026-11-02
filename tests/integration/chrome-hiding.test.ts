/**
 * Integration: the Code tab hides the chrome of a page it loads (GP1, E1, E6, F3), through the real CodeView, the real seed and chrome
 * scripts, a real `fake-serve-web.mjs` process (its `workbench` modes, on a free port picked here) and a jsdom page that stands in
 * for the webview's page. The fake workbench page applies the profile's settings and keybindings the way the real one does (see
 * tests/fixtures/fake-workbench-page.mjs), so the chords the seed writes are the chords that close the parts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as net from "node:net";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceLeaf } from "../mocks/obsidian";
import { CodeView, type CodeViewHost } from "../../src/code-view";
import { chromeKeybindings } from "../../src/chrome-settings";
import { CHROME_SCRIPT_INSTALLED, buildChromeHideScript } from "../../src/chrome-script";
import { BROWSER_APP_SETTINGS, workbenchOverlay } from "../../src/settings";
import { fakeIndexedDB, fakeStorage } from "../fake-seed-page";
import { FakeWebview, REPO_ROOT, tempDir } from "../helpers";

interface Page {
  window: Window & typeof globalThis & { eval(code: string): unknown; close(): void; __fake: { state: { open: Record<string, boolean>; editors: string[] }; commands: string[] } };
}
const { JSDOM } = createRequire(import.meta.url)("jsdom") as { JSDOM: new (html: string, opts: Record<string, unknown>) => Page };

const TOKEN = "tok-chrome-test";
const FILE = "HackerRank Mini-Course/_internals/research-pack/t/pd.js";
const VAULT = "/Users/dan/My Vault";
const PARTS = ["titleBar", "activityBar", "sideBar", "tabStrip", "breadcrumbs", "secondarySideBar", "panel", "statusBar"] as const;

let server: ChildProcess | null = null;
let port = 0;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });

/** tests/fixtures/fake-serve-web.mjs in one of its workbench modes, on a free loopback port picked here. The one PID started is the one stopped. */
async function startServer(mode: "workbench" | "workbench-renamed"): Promise<void> {
  await stopServer();
  port = await freePort();
  const tokenFile = path.join(tempDir(), "token");
  fs.writeFileSync(tokenFile, TOKEN);
  const child = spawn(process.execPath, [path.join(REPO_ROOT, "tests/fixtures/fake-serve-web.mjs"), "--host", "127.0.0.1", "--port", String(port), "--connection-token-file", tokenFile], {
    env: { ...process.env, FAKE_CODE_MODE: mode },
    stdio: ["ignore", "pipe", "ignore"],
  });
  server = child;
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (d: Buffer) => d.toString().includes("Web UI available") && resolve());
    child.on("exit", (c) => reject(new Error(`fake server exited ${c}`)));
  });
}

async function stopServer(): Promise<void> {
  const child = server;
  server = null;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.removeAllListeners("exit");
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}
afterAll(stopServer);

/**
 * The webview of a Code tab, with a real page behind its second load. Scripts run where a webview runs them: the seed script against the
 * profile's IndexedDB (shared by every tab of one test, like the one partition), the chrome script in the page.
 */
class PageWebview extends FakeWebview {
  page: Page | null = null;
  loaded: Promise<void> = Promise.resolve();
  constructor(
    tag: string,
    private readonly world: World,
  ) {
    super(tag);
    this.autoDomReady = false;
  }
  setAttribute(k: string, v: string) {
    super.setAttribute(k, v);
    if (k !== "src") return;
    if (this.srcs.length === 1) {
      setTimeout(() => this.fire("dom-ready"), 0); // the server's origin page
      return;
    }
    this.loaded = (async () => {
      const html = await (await fetch(v)).text();
      const win = new JSDOM(html, {
        runScripts: "dangerously",
        url: v,
        beforeParse: (w: Page["window"]) => {
          (w as unknown as Record<string, unknown>).indexedDB = this.world.idb.indexedDB;
          (w as unknown as Record<string, unknown>).TextDecoder = TextDecoder;
          (w as unknown as Record<string, unknown>).TextEncoder = TextEncoder;
        },
      });
      this.page = win;
      this.world.pages.push(win);
      this.fire("dom-ready");
    })();
  }
  executeJavaScript(code: string): Promise<unknown> {
    this.executed.push(code);
    if (code === buildChromeHideScript()) return Promise.resolve().then(() => (this.world.chromeAnswer ? this.world.chromeAnswer() : this.page!.window.eval(code)));
    return (new Function("indexedDB", "localStorage", "TextEncoder", "TextDecoder", `return ${code}`) as (...a: unknown[]) => Promise<unknown>)(this.world.idb.indexedDB, this.world.storage, TextEncoder, TextDecoder) as Promise<unknown>;
  }
}

interface World {
  idb: ReturnType<typeof fakeIndexedDB>;
  storage: ReturnType<typeof fakeStorage>;
  pages: Page[];
  chromeAnswer?: () => unknown;
}
let world: World;

function makeTab(host: Partial<CodeViewHost> = {}) {
  const full: CodeViewHost = {
    vaultRoot: () => VAULT,
    embedElement: () => "webview",
    ensureServer: async () => ({ baseUrl: `http://127.0.0.1:${port}`, port, token: TOKEN }),
    trackView: vi.fn(),
    untrackView: vi.fn(),
    serverState: () => "running",
    onServerState: () => () => undefined,
    restartServer: async () => undefined,
    userDataCopy: () => null,
    admitFile: async () => true,
    releaseFile: () => undefined,
    openInSystemApp: () => undefined,
    workbenchOverlay: () => workbenchOverlay({ dark: false }),
    chromeHiding: () => ({ keybindings: chromeKeybindings(), script: buildChromeHideScript() }),
    ...host,
  };
  const view = new CodeView(new WorkspaceLeaf() as never, full);
  const contentEl = new FakeWebview("div");
  const created: PageWebview[] = [];
  contentEl.appendChild = ((c: FakeWebview) => FakeWebview.prototype.appendChild.call(contentEl, c)) as never;
  (view as unknown as { contentEl: FakeWebview }).contentEl = contentEl;
  return { view, contentEl, created };
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

/** Open `file` in a new tab of the world's profile, and wait for the page to be built and the chrome script to have run. */
async function openTab(host: Partial<CodeViewHost> = {}, file = FILE) {
  const { view, contentEl } = makeTab(host);
  const made: PageWebview[] = [];
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      const e = new PageWebview(tag, world);
      made.push(e);
      return e;
    },
  });
  await view.setState({ file }, {} as never);
  const wv = contentEl.children[0] as PageWebview;
  await wv.loaded;
  await settle();
  return { view, wv, page: wv.page! };
}

const openParts = (page: Page) => PARTS.filter((p) => page.window.__fake.state.open[p]);

/** A browser profile with a saved layout: side bar open, panel open, secondary side bar open, a previous editor open. */
function savedLayout() {
  const store = new Map<string, unknown>();
  store.set("/layout", new TextEncoder().encode(JSON.stringify({ sideBar: true, secondarySideBar: true, panel: true, editors: ["vscode-remote://127.0.0.1/previous/old.py"] })));
  return store;
}

beforeEach(() => {
  world = { idb: fakeIndexedDB({ "/layout": savedLayout().get("/layout") }), storage: fakeStorage(), pages: [] };
});
afterEach(() => {
  for (const p of world.pages) p.window.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("E6: a saved layout (side bar, panel, secondary side bar and a previous editor open) is undone on load", () => {
  beforeAll(() => startServer("workbench"));

  it("control: with no hiding step the page is the 0.1.0 one, so the check below is not vacuous", async () => {
    const { page } = await openTab({ chromeHiding: undefined, workbenchOverlay: () => ({}) });
    expect(openParts(page)).toEqual(expect.arrayContaining(["sideBar", "secondarySideBar", "panel"]));
    expect(page.window.__fake.state.editors).toHaveLength(2);
  });

  it("after load every part is hidden and only the requested file is in the editor (the mechanism: the seeded close chords + the page script, docs/spike-chrome.md R6a and S2)", async () => {
    const { page } = await openTab();
    expect(openParts(page)).toEqual([]);
    expect(page.window.__fake.state.editors).toHaveLength(1);
    expect(page.window.__fake.state.editors[0]).toContain("pd.js");
    expect(page.window.__fake.commands.sort()).toEqual(["workbench.action.closeAuxiliaryBar", "workbench.action.closeOtherEditors", "workbench.action.closePanel", "workbench.action.closeSidebar"]);
    expect(page.window.document.querySelectorAll(".monaco-editor[data-uri]")).toHaveLength(1);
  });

  it("a second tab opened after the first shows no chrome either: hiding is applied per load", async () => {
    const first = await openTab();
    expect(openParts(first.page)).toEqual([]);
    const second = await openTab({}, "HackerRank Mini-Course/other.js");
    expect(openParts(second.page)).toEqual([]);
    expect(second.page.window.__fake.state.editors).toHaveLength(1);
    expect(second.page.window.__fake.state.editors[0]).toContain("other.js");
    // the second load's profile still holds our chords once each, and the first tab's pages do not share state with it
    const rules = JSON.parse(new TextDecoder().decode(world.idb.stores.get("vscode-userdata-store")!.get("/User/keybindings.json") as Uint8Array)) as unknown[];
    expect(rules).toEqual(chromeKeybindings());
  });

  it("a profile whose layout state brings the parts back at a later reload: the same load puts the same result", async () => {
    await openTab();
    world.idb.stores.get("vscode-userdata-store")!.set("/layout", new TextEncoder().encode(JSON.stringify({ sideBar: true, secondarySideBar: true, panel: true, editors: ["vscode-remote://127.0.0.1/previous/old.py"] })));
    const again = await openTab();
    expect(openParts(again.page)).toEqual([]);
    expect(again.page.window.__fake.state.editors).toHaveLength(1);
  });

  it("the settings route hides the rest: activity bar, status bar, title bar, tab strip, breadcrumbs", async () => {
    const { page } = await openTab();
    const settings = JSON.parse(new TextDecoder().decode(world.idb.stores.get("vscode-userdata-store")!.get("/User/settings.json") as Uint8Array)) as Record<string, unknown>;
    expect(settings).toMatchObject({ ...BROWSER_APP_SETTINGS, ...workbenchOverlay({ dark: false }) });
    for (const p of ["activityBar", "statusBar", "titleBar", "tabStrip", "breadcrumbs"]) expect(page.window.__fake.state.open[p], p).toBe(false);
    expect(page.window.__fake.state.open.editor).toBe(true);
  });
});

describe("E1/F3: selectors that match nothing leave the 0.1.0 chrome, and the tab still loads", () => {
  beforeAll(() => startServer("workbench-renamed"));

  it("the tab is pointed at the file, the script answers installed, nothing is thrown or logged as an error, and the full workbench shows", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const { wv, page } = await openTab();
    expect(wv.srcs[1]).toContain(`tkn=${TOKEN}`);
    expect(JSON.parse(new URL(wv.srcs[1]).searchParams.get("payload")!)[0][1]).toContain("pd.js");
    expect(debug.mock.calls.flat().join(" ")).toContain("chrome-hiding script installed");
    expect(error).not.toHaveBeenCalled();
    // renamed parts: no chord pressed, so the saved layout's side bar, panel and secondary side bar and the previous editor are all still there
    expect(page.window.__fake.commands).toEqual([]);
    expect(openParts(page)).toEqual(expect.arrayContaining(["sideBar", "secondarySideBar", "panel"]));
    expect(page.window.__fake.state.editors).toHaveLength(2);
    expect(page.window.document.querySelectorAll(".part")).toHaveLength(0); // none of the real class names exist in this page
  });

  it("runInWebview-style call resolves without throwing and leaves no retry: the script holds no timer of its own", async () => {
    const { wv } = await openTab();
    expect(wv.executed.filter((c) => c === buildChromeHideScript())).toHaveLength(1); // run once, not retried
    expect(buildChromeHideScript()).not.toMatch(/setTimeout|setInterval/);
  });
});

describe("F3: a tab never blanks, whatever the hiding step does", () => {
  beforeAll(() => startServer("workbench"));

  it.each([
    ["the script throws", () => Promise.reject(new Error("page refused"))],
    ["the script answers something else", () => "unexpected"],
  ])("%s: the src is the file URL, one warning, the 0.1.0 parts the settings do not hide are shown", async (_name, answer) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    world.chromeAnswer = answer as () => unknown;
    const { wv, page } = await openTab();
    expect(wv.srcs[1]).toContain(`tkn=${TOKEN}`);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("the chrome-hiding script did not run"))).toHaveLength(1);
    expect(openParts(page)).toEqual(expect.arrayContaining(["sideBar", "secondarySideBar", "panel"]));
    expect(page.window.document.querySelector(".part.editor")).not.toBeNull();
  });

  it("with the hiding off (an older host), the src is still the file URL and the page is the 0.1.0 one", async () => {
    const { wv, page } = await openTab({ chromeHiding: undefined });
    expect(wv.srcs).toHaveLength(2);
    expect(wv.srcs[1]).toContain(`tkn=${TOKEN}`);
    expect(openParts(page)).toContain("sideBar");
    expect(CHROME_SCRIPT_INSTALLED).toBe("installed");
  });
});
