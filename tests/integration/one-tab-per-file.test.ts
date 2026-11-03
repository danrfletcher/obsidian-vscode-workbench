/**
 * One Code tab per file, and the open-time guard, through the real plugin class
 * with mocked workspace leaves. A leaf's `setViewState` stands in for Obsidian
 * creating the Code view: it hands the file to the plugin's `admitFile` (what
 * `CodeView.setState` does) and closes itself when that refuses.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSystemAdapter, Modal, Notice, Plugin, TFile, WorkspaceLeaf, type MockApp } from "../mocks/obsidian";
import VSCodeWorkbenchPlugin from "../../src/main";
import { CodeView, DIRTY_SCRIPT } from "../../src/code-view";
import { LicenceDeclinedError } from "../../src/licence";
import { buildFileUri, targetOfUri } from "../../src/paths";
import { FAKE_CODE, isAlive, tempDir } from "../helpers";

const VIEW = "vscode-workbench-code";

let vault: string;
let pidFile: string;
let plugin: VSCodeWorkbenchPlugin;
let app: MockApp;
let created: CodeLeaf[];
let revealed: WorkspaceLeaf[];
let systemApp: string[];

class CodeLeaf extends WorkspaceLeaf {
  file: string | null = null;
  async setViewState(s: { type: string; state?: unknown }): Promise<void> {
    this.viewState = s;
    const file = (s.state as { file?: string } | undefined)?.file;
    if (s.type !== VIEW || !file) return;
    this.file = file;
    if (!(await plugin.admitFile(file, this as never))) this.detach();
  }
  detach(): void {
    if (this.detached) return;
    super.detach();
    if (this.file) plugin.releaseFile(this.file, this as never);
  }
}

const live = () => created.filter((l) => !l.detached && l.viewState?.type === VIEW);

function makeApp(root: string): MockApp {
  const a = {
    vault: {
      adapter: new FileSystemAdapter(root),
      configDir: ".obsidian",
      getAbstractFileByPath: (p: string) => (fs.existsSync(path.join(root, p)) ? new TFile(p) : null),
      on: (name: string, cb: (...args: any[]) => void) => ({ name, cb }),
    },
    workspace: {
      onLayoutReady: (cb: () => void) => cb(),
      activeFile: null as TFile | null,
      leaves: [] as WorkspaceLeaf[],
      getActiveFile: () => a.workspace.activeFile,
      getLeavesOfType: (type: string) => created.filter((l) => !l.detached && l.viewState?.type === type),
      getLeaf: () => {
        const l = new CodeLeaf();
        created.push(l);
        return l;
      },
      revealLeaf: async (l: WorkspaceLeaf) => void revealed.push(l),
      detachLeavesOfType: () => undefined,
      on: (name: string, cb: (...args: any[]) => void) => ({ name, cb }),
    },
    openWithDefaultApp: async (p: string) => void systemApp.push(p),
  };
  return a as unknown as MockApp;
}

async function load(data: Record<string, unknown> = {}): Promise<void> {
  Object.assign(process.env, { FAKE_CODE_NODE: process.execPath, FAKE_CODE_PIDFILE: pidFile });
  app = makeApp(vault);
  plugin = new VSCodeWorkbenchPlugin(app as never, { id: "obsidian-vscode-workbench", dir: ".obsidian/plugins/obsidian-vscode-workbench" } as never);
  (plugin as unknown as { pluginData: unknown }).pluginData = { codeCliPath: FAKE_CODE, embed: "iframe", serverLicenceAccepted: true, ...data };
  await plugin.onload();
}

const serverPids = () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : []);

function write(rel: string, content: Buffer | string = "x = 1\n"): string {
  fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
  fs.writeFileSync(path.join(vault, rel), content);
  return rel;
}

/** What Obsidian does for a click in the explorer, a link or the quick switcher: a leaf is given the view state directly. */
async function openLikeObsidian(file: string): Promise<CodeLeaf> {
  const leaf = app.workspace.getLeaf("tab") as unknown as CodeLeaf;
  await leaf.setViewState({ type: VIEW, state: { file }, active: true } as { type: string; state?: unknown });
  return leaf;
}

beforeEach(() => {
  vault = tempDir();
  pidFile = path.join(tempDir(), "pids");
  created = [];
  revealed = [];
  systemApp = [];
  Plugin.reset();
  Notice.reset();
  Modal.reset();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.stubGlobal("window", { addEventListener: () => undefined });
  vi.stubGlobal("document", { body: { classList: { contains: () => false } } });
});

