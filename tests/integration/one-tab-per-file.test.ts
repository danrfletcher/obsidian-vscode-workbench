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
