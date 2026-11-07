/**
 * The quit and restart prompts, through the plugin's own paths (src/main.ts `onQuit` and `restartServer`) with real Code tabs whose
 * pages answer the real DIRTY_SCRIPT (PR-5 R4). The prompts are the only thing replaced: they record the file names they were
 * given, so what is checked is the list the plugin builds from its tabs, not a copy of its filter.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSystemAdapter, Modal, Notice, Plugin, WorkspaceLeaf, type MockApp } from "../mocks/obsidian";
import { CodeView, DIRTY_SCRIPT } from "../../src/code-view";
import { FAKE_CODE, FakeWebview, isAlive, tempDir } from "../helpers";

const asked = vi.hoisted(() => ({ quit: [] as string[][], restart: [] as string[][] }));
vi.mock("../../src/modals", async (original) => ({
  ...(await original<typeof import("../../src/modals")>()),
  promptSaveOrDiscard: vi.fn(async (_app: unknown, names: string[]) => (asked.quit.push(names), "discard" as const)),
  promptRestartWithDirty: vi.fn(async (_app: unknown, files: string[]) => (asked.restart.push(files), false)),
}));

// Imported after the mock so main.ts sees the recording prompts.
const { default: VSCodeWorkbenchPlugin } = await import("../../src/main");

const MARK = "\u25cf";

/** A page whose window title is the signal; the real DIRTY_SCRIPT runs against it. */
class Page extends FakeWebview {
  title = "a.py \u2014 Visual Studio Code";
  override executeJavaScript(code: string) {
    if (code !== DIRTY_SCRIPT) return super.executeJavaScript(code);
    const doc = { title: this.title, querySelector: (sel: string) => (sel === ".monaco-workbench" ? {} : null) };
    try {
      return Promise.resolve(new Function("document", `return ${DIRTY_SCRIPT}`)(doc));
    } catch (e) {
      return Promise.reject(e);
    }
  }
}

let vault: string;
let pidFile: string;
let plugin: InstanceType<typeof VSCodeWorkbenchPlugin>;
let pages: Page[];

function makeApp(root: string): MockApp {
  const workspace = {
    onLayoutReady: () => undefined, // the terminal drawer mounts there; these tests are about the Code tabs
    getActiveFile: () => null,
    getLeavesOfType: () => [],
    getLeaf: () => new WorkspaceLeaf(),
    revealLeaf: async () => undefined,
    detachLeavesOfType: () => undefined,
    on: (name: string, cb: (...args: any[]) => void) => ({ name, cb }),
  };
  return { vault: { adapter: new FileSystemAdapter(root), configDir: ".obsidian", getAbstractFileByPath: () => null, on: (name: string, cb: (...args: any[]) => void) => ({ name, cb }) }, workspace } as unknown as MockApp;
}

/** A real Code tab, hosted by the real plugin, showing `file` in a page of the stand-in kind. */
async function openTab(file: string): Promise<{ view: CodeView; page: () => Page }> {
  fs.mkdirSync(path.dirname(path.join(vault, file)), { recursive: true });
  fs.writeFileSync(path.join(vault, file), "x = 1\n");
  const leaf = new WorkspaceLeaf();
  const view = new CodeView(leaf as never, plugin as never);
  const contentEl = new FakeWebview("div");
  (view as unknown as { contentEl: FakeWebview }).contentEl = contentEl;
  await view.onOpen(); // tracks itself with the plugin, as Obsidian's open does
  await view.setState({ file }, {} as never);
  const page = () => contentEl.children.at(-1) as Page;
  return { view, page };
}

beforeEach(async () => {
  vault = tempDir();
  pidFile = path.join(tempDir(), "pids");
  pages = [];
  asked.quit.length = 0;
  asked.restart.length = 0;
  Plugin.reset();
  Notice.reset();
  Modal.reset();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.stubGlobal("window", { addEventListener: () => undefined });
  vi.stubGlobal("document", {
    body: { classList: { contains: () => false } },
    createElement: (tag: string) => {
      const p = new Page(tag);
      pages.push(p);
      return p;
    },
  });
  Object.assign(process.env, { FAKE_CODE_NODE: process.execPath, FAKE_CODE_PIDFILE: pidFile });
  plugin = new VSCodeWorkbenchPlugin(makeApp(vault) as never, { id: "vscode-workbench", dir: ".obsidian/plugins/vscode-workbench" } as never);
  (plugin as unknown as { pluginData: unknown }).pluginData = { codeCliPath: FAKE_CODE, embed: "webview", serverLicenceAccepted: true };
  await plugin.onload();
});

afterEach(async () => {
  plugin?.onunload();
  await new Promise((r) => setTimeout(r, 400));
  if (fs.existsSync(pidFile)) for (const pid of fs.readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number)) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  for (const k of ["FAKE_CODE_NODE", "FAKE_CODE_PIDFILE"]) delete process.env[k];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("quit and restart list the tabs whose own title carries the mark (E5)", () => {
  it("Obsidian's quit prompt names the dirty tab only; two files of one name in different folders are told apart", async () => {
    const typed = await openTab("x/a.py");
    await openTab("y/a.py");
    await openTab("z/b.py");
    typed.page().title = `${MARK} a.py \u2014 Visual Studio Code`;
    await (plugin as unknown as { onQuit(): Promise<void> }).onQuit();
    expect(asked.quit).toEqual([["a.py"]]); // x/a.py, by its base name; y/a.py and z/b.py are not listed
  });

  it("a quit with every tab saved asks nothing", async () => {
    await openTab("x/a.py");
    await openTab("z/b.py");
    await (plugin as unknown as { onQuit(): Promise<void> }).onQuit();
    expect(asked.quit).toEqual([]);
  });

  it("the restart prompt names the dirty tab only, and answering No restarts nothing", async () => {
    await plugin.ensureServer();
    const a = await openTab("x/a.py");
    await openTab("z/b.py");
    a.page().title = `${MARK} a.py \u2014 Visual Studio Code`;
    const pidsBefore = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : "";
    await plugin.restartServer();
    expect(asked.restart).toEqual([["a.py"]]);
    expect(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : "").toBe(pidsBefore);
  });

  it("a tab whose page cannot be read is listed too (unreadable counts as unsaved), at quit as at restart", async () => {
    await plugin.ensureServer();
    const t = await openTab("x/a.py");
    t.page().title = "";
    await plugin.restartServer();
    expect(asked.restart).toEqual([["a.py"]]);
    await (plugin as unknown as { onQuit(): Promise<void> }).onQuit();
    expect(asked.quit).toEqual([["a.py"]]);
  });
});