afterEach(async () => {
  plugin?.onunload();
  await new Promise((r) => setTimeout(r, 400));
  for (const pid of serverPids()) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  for (const k of ["FAKE_CODE_NODE", "FAKE_CODE_PIDFILE"]) delete process.env[k];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("one tab per file (G1)", () => {
  it("a repeat open focuses the existing tab and adds none", async () => {
    const f = write("scripts/a.py");
    await load();
    await plugin.openCodeFile(f);
    expect(live()).toHaveLength(1);
    expect(revealed).toEqual([live()[0]]); // revealed once, as it opened
    await plugin.openCodeFile(f);
    expect(created).toHaveLength(1);
    expect(live()).toHaveLength(1);
    expect(revealed).toEqual([live()[0], live()[0]]);
  });

  it("an open from another leaf (explorer click, link, quick switcher) focuses the existing tab and drops the new leaf", async () => {
    const f = write("scripts/a.py");
    await load();
    await plugin.openCodeFile(f);
    const first = live()[0];
    const second = await openLikeObsidian(f);
    expect(second.detached).toBe(true);
    expect(live()).toEqual([first]);
    expect(revealed[revealed.length - 1]).toBe(first);
  });

  it("an open into a split (a second leaf given the same file) adds no tab", async () => {
    const f = write("a.py");
    await load();
    await plugin.openCodeFile(f);
    const split = await openLikeObsidian(f);
    const split2 = await openLikeObsidian(f);
    expect(split.detached && split2.detached).toBe(true);
    expect(live()).toHaveLength(1);
  });

  it("rapid double open through the command path: no duplicate while the first is still loading", async () => {
    const f = write("a.py");
    await load();
    await Promise.all([plugin.openCodeFile(f), plugin.openCodeFile(f)]);
    expect(created).toHaveLength(1);
    expect(live()).toHaveLength(1);
    expect(revealed.length).toBeGreaterThanOrEqual(2); // the second call focused the first tab
  });

  it("rapid triple open, mixed entry points, in one tick", async () => {
    const f = write("a.py");
    await load();
    await Promise.all([plugin.openCodeFile(f), openLikeObsidian(f), plugin.openCodeFile(f)]);
    expect(live()).toHaveLength(1);
  });

  it("two Obsidian-made leaves given the same file in one tick: exactly one survives", async () => {
    const f = write("a.py");
    await load();
    const [a, b] = await Promise.all([openLikeObsidian(f), openLikeObsidian(f)]);
    expect([a.detached, b.detached].filter(Boolean)).toHaveLength(1);
    expect(live()).toHaveLength(1);
  });

  it("closed then reopened: a closed tab no longer counts", async () => {
    const f = write("a.py");
    await load();
    await plugin.openCodeFile(f);
    const first = live()[0];
    first.detach();
    expect(live()).toHaveLength(0);
    await plugin.openCodeFile(f);
    expect(created).toHaveLength(2);
    expect(live()).toHaveLength(1);
    expect(live()[0]).not.toBe(first);
  });

  it("a tab moved to another file gives the first file back", async () => {
    const a = write("a.py");
    const b = write("b.py");
    await load();
    await plugin.openCodeFile(a);
    const leaf = live()[0];
    plugin.releaseFile(a, leaf as never); // what CodeView does when its file changes
    leaf.file = b;
    leaf.viewState = { type: VIEW, state: { file: b } };
    await plugin.openCodeFile(a);
    expect(live()).toHaveLength(2);
  });

  it("different files each get their own tab", async () => {
    const a = write("a.py");
    const b = write("b.ts");
    await load();
    await plugin.openCodeFile(a);
    await plugin.openCodeFile(b);
    expect(live().map((l) => l.file)).toEqual([a, b]);
  });

  it("a tab restored from the last session that has not loaded yet counts as open", async () => {
    const f = write("a.py");
    await load();
    const restored = new CodeLeaf();
    restored.viewState = { type: VIEW, state: { file: f } }; // deferred: its view never ran setState
    created.push(restored);
    await plugin.openCodeFile(f);
    expect(created).toHaveLength(1);
    expect(revealed).toEqual([restored]);
  });

  it("composed and decomposed spellings of one path are the same file (macOS)", async () => {
    const nfc = "Mock Exams/estimaté tïme 文件.py".normalize("NFC");
    write(nfc);
    await load();
    await plugin.openCodeFile(nfc);
    const second = await openLikeObsidian(nfc.normalize("NFD"));
    expect(second.detached).toBe(true);
    expect(live()).toHaveLength(1);
  });

  it("a failed first open leaves no claim: the next open tries again", async () => {
    const f = write("a.py");
    await load({ codeCliPath: "/nonexistent/code" });
    await plugin.openCodeFile(f);
    expect(live()).toHaveLength(0);
    expect(Notice.messages.length).toBeGreaterThan(0);
    await plugin.openCodeFile(f);
    expect(live()).toHaveLength(0);
    expect(Notice.messages.length).toBeGreaterThan(1); // it tried again
  });
});

describe("quick switcher (G1)", () => {
  /**
   * The quick switcher lists the files whose extension has a registered view type, and choosing one
   * opens a leaf with the view type the registry holds for that extension, the file as state. This
   * does the same lookup against what the plugin actually registered, then gives a leaf that state.
   */
  const chooseInSwitcher = async (file: string): Promise<CodeLeaf | null> => {
    const ext = file.split(".").pop()!.toLowerCase();
    const viewType = Plugin.registrations.find((r) => r.extensions.includes(ext))?.viewType;
    if (!viewType) return null; // not offered by the switcher as a code file
    const leaf = app.workspace.getLeaf("tab") as unknown as CodeLeaf;
    await leaf.setViewState({ type: viewType, state: { file }, active: true } as { type: string; state?: unknown });
    return leaf;
  };

  it.each(["scripts/estimate_time.py", "src/app.ts", "package.json", "run.sh"])("choosing %s opens a Code tab showing it", async (file) => {
    write(file);
    await load();
    await plugin.rescanExtensions(); // joins the scan onload started
    const leaf = await chooseInSwitcher(file);
    expect(leaf, "the extension is registered, so the switcher offers it").not.toBeNull();
    expect(leaf!.detached).toBe(false);
    expect(live().map((l) => l.file)).toEqual([file]);
  });

  it("choosing a file that is already open adds no tab", async () => {
    const f = write("run.sh");
    await load();
    await plugin.rescanExtensions();
    await chooseInSwitcher(f);
    const again = await chooseInSwitcher(f);
    expect(again!.detached).toBe(true);
    expect(live()).toHaveLength(1);
  });

  it("an extension no file in the vault has is not registered, so the switcher would not offer it as a code file", async () => {
    write("run.sh");
    await load();
    await plugin.rescanExtensions();
    expect(await chooseInSwitcher("later.py")).toBeNull();
  });
});

describe("what never opens in a Code tab (F6)", () => {
  it.each(["note.md", "board.canvas", "tasks.base", "pic.png", "doc.pdf", "bundle.zip", "song.mp3", "clip.mp4", ".git/config", "node_modules/a/b.js"])(
    "%s: an explicit open makes no tab and starts no server",
    async (file) => {
      write(file, "x");
      await load();
      await plugin.openCodeFile(file);
      expect(created).toHaveLength(0);
      expect(Notice.messages).toHaveLength(1);
      expect(serverPids()).toEqual([]);
    },
  );

  it("a leaf Obsidian gives a markdown file is closed, not left blank", async () => {
    write("note.md", "# hi");
    await load();
    const leaf = await openLikeObsidian("note.md");
    expect(leaf.detached).toBe(true);
  });
});

describe("the binary and huge-file guard at open (E6)", () => {
  it("a file over 2 MB is refused with a notice, handed to the system app, and starts no server", async () => {
    const f = write("big.log", Buffer.alloc(2_097_153, 0x61));
    await load({ serverLicenceAccepted: false });
    await plugin.openCodeFile(f);
    expect(created).toHaveLength(0);
    expect(Notice.messages).toHaveLength(1);
    expect(Notice.messages[0]).toMatch(/big\.log.*larger than 2 MB/);
    expect(systemApp).toEqual([f]);
    expect(Modal.opened).toHaveLength(0); // no licence modal for a file that is refused anyway
    expect(serverPids()).toEqual([]);
  });

  it("2,097,152 bytes opens", async () => {
    const f = write("edge.txt", Buffer.alloc(2_097_152, 0x61));
    await load();
    await plugin.openCodeFile(f);
    expect(live()).toHaveLength(1);
    expect(systemApp).toEqual([]);
  });

  it("a 500 MB sparse file is refused", async () => {
    const f = write("huge.log", "");
    fs.truncateSync(path.join(vault, f), 500 * 1024 * 1024);
    await load();
    await plugin.openCodeFile(f);
    expect(live()).toHaveLength(0);
    expect(systemApp).toEqual([f]);
  });

  it("a null byte at offset 8191 is refused, at 8192 it opens", async () => {
    const nulAt = (n: number) => {
      const b = Buffer.alloc(20_000, 0x61);
      b[n] = 0;
      return b;
    };
    const refused = write("a.dat", nulAt(8191));
    const fine = write("b.dat", nulAt(8192));
    await load();
    await plugin.openCodeFile(refused);
    expect(live()).toHaveLength(0);
    expect(systemApp).toEqual([refused]);
    expect(Notice.messages[0]).toMatch(/binary/);
    await plugin.openCodeFile(fine);
    expect(live().map((l) => l.file)).toEqual([fine]);
  });

  it("a refused file given to a leaf by Obsidian (explorer click) closes that leaf, notifies and goes to the system app", async () => {
    const f = write("big.log", Buffer.alloc(3_000_000, 0x61));
    await load();
    const leaf = await openLikeObsidian(f);
    expect(leaf.detached).toBe(true);
    expect(Notice.messages[0]).toMatch(/larger than 2 MB/);
    expect(systemApp).toEqual([f]);
    // The failed claim is released: a smaller file with the same path would open.
    fs.writeFileSync(path.join(vault, f), "small");
    const again = await openLikeObsidian(f);
    expect(again.detached).toBe(false);
  });

  it("a file that cannot be read (deleted behind a restored tab) gets a notice, no tab and no system app", async () => {
    await load();
    const leaf = await openLikeObsidian("gone/deleted.py");
    expect(leaf.detached).toBe(true);
    expect(Notice.messages.join("\n")).toMatch(/deleted\.py could not be read/);
    expect(systemApp).toEqual([]);
  });

  it("an empty file, a UTF-8 file and a file with spaces and non-ASCII in its path open normally", async () => {
    const files = [write("empty.txt", ""), write("utf8.txt", "héllo — 文件 ✓\n".repeat(1000)), write("Mock Exams/scripts/estimaté tïme 文件.py", "x = 1\n")];
    await load();
    for (const f of files) await plugin.openCodeFile(f);
    expect(live().map((l) => l.file)).toEqual(files);
    expect(Notice.messages.filter((m) => !/downloading the VS Code server/.test(m))).toEqual([]);
  });
});

/**
 * PR-4 R7: the same rules through the REAL CodeView. The leaf here builds a CodeView the way Obsidian's view
 * registry does (`new CodeView(leaf, plugin)`, onOpen, then setState with the saved state) and nothing replaces
 * setState, so the view's own leaf-reuse paths (the same file again, a tab moved to another file, a close) run.
 */
describe("the real CodeView (PR-4 R7)", () => {
  /** A webview stand-in: reports dom-ready once its src is set, and reads as a clean buffer. */
  class FakeEmbed {
    attrs: Record<string, string> = {};
    style: Record<string, string> = {};
    private listeners: Record<string, Array<() => void>> = {};
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
      if (k === "src" && !this.attrs.fired) {
        this.attrs.fired = "1";
        setTimeout(() => this.fire("dom-ready"), 0);
      }
    }
    addEventListener(n: string, fn: () => void) {
      (this.listeners[n] ??= []).push(fn);
    }
    removeEventListener() {}
    fire(n: string) {
      for (const fn of this.listeners[n]?.splice(0) ?? []) fn();
    }
    async executeJavaScript(code: string) {
      return code === DIRTY_SCRIPT ? false : "seeded"; // clean
    }
    focused = 0;
    focus() {
      this.focused += 1;
    }
    remove() {}
  }
  class FakeContent {
    children: unknown[] = [];
    style: Record<string, string> = {};
    addClass() {}
    empty() {
      this.children = [];
    }
    appendChild(c: unknown) {
      this.children.push(c);
    }
    createDiv() {
      return new FakeContent();
    }
    createEl() {
      return new FakeContent();
    }
    remove() {}
    isShown() {
      return true;
    }
  }

  class RealLeaf extends WorkspaceLeaf {
    view: CodeView | null = null;
    get file(): string | null {
      return this.view?.filePath || null;
    }
    async setViewState(s: { type: string; state?: unknown }): Promise<void> {
      this.viewState = s;
      if (s.type !== VIEW) return;
      if (!this.view) {
        this.view = new CodeView(this as never, plugin as never);
        (this.view as unknown as { contentEl: unknown }).contentEl = new FakeContent();
        await this.view.onOpen();
      }
      await this.view.setState(s.state, {} as never);
      if (this.detached) return;
      this.viewState = { type: VIEW, state: this.view.getState() };
    }
    detach(): void {
      if (this.detached) return;
      super.detach();
      void this.view?.onClose();
    }
  }

  const realLive = () => created.filter((l) => !l.detached && l.viewState?.type === VIEW) as unknown as RealLeaf[];

  async function loadReal(): Promise<void> {
    await load({ embed: "webview" });
    app.workspace.getLeaf = () => {
      const l = new RealLeaf();
      created.push(l as never);
      return l as never;
    };
    vi.stubGlobal("document", { body: { classList: { contains: () => false } }, createElement: () => new FakeEmbed() });
  }

  const openReal = async (file: string): Promise<RealLeaf> => {
    const leaf = app.workspace.getLeaf("tab") as unknown as RealLeaf;
    await leaf.setViewState({ type: VIEW, state: { file } });
    return leaf;
  };

  it("the same file given to a second real tab: that tab closes itself and the first stays, focused", async () => {
    const f = write("a.py");
    await loadReal();
    await plugin.openCodeFile(f);
    const first = realLive()[0];
    expect(first.file).toBe(f);
    const second = await openReal(f);
    expect(second.detached).toBe(true);
    expect(realLive()).toEqual([first]);
    expect(revealed[revealed.length - 1]).toBe(first as never);
  });

  it("given the same file again, a tab that already shows it is left alone (no second load)", async () => {
    const f = write("a.py");
    await loadReal();
    await plugin.openCodeFile(f);
    const first = realLive()[0];
    const frame = (first.view as unknown as { frame: FakeEmbed }).frame;
    await first.setViewState({ type: VIEW, state: { file: f } });
    expect((first.view as unknown as { frame: FakeEmbed }).frame).toBe(frame);
    expect(realLive()).toEqual([first]);
  });

  it("a tab moved to another file gives the first file back: opening it again makes a tab, and the moved tab owns the new file", async () => {
    const a = write("a.py");
    const b = write("b.py");
    await loadReal();
    await plugin.openCodeFile(a);
    const leaf = realLive()[0];
    await leaf.setViewState({ type: VIEW, state: { file: b } }); // navigated in place; the buffer is clean
    expect(leaf.file).toBe(b);
    await plugin.openCodeFile(a);
    expect(realLive()).toHaveLength(2);
    expect(realLive().map((l) => l.file).sort()).toEqual([a, b]);
    // b is claimed by the moved tab now: a second tab for it is refused
    const dup = await openReal(b);
    expect(dup.detached).toBe(true);
    expect(realLive()).toHaveLength(2);
  });

  it("hiding the drawer over a Code tab hands keyboard focus to that leaf's real CodeView embed (G1)", async () => {
    const f = write("a.py");
    await loadReal();
    await plugin.openCodeFile(f);
    const tab = realLive()[0];
    const embed = (tab.view as unknown as { frame: FakeEmbed }).frame;
    const before = embed.focused;
    (plugin as unknown as { focusLeafView(leaf: unknown): void }).focusLeafView(tab); // what the drawer's focus-return calls on hide
    expect(embed.focused).toBe(before + 1);
  });

  it("a tab closed through the real view gives its file back", async () => {
    const f = write("a.py");
    await loadReal();
    await plugin.openCodeFile(f);
    const first = realLive()[0];
    first.detach();
    await vi.waitFor(() => expect(first.detached).toBe(true));
    await vi.waitFor(() => expect((plugin as unknown as { openFiles: { existing(f: string): unknown } }).openFiles.existing(f)).toBeNull());
    await plugin.openCodeFile(f);
    expect(realLive()).toHaveLength(1);
    expect(realLive()[0]).not.toBe(first);
  });

  describe("a file opened from inside a Code tab's editor (PR-4)", () => {
    const AUTH = "127.0.0.1:5555";
    const target = (abs: string) => targetOfUri(buildFileUri(`http://${AUTH}`, abs), AUTH, vault);
    const inVault = (rel: string) => target(path.join(vault, rel));
    const script = (leaf: RealLeaf) => ((leaf.view as unknown as { frame: FakeEmbed }).frame as FakeEmbed & { ran: string[] }).ran;
    const opened: Array<{ file: string; active: unknown }> = [];
    /** Every leaf the plugin asked the workspace for, with the kind it asked for and the view state it gave that leaf. */
    const asked: Array<{ kind: unknown; viewState: { type: string; state?: unknown; active?: unknown } | null }> = [];

    /** The real plugin and real CodeViews; the fake webview records every script run in it, and Obsidian's own open is recorded. */
    async function setup(): Promise<void> {
      await loadReal();
      opened.length = 0;
      asked.length = 0;
      vi.stubGlobal("document", {
        body: { classList: { contains: () => false } },
        createElement: () => {
          const e = new FakeEmbed() as FakeEmbed & { ran: string[] };
          e.ran = [];
          // a real webview reports dom-ready for the server's origin page and again for the workbench page
          const set = e.setAttribute.bind(e);
          let srcs = 0;
          e.setAttribute = (k: string, v: string) => {
            set(k, v);
            if (k === "src" && ++srcs === 2) setTimeout(() => e.fire("dom-ready"), 0);
          };
          const run = e.executeJavaScript.bind(e);
          e.executeJavaScript = async (code: string) => (e.ran.push(code), run(code));
          return e;
        },
      });
      const getLeaf = app.workspace.getLeaf;
      app.workspace.getLeaf = ((kind: string) => {
        const l = getLeaf(kind) as unknown as RealLeaf & { openFile?: (f: TFile, o: unknown) => Promise<void> };
        const record: (typeof asked)[number] = { kind, viewState: null };
        asked.push(record);
        const setViewState = l.setViewState.bind(l);
        l.setViewState = async (s: { type: string; state?: unknown; active?: unknown }) => {
          record.viewState = { ...s };
          await setViewState(s);
        };
        l.openFile = async (f, o) => void opened.push({ file: f.path, active: (o as { active?: unknown }).active });
        return l as never;
      }) as never;
    }
    const goLines = (leaf: RealLeaf) => script(leaf).filter((c) => c.includes("quick-input-widget"));
    const settle = () => new Promise((r) => setTimeout(r, 20));

    it("a code file becomes a new Code tab at the line, and the tab it came from is untouched", async () => {
      const a = write("t/pd.js");
      const helper = write("t/helper.js");
      await setup();
      await plugin.openCodeFile(a);
      const first = realLive()[0];
      await plugin.openFromEditor(first as never, inVault(helper), 5);
      await settle();
      expect(realLive()).toHaveLength(2);
      const second = realLive()[1];
      expect(second.file).toBe(helper);
      expect(first.file).toBe(a);
      expect(second.viewState).toEqual({ type: VIEW, state: { file: helper } }); // the line is not persisted
      expect(goLines(second)).toHaveLength(1);
      expect(goLines(second)[0]).toContain("const line = 5;");
      expect(goLines(first)).toEqual([]);
      expect(revealed[revealed.length - 1]).toBe(second as never); // in front
    });

    it("C25: the open asks the workspace for a new tab (getLeaf('tab')) and gives it active: true; the same file again asks for no leaf and focuses (Code tab and Obsidian view)", async () => {
      const a = write("t/pd.js");
      const helper = write("t/helper.js");
      const note = write("n/daily.md", "x\n");
      await setup();
      await plugin.openCodeFile(a);
      asked.length = 0;
      const first = realLive()[0];
      await plugin.openFromEditor(first as never, inVault(helper), 5);
      expect(asked).toHaveLength(1);
      expect(asked[0].kind).toBe("tab");
      expect(asked[0].viewState).toEqual({ type: VIEW, state: { file: helper, line: 5 }, active: true }); // the line travels in the state of the view being made
      const second = realLive()[1];
      // the same file reached again: no leaf is asked for, the tab it has is revealed
      asked.length = 0;
      await plugin.openFromEditor(first as never, inVault(helper), 9);
      expect(asked).toEqual([]);
      expect(revealed[revealed.length - 1]).toBe(second as never);
      // an Obsidian view is also opened in a new tab, active
      await plugin.openFromEditor(first as never, inVault(note), 1);
      expect(asked).toHaveLength(1);
      expect(asked[0].kind).toBe("tab");
      expect(opened).toEqual([{ file: note, active: true }]);
    });

    it("C16: a declined licence on an opened-from-editor file opens it in the system app; a failed server start gives the notice the plugin already shows; neither leaves a blank or extra tab", async () => {
      const a = write("t/pd.js");
      const declined = write("t/declined.js");
      const failed = write("t/failed.js");
      await setup();
      await plugin.openCodeFile(a);
      const first = realLive()[0];
      const before = created.length;
      const ensure = vi.spyOn(plugin as unknown as { ensureServer: () => Promise<unknown> }, "ensureServer");
      ensure.mockRejectedValueOnce(new LicenceDeclinedError());
      await plugin.openFromEditor(first as never, inVault(declined), 3);
      expect(systemApp).toEqual([declined]);
      expect(created).toHaveLength(before); // no leaf was made for it, so nothing blank
      ensure.mockRejectedValueOnce(new Error("server broke")); // main.ts has shown the reason before it rejects
      await plugin.openFromEditor(first as never, inVault(failed), 3);
      expect(systemApp).toEqual([declined]);
      expect(created).toHaveLength(before);
      expect(realLive()).toEqual([first]);
      expect(first.file).toBe(a);
    });

    it("E4: the open is made from the tab it came from: that tab is made the active one first when it is not (a Code tab in a split pane)", async () => {
      const a = write("t/pd.js");
      const helper = write("t/helper.js");
      await setup();
      await plugin.openCodeFile(a);
      const first = realLive()[0];
      const order: string[] = [];
      let active: unknown = null;
      const ws = app.workspace as unknown as { activeLeaf: unknown; setActiveLeaf: (l: unknown, o: unknown) => void; getLeaf: (k: string) => unknown };
      ws.setActiveLeaf = (l: unknown) => void (order.push("activate"), (active = l));
      const getLeaf = ws.getLeaf;
      ws.getLeaf = (k: string) => (order.push(`getLeaf:${k}:from-active=${active === first}`), getLeaf(k));
      active = new RealLeaf(); // another pane has the focus
      await plugin.openFromEditor(first as never, inVault(helper), 5);
      expect(order.slice(0, 2)).toEqual(["activate", "getLeaf:tab:from-active=true"]);
    });

    it("E4: with two Code tabs in two panes, an open from each lands as a new tab in that pane's own tab group, and the other pane gets none", async () => {
      const a = write("t/pd.js");
      const b = write("t/other.js");
      const helperA = write("t/helper-a.js");
      const helperB = write("t/helper-b.js");
      await setup();
      await plugin.openCodeFile(a);
      await plugin.openCodeFile(b);
      const [left, right] = realLive();
      // a model of panes: a new tab (getLeaf("tab")) joins the group of whichever leaf is active
      const group = new Map<unknown, string>([[left, "left"], [right, "right"]]);
      let active: unknown = left; // the user is in the left pane
      const ws = app.workspace as unknown as { getMostRecentLeaf: () => unknown; setActiveLeaf: (l: unknown) => void; getLeaf: (k: string) => unknown };
      ws.getMostRecentLeaf = () => active;
      ws.setActiveLeaf = (l) => void (active = l);
      const getLeaf = ws.getLeaf;
      ws.getLeaf = (k) => {
        const l = getLeaf(k);
        group.set(l, group.get(active) ?? "none");
        return l;
      };
      await plugin.openFromEditor(right as never, inVault(helperB), 2); // from the right pane while the left one is active
      await plugin.openFromEditor(left as never, inVault(helperA), 2); // from the left pane, now that the right one is active
      await settle();
      const byFile = (f: string) => realLive().find((l) => l.file === f) as RealLeaf;
      expect(realLive()).toHaveLength(4);
      expect(group.get(byFile(helperB))).toBe("right");
      expect(group.get(byFile(helperA))).toBe("left");
      // each tab still shows only its own file
      expect([left.file, right.file]).toEqual([a, b]);
      expect(realLive().map((l) => l.file).sort()).toEqual([a, b, helperA, helperB].sort());
    });

    it("the same definition reached again focuses the tab that already shows it and moves its cursor, with no second tab (E3)", async () => {
      const a = write("t/pd.js");
      const helper = write("t/helper.js");
      await setup();
      await plugin.openCodeFile(a);
      const first = realLive()[0];
      await plugin.openFromEditor(first as never, inVault(helper), 5);
      const second = realLive()[1];
      const before = created.length;
      await plugin.openFromEditor(first as never, inVault(helper), 7);
      await settle();
      expect(created).toHaveLength(before);
      expect(realLive()).toHaveLength(2);
      expect(revealed[revealed.length - 1]).toBe(second as never);
      // the second ask came before the new tab's workbench page had loaded: the latest line wins and the cursor is moved once
      expect(goLines(second).map((c) => /const line = (\d+);/.exec(c)?.[1])).toEqual(["7"]);
      // and once the page is up, a further ask moves the cursor there at once
      await plugin.openFromEditor(first as never, inVault(helper), 9);
      await settle();
      expect(goLines(second).map((c) => /const line = (\d+);/.exec(c)?.[1])).toEqual(["7", "9"]);
    });

    it("a definition in the file the first tab shows (its own file) is the same file: that tab is focused, no new tab", async () => {
      const a = write("t/pd.js");
      await setup();
      await plugin.openCodeFile(a);
      const first = realLive()[0];
      await plugin.openFromEditor(first as never, inVault(a), 2);
      await settle();
      expect(realLive()).toEqual([first]);
      expect(goLines(first)).toHaveLength(1);
    });

    it("two opens of one new file at once make one tab", async () => {
      const a = write("t/pd.js");
      const helper = write("t/helper.js");
      await setup();
      await plugin.openCodeFile(a);
      const first = realLive()[0];
      await Promise.all([plugin.openFromEditor(first as never, inVault(helper), 5), plugin.openFromEditor(first as never, inVault(helper), 6)]);
      expect(realLive().map((l) => l.file).sort()).toEqual([a, helper].sort());
    });

    it("an open tab restored from the last session counts: it is focused, not duplicated", async () => {
      const a = write("t/pd.js");
      const helper = write("t/helper.js");
      await setup();
      await plugin.openCodeFile(a);
      const restored = new RealLeaf();
      created.push(restored as never);
      restored.viewState = { type: VIEW, state: { file: helper } }; // saved layout state, the view never loaded
      (restored as unknown as { loadIfDeferred: () => Promise<void> }).loadIfDeferred = async () => void (await restored.setViewState({ type: VIEW, state: { file: helper } }));
      await plugin.openFromEditor(realLive()[0] as never, inVault(helper), 4);
      await settle();
      expect(realLive().filter((l) => l.viewState?.type === VIEW)).toHaveLength(2);
      expect(revealed[revealed.length - 1]).toBe(restored as never);
      expect(restored.file).toBe(helper);
    });

    it.each(["Notes/daily note.md", "Board.canvas", "Tasks.base", "img/shot.png", "docs/paper.pdf"])("%s opens through Obsidian, in a new tab and in front, and no Code tab is made", async (rel) => {
      const a = write("t/pd.js");
      write(rel, rel.endsWith(".png") || rel.endsWith(".pdf") ? Buffer.from([1, 2, 3]) : "x\n");
      await setup();
      await plugin.openCodeFile(a);
      await plugin.openFromEditor(realLive()[0] as never, inVault(rel), 3);
      expect(opened).toEqual([{ file: rel, active: true }]);
      expect(realLive()).toHaveLength(1);
    });

    it("a note that is not in the vault index says so and opens nothing", async () => {
      const a = write("t/pd.js");
      await setup();
      await plugin.openCodeFile(a);
      await plugin.openFromEditor(realLive()[0] as never, inVault("gone/missing.md"), 3);
      expect(opened).toEqual([]);
      expect(Notice.messages.at(-1)).toContain("missing.md is not in this vault");
    });

    it("a file outside the vault opens nothing and shows a notice naming it", async () => {
      const a = write("t/pd.js");
      await setup();
      await plugin.openCodeFile(a);
      await plugin.openFromEditor(realLive()[0] as never, target("/usr/lib/node_modules/typescript/lib/lib.d.ts"), 3);
      expect(realLive()).toHaveLength(1);
      expect(opened).toEqual([]);
      expect(Notice.messages.at(-1)).toContain("lib.d.ts is outside this vault");
    });

    it("a binary and an over-2 MB file go through the Code tab path and are refused there, exactly as an explorer click is", async () => {
      const a = write("t/pd.js");
      const zip = write("bin/tool.zip", Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]));
      const huge = write("data/huge.json", Buffer.alloc(2 * 1024 * 1024 + 10, "a"));
      await setup();
      await plugin.openCodeFile(a);
      const noticesBefore = Notice.messages.length;
      await plugin.openFromEditor(realLive()[0] as never, inVault(zip), 1);
      await plugin.openFromEditor(realLive()[0] as never, inVault(huge), 1);
      await settle();
      expect(realLive().map((l) => l.file)).toEqual([a]);
      expect(Notice.messages.length).toBeGreaterThan(noticesBefore);
    });

    it("a file in a hidden folder (.git, .obsidian, node_modules) is refused by the existing rule, with no tab", async () => {
      const a = write("t/pd.js");
      const hidden = [write(".git/config"), write(".obsidian/app.json"), write("node_modules/lib/index.js")];
      await setup();
      await plugin.openCodeFile(a);
      for (const h of hidden) await plugin.openFromEditor(realLive()[0] as never, inVault(h), 1);
      await settle();
      expect(realLive().map((l) => l.file)).toEqual([a]);
    });

    it("an extension the user left to other plugins goes to Obsidian", async () => {
      write("t/helper.js");
      await setup();
      await plugin.updateSettings({ excludeExtensions: ["js"] });
      await plugin.openFromEditor(new RealLeaf() as never, inVault("t/helper.js"), 1);
      expect(opened).toEqual([{ file: "t/helper.js", active: true }]);
    });

    it("a file with spaces, accents, CJK and emoji in its name opens as one tab, found again by the other Unicode form", async () => {
      const a = write("t/pd.js");
      const name = write("src/estimaté tïme 文件 🚀.ts");
      await setup();
      await plugin.openCodeFile(a);
      const first = realLive()[0];
      await plugin.openFromEditor(first as never, inVault(name), 3);
      await plugin.openFromEditor(first as never, inVault(name.normalize("NFD")), 4);
      await settle();
      expect(realLive()).toHaveLength(2);
    });

    it("a line that is zero, negative or past the end never breaks the open (the tab opens; the page script clamps)", async () => {
      const a = write("t/pd.js");
      const h = write("t/helper.js");
      const h2 = write("t/h2.js");
      await setup();
      await plugin.openCodeFile(a);
      await plugin.openFromEditor(realLive()[0] as never, inVault(h), 0);
      await plugin.openFromEditor(realLive()[0] as never, inVault(h2), 99999999);
      await settle();
      const [, one, two] = realLive();
      expect(realLive()).toHaveLength(3);
      void h;
      expect(goLines(one)[0]).toContain("const line = 1;");
      expect(goLines(two)[0]).toContain("const line = 99999999;");
    });

    it("openCodeFile without a line leaves the cursor alone (the explorer, the quick switcher, the command)", async () => {
      const a = write("t/pd.js");
      await setup();
      await plugin.openCodeFile(a);
      await plugin.openCodeFile(a);
      expect(goLines(realLive()[0])).toEqual([]);
    });
  });
});
