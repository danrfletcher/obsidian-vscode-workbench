/**
 * Code tabs against vault events (G2, G3, G4, E13): real CodeView, OpenFiles, TabRegistry and VaultSync, with
 * a fake embed per tab and a fake Obsidian vault. Asserts one prompt per dirty file, that nothing writes to
 * a note, and that a modify event never reaches a tab.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeNode, WorkspaceLeaf as MockLeaf } from "../mocks/obsidian";
import type { WorkspaceLeaf } from "obsidian";
import { CodeView, DIRTY_SCRIPT, type CodeViewHost } from "../../src/code-view";
import { overlayKeybindings, unbindCommands } from "../../src/chrome-settings";
import { OVERLAY_BEGIN, OVERLAY_END } from "../../src/keybinding-overlay";
import type { CloseDirtyRequest } from "../../src/modals";
import { OpenFiles } from "../../src/open-file";
import { carryEdits, readBaseline, statSignature, type CarryResult } from "../../src/rename-carry";
import { TabRegistry } from "../../src/tab-registry";
import { opensInCodeTab } from "../../src/text-file-rules";
import { OBSIDIAN_DELETE_GRACE_MS, trackObsidianDeletes, VaultSync } from "../../src/vault-sync";
import { tempDir } from "../helpers";

class Embed extends FakeNode {
  attrs: Record<string, string> = {};
  srcs: string[] = [];
  keys = 0;
  dirty = false;
  /** Pressing Save All clears the dirty flag, as the real workbench does. */
  savesOnKeys = true;
  dirtyAnswer: (() => Promise<unknown>) | null = null;
  /**
   * The stand-in page's window title; null: derived from `dirty` ("● a.py — Visual Studio Code" when dirty, else the same
   * without the mark). `DIRTY_SCRIPT` runs against this page for real; the page has no VS Code tab strip.
   */
  title: string | null = null;
  /** Whether the stand-in page has a workbench element (false: the signal is missing and the script throws). */
  workbench = true;
  /** Every selector the dirty script asked the stand-in page for. */
  queried: string[] = [];
  private fired: Record<string, Array<() => void>> = {};
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
    if (k === "src") {
      this.srcs.push(v);
      if (this.srcs.length === 1) setTimeout(() => (this.fired["dom-ready"] ?? []).forEach((f) => f()), 0);
    }
  }
  override addEventListener(n: string, f: () => void) {
    (this.fired[n] ??= []).push(f);
    super.addEventListener(n, f);
  }
  /** Every script that was not a dirty read: the two seeds, in order. */
  seeds: string[] = [];
  /** What the trust seed answers. */
  trustAnswer: () => Promise<unknown> = () => Promise.resolve("seeded");
  /** What the settings seed (which carries the keybinding overlay step) answers. */
  seedAnswer: () => Promise<unknown> = () => Promise.resolve("seeded");
  executeJavaScript(code: string) {
    if (code.includes("vscode-web-state-db-global-shared")) {
      this.seeds.push(code);
      return this.trustAnswer();
    }
    if (code.includes("vscode-web-db")) {
      this.seeds.push(code);
      return this.seedAnswer();
    }
    if (code === DIRTY_SCRIPT) return this.dirtyAnswer ? this.dirtyAnswer() : this.readPage();
    return Promise.resolve("seeded");
  }
  /** Runs the real `DIRTY_SCRIPT` against a stand-in page shaped like the signal: a window title, a workbench, no tab strip. */
  private readPage(): Promise<unknown> {
    const title = this.title ?? `${this.dirty ? "\u25cf " : ""}a.py \u2014 Visual Studio Code`;
    const doc = {
      title,
      querySelector: (sel: string) => {
        this.queried.push(sel);
        return sel === ".monaco-workbench" && this.workbench ? {} : null;
      },
    };
    try {
      return Promise.resolve(new Function("document", `return ${DIRTY_SCRIPT}`)(doc));
    } catch (e) {
      return Promise.reject(e);
    }
  }
  sendInputEvent() {
    this.keys++;
    if (this.savesOnKeys) {
      this.onSave?.();
      this.dirty = false;
    }
  }
  /** What the workbench's save does on disk: it writes the buffer to the path the buffer is bound to. */
  onSave: (() => void) | null = null;
  override children: Embed[] = [];
  appendChild(c: Embed) {
    this.children.push(c);
  }
  addClass() {}
  focus() {}
  /** False for a tab in a background pane or behind another tab. */
  shown = true;
  isShown() {
    return this.shown;
  }
}

interface Tab {
  view: CodeView;
  leaf: WorkspaceLeaf & { detached: boolean };
  embed: () => Embed;
}

function world(
  opts: {
    autoSave?: "on" | "off";
    answers?: Array<"save" | "discard" | "cancel">;
    root?: string;
    afterCarry?: () => void;
    trust?: { enabled: () => boolean; held: () => number[]; outcomes: string[]; port?: number };
    /** The host's chrome hiding (the keybinding overlay and its page script); unset: the host gives none. */
    chromeHiding?: CodeViewHost["chromeHiding"];
    /** Collects the listeners the tabs register for the server's state, so a test can announce a restart. */
    serverListeners?: Array<(state: "running" | "stopped") => void>;
  } = {},
) {
  const leaves: Array<WorkspaceLeaf & { detached?: boolean }> = [];
  const open = new OpenFiles<WorkspaceLeaf>(() => leaves.filter((l) => !(l as { detached?: boolean }).detached));
  const registry = new TabRegistry<WorkspaceLeaf>(open);
  const views = new Map<WorkspaceLeaf, CodeView>();
  const sync = new VaultSync<WorkspaceLeaf>({ registry, tabFor: (l) => views.get(l), eligible: (p) => opensInCodeTab(p) });
  const prompts: CloseDirtyRequest[] = [];
  const answers = [...(opts.answers ?? [])];
  const focused: WorkspaceLeaf[] = [];
  const newTabs: string[] = [];
  const carried: Array<{ from: string; to: string; result: CarryResult }> = [];
  const notMoved: Array<{ from: string; to: string }> = [];
  /** Every read of a file's baseline the tabs started (a rename looks at the old path once, in the background), so a test can wait for them. */
  const baselineReads: Array<{ file: string; done: Promise<void> }> = [];
  const root = opts.root;
  const host: CodeViewHost = {
    vaultRoot: () => root ?? "/vault",
    embedElement: () => "webview",
    ensureServer: async () => ({ baseUrl: `http://127.0.0.1:${opts.trust?.port ?? 5555}`, port: opts.trust?.port ?? 5555, token: "tok" }),
    trackView: () => undefined,
    untrackView: () => undefined,
    serverState: () => "running",
    onServerState: (cb) => {
      opts.serverListeners?.push(cb as (state: "running" | "stopped") => void);
      return () => undefined;
    },
    restartServer: async () => undefined,
    userDataCopy: () => null,
    ...(opts.chromeHiding ? { chromeHiding: opts.chromeHiding } : {}),
    ...(opts.trust
      ? {
          trustVaultFolder: () => opts.trust?.enabled() ?? false,
          heldPorts: () => opts.trust?.held() ?? [],
          noteTrustOutcome: (o: string) => void opts.trust?.outcomes.push(o),
        }
      : {}),
    admitFile: async (f, leaf) => open.claim(f, leaf as WorkspaceLeaf) === null,
    releaseFile: (f, leaf) => open.release(f, leaf as WorkspaceLeaf),
    openInSystemApp: () => undefined,
    autoSave: () => opts.autoSave ?? "off",
    confirmClose: async (r) => {
      prompts.push(r);
      return answers.shift() ?? "cancel";
    },
    focusTab: (l) => void focused.push(l),
    openInNewTab: (f) => void newTabs.push(f),
    editsNotMoved: (from, to) => void notMoved.push({ from, to }),
    // The real on-disk move (src/rename-carry.ts) against the temp vault, recording what it decided.
    ...(root
      ? {
          readBaseline: (f: string) => {
            const read = readBaseline(root, f);
            baselineReads.push({ file: f, done: read.then(() => undefined, () => undefined) });
            return read;
          },
          statSignature: (f: string) => statSignature(root, f),
          carryEdits: async (from: string, to: string, baseline: Buffer | null) => {
            const result = await carryEdits(root, from, to, baseline);
            carried.push({ from, to, result });
            opts.afterCarry?.(); // the user keeps typing while the move is under way
            return result;
          },
        }
      : {}),
  };
  const openTab = async (file: string): Promise<Tab> => {
    const leaf = new MockLeaf() as unknown as WorkspaceLeaf & { detached: boolean };
    leaves.push(leaf as never);
    const view = new CodeView(leaf as never, host);
    (view as unknown as { contentEl: Embed }).contentEl = new Embed("div");
    views.set(leaf, view);
    // Obsidian closes the view when a leaf is detached; the mock leaf does not, so this stands in for it.
    leaf.detach = () => {
      leaf.detached = true;
      void view.onClose();
    };
    await view.onOpen();
    await view.setState({ file }, {} as never);
    return { view, leaf, embed: () => (view as unknown as { contentEl: Embed }).contentEl.children.at(-1) as Embed };
  };
  /** What the plugin does when Obsidian creates a file at, or renames one onto, `path`: every Code tab hears of it. */
  const taken = (p: string) => {
    for (const v of views.values()) v.pathTaken(p);
  };
  /** Resolves when every baseline read of `file` started so far has finished and the tab has acted on what it read. */
  const baselineSettled = async (file: string) => {
    await Promise.all(baselineReads.filter((r) => r.file === file).map((r) => r.done));
    await new Promise((r) => setImmediate(r));
  };
  const hasBaselineRead = (file: string) => baselineReads.some((r) => r.file === file);
  return { openTab, open, registry, sync, prompts, focused, newTabs, leaves, carried, notMoved, taken, baselineSettled, hasBaselineRead };
}

beforeEach(() => {
  vi.stubGlobal("document", { createElement: (t: string) => new Embed(t) });
});
afterEach(() => vi.unstubAllGlobals());

describe("closing a Code tab with unsaved edits (G2, E13)", () => {
  it("a clean tab closes with no prompt", async () => {
    const w = world();
    const t = await w.openTab("a.py");
    t.leaf.detach();
    await vi.waitFor(() => expect(t.leaf.detached).toBe(true));
    expect(w.prompts).toEqual([]);
    expect(w.open.entries()).toEqual([]);
  });

  it("Cancel keeps the tab open, claimed and focused", async () => {
    const w = world({ answers: ["cancel"] });
    const t = await w.openTab("a.py");
    t.embed().dirty = true;
    t.leaf.detach();
    await vi.waitFor(() => expect(w.focused).toEqual([t.leaf]));
    expect(t.leaf.detached).toBe(false);
    expect(w.prompts).toEqual([{ file: "a.py", state: "dirty", failed: false }]);
    expect(w.open.entries().map((c) => c.path)).toEqual(["a.py"]);
  });

  it("Discard closes without pressing save", async () => {
    const w = world({ answers: ["discard"] });
    const t = await w.openTab("a.py");
    t.embed().dirty = true;
    t.leaf.detach();
    await vi.waitFor(() => expect(t.leaf.detached).toBe(true));
    expect(t.embed().keys).toBe(0);
  });

  it("Save presses save, waits until clean, then closes", async () => {
    const w = world({ answers: ["save"] });
    const t = await w.openTab("a.py");
    t.embed().dirty = true;
    t.leaf.detach();
    await vi.waitFor(() => expect(t.leaf.detached).toBe(true));
    expect(t.embed().keys).toBeGreaterThan(0);
    expect(t.embed().dirty).toBe(false);
  });

  it("a save that does not take is never treated as a close: the prompt comes back in the 'could not save' wording", async () => {
    const w = world({ answers: ["save", "cancel"] });
    const t = await w.openTab("untitled.py");
    t.embed().dirty = true;
    t.embed().savesOnKeys = false;
    const saved = vi.spyOn(t.view, "saveBuffers").mockResolvedValue(false);
    t.leaf.detach();
    await vi.waitFor(() => expect(w.prompts).toHaveLength(2));
    expect(w.prompts.map((p) => p.failed)).toEqual([false, true]);
    expect(saved).toHaveBeenCalledTimes(1);
    expect(t.leaf.detached).toBe(false);
  });

  it("with auto-save on, an edit that reaches disk during the wait closes with no prompt", async () => {
    const w = world({ autoSave: "on" });
    const t = await w.openTab("a.py");
    t.embed().dirty = true;
    setTimeout(() => (t.embed().dirty = false), 300);
    t.leaf.detach();
    await vi.waitFor(() => expect(t.leaf.detached).toBe(true), { timeout: 5000 });
    expect(w.prompts).toEqual([]);
  });

  it("when the dirty state cannot be read, the tab is treated as dirty and the user is asked (never a silent discard)", async () => {
    const w = world({ answers: ["cancel"] });
    const t = await w.openTab("a.py");
    t.embed().dirtyAnswer = async () => {
      throw new Error("page gone");
    };
    t.leaf.detach();
    await vi.waitFor(() => expect(w.prompts).toHaveLength(1));
    expect(w.prompts[0].state).toBe("unreadable");
    expect(t.leaf.detached).toBe(false);
  });

  it("close: a title with the dirty mark asks (Cancel keeps the tab); a page whose title is gone asks in the unreadable wording, never a silent close (E5)", async () => {
    const w = world({ answers: ["cancel", "cancel"] });
    const t = await w.openTab("a.py");
    t.embed().dirty = true;
    t.leaf.detach();
    await vi.waitFor(() => expect(w.prompts).toHaveLength(1));
    expect(w.prompts[0]).toEqual({ file: "a.py", state: "dirty", failed: false });
    await vi.waitFor(() => expect(w.focused).toEqual([t.leaf]));
    t.embed().dirty = false;
    t.embed().title = ""; // the signal is gone
    t.leaf.detach();
    await vi.waitFor(() => expect(w.prompts).toHaveLength(2));
    expect(w.prompts[1].state).toBe("unreadable");
    expect(t.leaf.detached).toBe(false);
  });

  it("an embed that never answers is unreadable too, after a timeout", async () => {
    const w = world({ answers: ["cancel"] });
    const t = await w.openTab("a.py");
    vi.useFakeTimers();
    try {
      t.embed().dirtyAnswer = () => new Promise(() => undefined);
      t.leaf.detach();
      await vi.advanceTimersByTimeAsync(3500);
      expect(w.prompts.map((p) => p.state)).toEqual(["unreadable"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("'close all' and 'close others' ask once per dirty file, however many times detach is called", async () => {
    const w = world({ answers: ["discard", "discard"] });
    const a = await w.openTab("a.py");
    const b = await w.openTab("b.py");
    const c = await w.openTab("Makefile");
    a.embed().dirty = true;
    b.embed().dirty = true;
    for (const t of [a, b, c]) {
      t.leaf.detach();
      t.leaf.detach();
    }
    await vi.waitFor(() => expect([a, b, c].every((t) => t.leaf.detached)).toBe(true));
    expect(w.prompts.map((p) => p.file).sort()).toEqual(["a.py", "b.py"]);
  });

  it("a dirty tab in a background pane (not on screen) is asked about like any other, once", async () => {
    const w = world({ answers: ["discard"] });
    const front = await w.openTab("front.py");
    const back = await w.openTab("back.py");
    (back.view as unknown as { contentEl: Embed }).contentEl.shown = false;
    expect(back.view.isVisible()).toBe(false);
    back.embed().dirty = true;
    back.leaf.detach();
    back.leaf.detach();
    await vi.waitFor(() => expect(back.leaf.detached).toBe(true));
    expect(w.prompts).toEqual([{ file: "back.py", state: "dirty", failed: false }]);
    expect(front.leaf.detached).toBe(false);
  });

  it("'close others' closes the other tabs only: each dirty one is asked about once, the kept tab is never asked, and Cancel on one does not stop the rest", async () => {
    const w = world({ answers: ["cancel", "save"] });
    const kept = await w.openTab("kept.py");
    const a = await w.openTab("a.py");
    const b = await w.openTab("b.py");
    const clean = await w.openTab("clean.py");
    for (const t of [kept, a, b]) t.embed().dirty = true;
    for (const t of [a, b, clean]) t.leaf.detach(); // what Obsidian does to every tab but the kept one
    await vi.waitFor(() => expect([b, clean].every((t) => t.leaf.detached)).toBe(true));
    expect(w.prompts.map((p) => p.file)).toEqual(["a.py", "b.py"]);
    expect(a.leaf.detached).toBe(false); // cancelled: still open, claimed and focused
    expect(w.focused).toEqual([a.leaf]);
    expect(kept.leaf.detached).toBe(false);
    expect(w.open.entries().map((c) => c.path).sort()).toEqual(["a.py", "kept.py"]);
  });

  it("the close hook is removed when the view closes, so no tab outlives it with a guard", async () => {
    const w = world();
    const t = await w.openTab("a.py");
    t.embed().dirty = true;
    await t.view.onClose();
    t.leaf.detach(); // the original again: no prompt, no hold
    expect(t.leaf.detached).toBe(true);
    expect(w.prompts).toEqual([]);
  });
});

describe("a file chosen in the quick switcher while this Code tab is active (G1, C23)", () => {
  it("a clean tab goes to the chosen file in place: no prompt, the old claim moves, no extra tab", async () => {
    const w = world();
    const t = await w.openTab("a.py");
    await t.view.setState({ file: "b.py" }, {} as never);
    expect(w.prompts).toEqual([]);
    expect(w.newTabs).toEqual([]);
    expect(w.open.entries().map((c) => c.path)).toEqual(["b.py"]);
  });

  it("a dirty tab asks once, and on Cancel keeps its file and its unsaved text while the chosen file opens in a new tab", async () => {
    const w = world({ answers: ["cancel"] });
    const t = await w.openTab("a.py");
    t.embed().dirty = true;
    await t.view.setState({ file: "b.py" }, {} as never);
    expect(w.prompts).toEqual([{ file: "a.py", state: "dirty", failed: false }]);
    expect(w.newTabs).toEqual(["b.py"]);
    expect(t.view.filePath).toBe("a.py");
    expect(w.open.entries().map((c) => c.path)).toEqual(["a.py"]);
    expect(t.embed().dirty).toBe(true); // the buffer is untouched
    expect(t.embed().keys).toBe(0); // nothing pressed, nothing saved
    expect(t.leaf.detached).toBe(false);
  });

  it("Save writes the buffer before the tab moves on; Discard is the user's own choice and moves on without saving", async () => {
    const saved = world({ answers: ["save"] });
    const a = await saved.openTab("a.py");
    const before = a.embed(); // the page the tab had before it moved on
    before.dirty = true;
    await a.view.setState({ file: "b.py" }, {} as never);
    expect(saved.prompts).toHaveLength(1);
    expect(before.keys).toBeGreaterThan(0);
    expect(before.dirty).toBe(false);
    expect(saved.newTabs).toEqual([]);
    expect(a.view.filePath).toBe("b.py");

    const discarded = world({ answers: ["discard"] });
    const d = await discarded.openTab("a.py");
    const old = d.embed();
    old.dirty = true;
    await d.view.setState({ file: "b.py" }, {} as never);
    expect(discarded.prompts).toHaveLength(1);
    expect(old.keys).toBe(0);
    expect(discarded.newTabs).toEqual([]);
    expect(d.view.filePath).toBe("b.py");
  });

  it("choosing the file the dirty tab already shows asks nothing and leaves the buffer alone", async () => {
    const w = world();
    const t = await w.openTab("a.py");
    t.embed().dirty = true;
    await t.view.setState({ file: "a.py" }, {} as never);
    expect(w.prompts).toEqual([]);
    expect(w.newTabs).toEqual([]);
    expect(t.embed().dirty).toBe(true);
    expect(t.embed().keys).toBe(0);
  });
});

describe("the idle clock and the quit prompt ask the tab whether it is unsaved (E13)", () => {
  it("a dirty buffer counts as unsaved, with auto-save off or on; a clean one does not", async () => {
    for (const autoSave of ["off", "on"] as const) {
      const w = world({ autoSave });
      const t = await w.openTab("a.py");
      expect(await t.view.isDirty()).toBe(false);
      t.embed().dirty = true;
      expect(await t.view.isDirty()).toBe(true);
    }
  });

  it("idle clock: a title with the dirty mark keeps the server alive (hasDirtyBuffer), the same page saved does not; the page is the real DIRTY_SCRIPT on a page with no tab strip (E5)", async () => {
    const w = world();
    const t = await w.openTab("a.py");
    const page = t.embed();
    page.dirty = true;
    expect(await t.view.isDirty()).toBe(true);
    page.dirty = false; // saved: the mark leaves the title
    expect(await t.view.isDirty()).toBe(false);
    expect(page.queried.every((sel) => !sel.includes(".tab") && !sel.includes("data-resource-name"))).toBe(true);
  });

  it("quit and restart prompts: the tabs listed are the ones whose own title carries the mark; two files of one name in different folders are told apart (E5)", async () => {
    const w = world();
    const typed = await w.openTab("x/a.py");
    const other = await w.openTab("y/a.py");
    const saved = await w.openTab("z/b.py");
    typed.embed().dirty = true;
    // what the quit and restart prompts do: ask every tab, list the ones that are dirty
    const dirtyFiles = async () => {
      const tabs = [typed, other, saved];
      const flags = await Promise.all(tabs.map((t) => t.view.isDirty()));
      return tabs.filter((_, i) => flags[i]).map((t) => t.view.getState().file);
    };
    expect(await dirtyFiles()).toEqual(["x/a.py"]);
    typed.embed().dirty = false;
    expect(await dirtyFiles()).toEqual([]); // once saved, none of them is listed
  });

  it("a page whose title is empty or that has no workbench counts as unsaved: the script throws, the tab reads unreadable (E5)", async () => {
    const w = world();
    const t = await w.openTab("a.py");
    t.embed().title = "";
    expect(await t.view.bufferState()).toBe("unreadable");
    expect(await t.view.isDirty()).toBe(true);
    t.embed().title = null;
    t.embed().workbench = false;
    expect(await t.view.bufferState()).toBe("unreadable");
    expect(await t.view.isDirty()).toBe(true);
  });

  it("a page with a title and a workbench but no mark reads clean, whether or not an editor is open: nothing typed, nothing to lose (E5)", async () => {
    const w = world();
    const t = await w.openTab("a.py");
    t.embed().title = "Visual Studio Code"; // no editor open
    expect(await t.view.bufferState()).toBe("clean");
    t.embed().title = "a.py \u2014 Visual Studio Code";
    expect(await t.view.bufferState()).toBe("clean");
  });

  it("a page that cannot be asked counts as unsaved: it throws, or the server is down", async () => {
    const w = world();
    const t = await w.openTab("a.py");
    t.embed().dirtyAnswer = async () => {
      throw new Error("Cannot read properties of null: the server is gone");
    };
    expect(await t.view.bufferState()).toBe("unreadable");
    expect(await t.view.isDirty()).toBe(true);
  });

  it("a page that never answers counts as unsaved after a timeout", async () => {
    const w = world();
    const t = await w.openTab("a.py");
    t.embed().dirtyAnswer = () => new Promise(() => undefined);
    vi.useFakeTimers();
    try {
      const asked = t.view.isDirty();
      await vi.advanceTimersByTimeAsync(3500);
      expect(await asked).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a tab whose embed has not loaded yet (no page to ask) counts as unsaved", async () => {
    const w = world();
    const leaf = new MockLeaf() as unknown as WorkspaceLeaf;
    const gate: { release: () => void } = { release: () => undefined };
    const view = new CodeView(leaf as never, {
      vaultRoot: () => "/vault",
      embedElement: () => "webview",
      ensureServer: () => new Promise((r) => (gate.release = () => r({ baseUrl: "http://127.0.0.1:5555", port: 5555, token: "tok" }))),
      trackView: () => undefined,
      untrackView: () => undefined,
      serverState: () => "running",
      onServerState: () => () => undefined,
      restartServer: async () => undefined,
      userDataCopy: () => null,
      admitFile: async (f) => w.open.claim(f, leaf as never) === null,
      releaseFile: (f, l) => w.open.release(f, l as never),
      openInSystemApp: () => undefined,
    });
    (view as unknown as { contentEl: Embed }).contentEl = new Embed("div");
    await view.onOpen();
    const loading = view.setState({ file: "a.py" }, {} as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(await view.bufferState()).toBe("unreadable");
    expect(await view.isDirty()).toBe(true);
    gate.release();
    await loading;
    await view.onClose();
  });
});

describe("vault events (G3, G4)", () => {
  it("a rename moves the tab to the new path: title, claim and embedded file follow; the other tab is not reloaded", async () => {
    const w = world();
    const a = await w.openTab("scripts/a b.py");
    const other = await w.openTab("Makefile");
    const otherEmbed = other.embed();
    const otherSrcs = otherEmbed.srcs.length;
    w.sync.onRename("scripts/ünï.ts", "scripts/a b.py");
    expect(a.view.getDisplayText()).toBe("ünï.ts");
    expect(w.open.entries().map((c) => c.path).sort()).toEqual(["Makefile", "scripts/ünï.ts"]);
    await vi.waitFor(() => expect(new URL(a.embed().srcs.at(-1) as string).searchParams.get("payload")).toContain("%C3%BC"));
    const payload = JSON.parse(new URL(a.embed().srcs.at(-1) as string).searchParams.get("payload") as string) as string[][];
    expect(payload[0][1]).toBe(`vscode-remote://127.0.0.1:5555/vault/scripts/${encodeURIComponent("ünï.ts")}`);
    expect(other.embed()).toBe(otherEmbed);
    expect(otherEmbed.srcs).toHaveLength(otherSrcs);
    expect(w.leaves).toHaveLength(2); // no second tab
  });

  it("a rename with unsaved edits does not reload the embed under the edit; it is applied once saved", async () => {
    const w = world();
    const a = await w.openTab("a.py");
    a.embed().dirty = true;
    const first = a.embed();
    w.sync.onRename("b.py", "a.py");
    await new Promise((r) => setTimeout(r, 50));
    expect(a.embed()).toBe(first);
    expect(first.srcs.every((u) => !u.includes("b.py"))).toBe(true);
    expect(a.view.getDisplayText()).toBe("b.py");
    a.embed().dirty = false;
    a.view.notifyVisible();
    await vi.waitFor(() => expect(a.embed().srcs.at(-1)).toContain("b.py"));
  });

  it("a save made inside the embed applies the held-back rename on its own, without a tab switch (PR-5 R4)", async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, "a.py"), "old\n");
    const w = world({ root });
    const t = await w.openTab("a.py");
    t.embed().dirty = true;
    fs.renameSync(path.join(root, "a.py"), path.join(root, "b.py"));
    w.sync.onRename("b.py", "a.py");
    await new Promise((r) => setTimeout(r, 30));
    const first = t.embed();
    // the user presses Cmd+S in the workbench: the file is written at the old path and the buffer reads clean.
    fs.writeFileSync(path.join(root, "a.py"), "edited\n");
    first.dirty = false;
    // no notifyVisible(), no layout-change, no active-leaf event
    await vi.waitFor(() => expect(t.embed().srcs.at(-1)).toContain("b.py"), { timeout: 4000 });
    expect(fs.readFileSync(path.join(root, "b.py"), "utf8")).toBe("edited\n");
    expect(fs.existsSync(path.join(root, "a.py"))).toBe(false);
    expect(w.leaves).toHaveLength(1);
  });

  it("text typed while the held-back rename is being carried is not thrown away by the reload; the next save still ends up in the renamed file (PR-1 R1)", async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, "a.py"), "old\n");
    let typed: (() => void) | null = null;
    const w = world({ root, afterCarry: () => typed?.() });
    const t = await w.openTab("a.py");
    const first = t.embed();
    first.dirty = true;
    first.onSave = () => fs.writeFileSync(path.join(root, "a.py"), "edited again\n"); // the buffer stays bound to a.py
    fs.renameSync(path.join(root, "a.py"), path.join(root, "b.py"));
    w.sync.onRename("b.py", "a.py");
    await new Promise((r) => setTimeout(r, 30));
    // Cmd+S: written at the old path, the buffer reads clean. The next watch tick starts the carry...
    fs.writeFileSync(path.join(root, "a.py"), "edited\n");
    first.dirty = false;
    // ...and during it the user types again.
    typed = () => {
      first.dirty = true;
      typed = null;
    };
    await vi.waitFor(() => expect(w.carried).toHaveLength(1), { timeout: 4000 });
    await new Promise((r) => setTimeout(r, 1500)); // more watch ticks: the buffer is dirty, so nothing may reload
    expect(t.embed()).toBe(first);
    expect(first.srcs.every((u) => !u.includes("b.py"))).toBe(true);
    expect(fs.readFileSync(path.join(root, "b.py"), "utf8")).toBe("edited\n"); // the first save was carried
    expect(fs.existsSync(path.join(root, "a.py"))).toBe(false);
    // the user saves the new text: it lands in a.py, is carried into b.py, and only then does the embed reload
    expect(await t.view.saveBuffers()).toBe(true);
    await vi.waitFor(() => expect(t.embed().srcs.at(-1)).toContain("b.py"), { timeout: 4000 });
    expect(fs.readFileSync(path.join(root, "b.py"), "utf8")).toBe("edited again\n");
    expect(fs.existsSync(path.join(root, "a.py"))).toBe(false);
    expect(w.carried.map((c) => c.result)).toEqual(["carried", "carried"]);
    expect(w.leaves).toHaveLength(1);
  });

  it("the rename-carry runs on the window title alone, with no VS Code tab strip in the page: dirty, then saved at the old path, is carried and the embed moves (E5)", async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, "a.py"), "old\n");
    const w = world({ root });
    const t = await w.openTab("a.py");
    const first = t.embed();
    first.dirty = true; // the title carries the dirty mark
    fs.renameSync(path.join(root, "a.py"), path.join(root, "b.py"));
    w.sync.onRename("b.py", "a.py");
    await new Promise((r) => setTimeout(r, 1300)); // a watch look sees the dirty title
    fs.writeFileSync(path.join(root, "a.py"), "edited\n"); // Cmd+S in the workbench: written at the old path...
    first.dirty = false; // ...and the title loses the mark
    await vi.waitFor(() => expect(w.carried).toHaveLength(1), { timeout: 10000 });
    expect(w.carried.map((c) => c.result)).toEqual(["carried"]);
    await vi.waitFor(() => expect(t.embed().srcs.at(-1)).toContain("b.py"), { timeout: 10000 });
    expect(fs.readFileSync(path.join(root, "b.py"), "utf8")).toBe("edited\n");
    expect(fs.existsSync(path.join(root, "a.py"))).toBe(false);
    expect(w.notMoved).toEqual([]);
    // the page the tab was asked about never had a tab strip, and the script never asked for one or for a file name
    expect(first.queried.length).toBeGreaterThan(0);
    expect(first.queried.every((sel) => !sel.includes(".tab") && !sel.includes("data-resource-name"))).toBe(true);
    expect(w.leaves).toHaveLength(1);
  }, 40000);

  it("a save in flight is not read as clean before the file is written: the watch needs the dirty title, then a clean one with the old path changed in between (E5)", async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, "a.py"), "old\n");
    const w = world({ root });
    const t = await w.openTab("a.py");
    const first = t.embed();
    first.dirty = true;
    fs.renameSync(path.join(root, "a.py"), path.join(root, "b.py"));
    w.sync.onRename("b.py", "a.py");
    await new Promise((r) => setTimeout(r, 1300)); // dirty look
    await t.view.observeMove();
    first.dirty = false; // the title lost its mark while the old path is still untouched: nothing was written yet
    await t.view.observeMove();
    await t.view.observeMove(); // two quick reads of a clean title with no write behind them
    fs.writeFileSync(path.join(root, "a.py"), "edited\n"); // the write lands later
    await t.view.observeMove();
    // a clean title seen with no write is an undo, not a save: nothing is carried on it
    await new Promise((r) => setTimeout(r, 1500));
    expect(w.carried).toEqual([]);
    expect(fs.readFileSync(path.join(root, "b.py"), "utf8")).toBe("old\n");
  }, 40000);

  it("an edit that stays unsaved in the tab is not carried, and the embed stays (E5)", async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, "a.py"), "old\n");
    const w = world({ root });
    const t = await w.openTab("a.py");
    const first = t.embed();
    first.dirty = true;
    fs.renameSync(path.join(root, "a.py"), path.join(root, "b.py"));
    w.sync.onRename("b.py", "a.py");
    await new Promise((r) => setTimeout(r, 2500)); // several watch looks: the title carries the mark throughout
    expect(w.carried).toEqual([]);
    expect(w.notMoved).toEqual([]);
    expect(first.srcs.every((u) => !u.includes("b.py"))).toBe(true);
    expect(fs.readFileSync(path.join(root, "b.py"), "utf8")).toBe("old\n");
  });

  it("with the signal missing at the look of the save (the title is empty), the save is not carried, but nothing is lost and the user is told (E5)", async () => {
    // A VS Code update that changes how the title is built ends up here: the script throws, the tab reads unreadable, and a save
    // made in that gap cannot be told from a write by something else (R10, R11). The text is in the old path, the renamed file is
    // untouched, and the notice says so.
    const root = tempDir();
    fs.writeFileSync(path.join(root, "a.py"), "old\n");
    const w = world({ root });
    const t = await w.openTab("a.py");
    const first = t.embed();
    first.dirty = true;
    fs.renameSync(path.join(root, "a.py"), path.join(root, "b.py"));
    w.sync.onRename("b.py", "a.py");
    await new Promise((r) => setTimeout(r, 1300)); // a watch look sees the dirty title
    first.title = ""; // the signal goes
    fs.writeFileSync(path.join(root, "a.py"), "edited\n"); // Cmd+S on the renamed file's buffer
    await new Promise((r) => setTimeout(r, 1300)); // a watch look cannot read the page
    expect(first.srcs.every((u) => !u.includes("b.py"))).toBe(true); // an unreadable page is not reloaded
    first.title = null; // the signal is back, reading clean
    first.dirty = false;
    await vi.waitFor(() => expect(t.embed().srcs.at(-1)).toContain("b.py"), { timeout: 4000 });
    expect(w.carried).toEqual([]);
    expect(w.notMoved).toEqual([{ from: "a.py", to: "b.py" }]);
    expect(fs.readFileSync(path.join(root, "a.py"), "utf8")).toBe("edited\n"); // the typed text is still on disk
    expect(fs.readFileSync(path.join(root, "b.py"), "utf8")).toBe("old\n"); // never overwritten on a guess
  });

  it("while the edits are still unsaved the watch leaves the embed alone", async () => {
    const w = world();
    const t = await w.openTab("a.py");
    t.embed().dirty = true;
    const first = t.embed();
    w.sync.onRename("b.py", "a.py");
    await new Promise((r) => setTimeout(r, 1500)); // a watch tick has passed
    expect(t.embed()).toBe(first);
    expect(first.srcs.every((u) => !u.includes("b.py"))).toBe(true);
  });

  describe("unsaved edits follow a rename: where the saved bytes end up (G3)", () => {
    /** A temp vault with `a.py`; the tab's save writes to the path its buffer is bound to, as VS Code does. */
    async function renamed(opts: { answers?: Array<"save" | "discard" | "cancel">; to?: string } = {}) {
      const root = tempDir();
      fs.writeFileSync(path.join(root, "a.py"), "old\n");
      const w = world({ root, answers: opts.answers });
      const t = await w.openTab("a.py");
      const bound = "a.py";
      t.embed().dirty = true;
      t.embed().onSave = () => fs.writeFileSync(path.join(root, bound), "edited\n");
      const to = opts.to ?? "b.py";
      fs.renameSync(path.join(root, "a.py"), path.join(root, to)); // Obsidian moves the file, then fires the event
      w.sync.onRename(to, "a.py");
      await new Promise((r) => setTimeout(r, 30)); // the baseline read of the renamed file finishes
      const read = (n: string) => (fs.existsSync(path.join(root, n)) ? fs.readFileSync(path.join(root, n), "utf8") : null);
      return { root, w, t, read, to };
    }

    it("Cmd+S in the tab, then the tab is shown: the edits end up in the renamed file, the old path does not come back, the embed reloads onto the new file", async () => {
      const { w, t, read } = await renamed();
      expect(await t.view.saveBuffers()).toBe(true);
      expect(read("a.py")).toBe("edited\n"); // the workbench wrote to the old path: the file is back, for now
      expect(read("b.py")).toBe("old\n");
      t.view.notifyVisible();
      await vi.waitFor(() => expect(t.embed().srcs.at(-1)).toContain("b.py"));
      expect(read("b.py")).toBe("edited\n");
      expect(read("a.py")).toBeNull();
      expect(w.carried).toEqual([{ from: "a.py", to: "b.py", result: "carried" }]);
      expect(w.leaves).toHaveLength(1);
    });

    it("Save in the close prompt: the edits end up in the renamed file, the old path is gone, then the tab closes", async () => {
      const { w, t, read } = await renamed({ answers: ["save"] });
      t.leaf.detach();
      await vi.waitFor(() => expect(t.leaf.detached).toBe(true));
      expect(read("b.py")).toBe("edited\n");
      expect(read("a.py")).toBeNull();
      expect(w.carried).toEqual([{ from: "a.py", to: "b.py", result: "carried" }]);
    });

    it("Discard in the close prompt: nothing is written, the renamed file keeps its text and the old path stays gone", async () => {
      const { w, t, read } = await renamed({ answers: ["discard"] });
      t.leaf.detach();
      await vi.waitFor(() => expect(t.leaf.detached).toBe(true));
      expect(read("b.py")).toBe("old\n");
      expect(read("a.py")).toBeNull();
      expect(w.carried).toEqual([]); // Discard never moves anything
    });

    it("Discard with another file now at the old path: that file and the renamed file are both left exactly as they are (R6)", async () => {
      const { w, t, read, root } = await renamed({ answers: ["discard"] });
      fs.writeFileSync(path.join(root, "a.py"), "a brand new a.py\n"); // a new file made with the old name, no event for it
      t.leaf.detach();
      await vi.waitFor(() => expect(t.leaf.detached).toBe(true));
      expect(read("b.py")).toBe("old\n");
      expect(read("a.py")).toBe("a brand new a.py\n");
      expect(w.carried).toEqual([]);
    });

    it("a clean repoint with an unrelated file made at the old path in Obsidian: nothing is carried, both files are untouched, the user is told (R6)", async () => {
      const { w, t, read, root } = await renamed();
      fs.writeFileSync(path.join(root, "a.py"), "an unrelated a.py\n");
      w.taken("a.py"); // Obsidian's "new note" went through vault.create
      expect(w.notMoved).toEqual([{ from: "a.py", to: "b.py" }]);
      t.embed().dirty = false; // the edits were undone, so the buffer reads clean and the embed is re-pointed
      t.view.notifyVisible();
      await vi.waitFor(() => expect(t.embed().srcs.at(-1)).toContain("b.py"));
      expect(read("b.py")).toBe("old\n");
      expect(read("a.py")).toBe("an unrelated a.py\n");
      expect(w.carried).toEqual([]);
    });

    it("another file renamed onto the old path while the tab holds edits: the edits are not carried over it, and Save still leaves the renamed file alone (R6)", async () => {
      const { w, t, read, root } = await renamed({ answers: ["save"] });
      fs.writeFileSync(path.join(root, "a.py"), "moved in\n");
      w.taken("a.py"); // a vault rename event with newPath a.py
      t.leaf.detach();
      await vi.waitFor(() => expect(t.leaf.detached).toBe(true));
      expect(read("b.py")).toBe("old\n");
      expect(read("a.py")).toBe("edited\n"); // the workbench saved to its own path, as it always does
      expect(w.carried).toEqual([]);
      expect(w.notMoved).toHaveLength(1);
    });

    it("the old path was already taken when the rename was noticed (a rename swap, a file put back): nothing is carried", async () => {
      const root = tempDir();
      fs.writeFileSync(path.join(root, "a.py"), "old\n");
      const w = world({ root, answers: ["save"] });
      const t = await w.openTab("a.py");
      t.embed().dirty = true;
      t.embed().onSave = () => fs.writeFileSync(path.join(root, "a.py"), "edited\n");
      fs.renameSync(path.join(root, "a.py"), path.join(root, "b.py"));
      fs.writeFileSync(path.join(root, "a.py"), "swapped in\n"); // by the time the event is handled, another file is at a.py
      w.sync.onRename("b.py", "a.py");
      await vi.waitFor(() => expect(w.notMoved).toHaveLength(1));
      t.leaf.detach();
      await vi.waitFor(() => expect(t.leaf.detached).toBe(true));
      expect(fs.readFileSync(path.join(root, "b.py"), "utf8")).toBe("old\n");
      expect(w.carried).toEqual([]);
    });

    it("a file made at the old path outside Obsidian while the tab is dirty, then the edits are undone: nothing is carried, both files are untouched, the user is told (R8)", async () => {
      const { w, t, read, root } = await renamed();
      await t.view.observeMove(); // the tab is seen dirty, the old path is free
      fs.writeFileSync(path.join(root, "a.py"), "made by git checkout\n"); // no vault call, no event
      await t.view.observeMove(); // still dirty, and the old path changed under it
      t.embed().dirty = false; // the edits are undone: clean, with no save
      t.view.notifyVisible();
      await vi.waitFor(() => expect(t.embed().srcs.at(-1)).toContain("b.py"));
      expect(read("b.py")).toBe("old\n");
      expect(read("a.py")).toBe("made by git checkout\n");
      expect(w.carried).toEqual([]);
      expect(w.notMoved).toEqual([{ from: "a.py", to: "b.py" }]);
    });

    it("the same file at the old path, then the tab is closed with the buffer clean and again when Obsidian quits: still nothing is carried (R8)", async () => {
      const { w, t, read, root } = await renamed();
      await t.view.observeMove();
      fs.writeFileSync(path.join(root, "a.py"), "made by a shell\n");
      await t.view.observeMove();
      t.embed().dirty = false;
      await t.view.settleRename(); // what the quit does, and what closing the tab does
      t.leaf.detach();
      await vi.waitFor(() => expect(t.leaf.detached).toBe(true));
      expect(read("b.py")).toBe("old\n");
      expect(read("a.py")).toBe("made by a shell\n");
      expect(w.carried).toEqual([]);
    });

    it("a file made at the old path outside Obsidian, then the tab really saves over it: the save is seen and carried (R8)", async () => {
      const { w, t, read, root } = await renamed({ answers: ["save"] });
      await t.view.observeMove();
      fs.writeFileSync(path.join(root, "a.py"), "made by a shell\n");
      await t.view.observeMove();
      t.leaf.detach(); // Save in the prompt: the workbench writes its buffer to the old path
      await vi.waitFor(() => expect(t.leaf.detached).toBe(true));
      expect(read("b.py")).toBe("edited\n");
      expect(read("a.py")).toBeNull();
      expect(w.carried).toEqual([{ from: "a.py", to: "b.py", result: "carried" }]);
    });

    it("Cmd+S in the tab (no help from the plugin) is seen by the periodic look, which carries the edits and reloads onto the renamed file (R8, PR-5 R4)", async () => {
      const { w, t, read, root } = await renamed();
      fs.writeFileSync(path.join(root, "a.py"), "edited\n"); // the workbench's own save
      t.embed().dirty = false;
      await vi.waitFor(() => expect(t.embed().srcs.at(-1)).toContain("b.py"), { timeout: 4000 }); // one look of the watch, no notifyVisible
      expect(read("b.py")).toBe("edited\n");
      expect(read("a.py")).toBeNull();
      expect(w.carried).toEqual([{ from: "a.py", to: "b.py", result: "carried" }]);
    });

    describe("a file written at the old path after the tab's save was seen (R10)", () => {
      const after = {
        shown: async (t: Awaited<ReturnType<typeof renamed>>["t"]) => {
          t.view.notifyVisible();
          await new Promise((r) => setTimeout(r, 100));
        },
        closed: async (t: Awaited<ReturnType<typeof renamed>>["t"]) => {
          t.leaf.detach();
          await vi.waitFor(() => expect(t.leaf.detached).toBe(true));
        },
        quit: async (t: Awaited<ReturnType<typeof renamed>>["t"]) => t.view.settleRename(), // what the quit does for every tab
      } as const;
      it.each(["shown", "closed", "quit"] as const)("%s: nothing is carried, both files are untouched, the user is told", async (how) => {
        const { w, t, read, root } = await renamed();
        expect(await t.view.saveBuffers()).toBe(true); // a.py = "edited"
        await t.view.observeMove(); // the plugin sees the save
        fs.writeFileSync(path.join(root, "a.py"), "brand new main from a shell\n"); // cp / git checkout / a new file with the old name
        await after[how](t);
        await t.view.settleRename();
        expect(w.carried).toEqual([]);
        expect(read("b.py")).toBe("old\n");
        expect(read("a.py")).toBe("brand new main from a shell\n");
        expect(w.notMoved).toEqual([{ from: "a.py", to: "b.py" }]);
      });

      it("a clean look that sees the old path change after the save clears the save, and a later quit carries nothing", async () => {
        const { w, t, read, root } = await renamed();
        expect(await t.view.saveBuffers()).toBe(true);
        await t.view.observeMove();
        fs.writeFileSync(path.join(root, "a.py"), "from a shell\n");
        await t.view.observeMove(); // clean, and the fingerprint is not the save's
        fs.writeFileSync(path.join(root, "a.py"), "edited\n"); // even the same text again is a different file write
        await t.view.settleRename();
        expect(w.carried).toEqual([]);
        expect(read("b.py")).toBe("old\n");
      });

      it("the save is still carried when nothing touches the old path afterwards, and when the tab is edited and saved again", async () => {
        const { w, t, read } = await renamed();
        expect(await t.view.saveBuffers()).toBe(true);
        await t.view.observeMove();
        await t.view.observeMove(); // a second look at the unchanged file keeps the save
        t.embed().dirty = true;
        await t.view.observeMove();
        expect(await t.view.saveBuffers()).toBe(true); // a second save rewrites the old path
        await t.view.settleRename();
        expect(w.carried).toEqual([{ from: "a.py", to: "b.py", result: "carried" }]);
        expect(read("b.py")).toBe("edited\n");
        expect(read("a.py")).toBeNull();
      });
    });

    it("the buffer cannot be read between a dirty look and an external write plus undo: that change is not taken for a save (R11)", async () => {
      const { w, t, read, root } = await renamed();
      await t.view.observeMove(); // dirty, old path free
      t.embed().dirtyAnswer = async () => {
        throw new Error("page busy");
      };
      await t.view.observeMove(); // unreadable: the look is lost
      fs.writeFileSync(path.join(root, "a.py"), "made by git checkout\n");
      t.embed().dirtyAnswer = null;
      t.embed().dirty = false; // the edits were undone
      await t.view.settleRename();
      expect(w.carried).toEqual([]);
      expect(read("b.py")).toBe("old\n");
      expect(read("a.py")).toBe("made by git checkout\n");
      expect(w.notMoved).toEqual([{ from: "a.py", to: "b.py" }]);
    });

    it("a tab renamed while clean carries nothing and says nothing, even with a file at the old path (R8)", async () => {
      const root = tempDir();
      fs.writeFileSync(path.join(root, "a.py"), "old\n");
      const w = world({ root });
      const t = await w.openTab("a.py");
      fs.renameSync(path.join(root, "a.py"), path.join(root, "b.py"));
      w.sync.onRename("b.py", "a.py");
      // The tab's rename look reads the old path once, in the background (notePendingMove). A file written there before
      // that read finishes is seen by it, which is a different case from the one under test: wait until the tab has
      // settled onto the renamed file AND that read of the old path has finished, and only then put another file there.
      await vi.waitFor(() => expect(t.embed().srcs.at(-1)).toContain("b.py"));
      await vi.waitFor(() => expect(w.hasBaselineRead("a.py")).toBe(true));
      await w.baselineSettled("a.py");
      fs.writeFileSync(path.join(root, "a.py"), "new a\n");
      w.taken("a.py"); // what the plugin does when Obsidian reports the new file: the settled tab has nothing to say about it
      expect(fs.readFileSync(path.join(root, "b.py"), "utf8")).toBe("old\n");
      expect(fs.readFileSync(path.join(root, "a.py"), "utf8")).toBe("new a\n");
      expect(w.carried).toEqual([]);
      expect(w.notMoved).toEqual([]);
    });

    it("a tab that was renamed away from the path is not told when an unrelated path is created", async () => {
      const { w } = await renamed();
      w.taken("elsewhere.py");
      expect(w.notMoved).toEqual([]);
    });

    it("a rename to .md: Save puts the edits in the .md file, the .py does not come back, and no Code tab is opened for it (F6)", async () => {
      const { w, t, read } = await renamed({ answers: ["save"], to: "notes.md" });
      await vi.waitFor(() => expect(t.leaf.detached).toBe(true));
      expect(read("notes.md")).toBe("edited\n");
      expect(read("a.py")).toBeNull();
      expect(w.leaves).toHaveLength(1);
      expect(t.embed().srcs.every((s) => !s.includes("notes.md"))).toBe(true);
    });

    it("several renames before the save: the edits end up in the final file and neither earlier name comes back", async () => {
      const { w, t, read, root } = await renamed();
      fs.renameSync(path.join(root, "b.py"), path.join(root, "c.py"));
      w.sync.onRename("c.py", "b.py");
      expect(await t.view.saveBuffers()).toBe(true);
      t.view.notifyVisible();
      await vi.waitFor(() => expect(t.embed().srcs.at(-1)).toContain("c.py"));
      expect(read("c.py")).toBe("edited\n");
      expect(read("a.py")).toBeNull();
      expect(read("b.py")).toBeNull();
    });

    it("if the renamed file changed meanwhile nothing is overwritten: both files stay, and the carry reports a conflict", async () => {
      const { w, t, read, root } = await renamed({ answers: ["save"] });
      fs.writeFileSync(path.join(root, "b.py"), "changed elsewhere\n");
      t.leaf.detach();
      await vi.waitFor(() => expect(t.leaf.detached).toBe(true));
      expect(read("b.py")).toBe("changed elsewhere\n");
      expect(read("a.py")).toBe("edited\n"); // the edits are still there, in the old file
      expect(w.carried.map((c) => c.result)).toEqual(["conflict"]);
    });

    it("a tab that was never renamed carries nothing", async () => {
      const root = tempDir();
      fs.writeFileSync(path.join(root, "a.py"), "old\n");
      const w = world({ root, answers: ["save"] });
      const t = await w.openTab("a.py");
      t.embed().dirty = true;
      t.embed().onSave = () => fs.writeFileSync(path.join(root, "a.py"), "edited\n");
      t.leaf.detach();
      await vi.waitFor(() => expect(t.leaf.detached).toBe(true));
      expect(fs.readFileSync(path.join(root, "a.py"), "utf8")).toBe("edited\n");
      expect(w.carried).toEqual([]);
    });

    it("a file Obsidian deleted after the rename is not recreated by the carry", async () => {
      const { w, t, read, root } = await renamed();
      expect(await t.view.saveBuffers()).toBe(true); // a.py holds the edits again
      fs.rmSync(path.join(root, "b.py"));
      await w.sync.onDelete("b.py"); // clean after the save, and Obsidian did not do this one: it closes through deletedOnDisk
      await vi.waitFor(() => expect(t.leaf.detached).toBe(true));
      expect(read("b.py")).toBeNull();
      expect(w.carried).toEqual([]);
    });
  });

  it("ten renames within a second end on the final path, with one tab and one claim", async () => {
    const w = world();
    const a = await w.openTab("f0.py");
    for (let i = 0; i < 10; i++) w.sync.onRename(`f${i + 1}.py`, `f${i}.py`);
    expect(w.open.entries().map((c) => c.path)).toEqual(["f10.py"]);
    await vi.waitFor(() => expect(decodeURIComponent(a.embed().srcs.at(-1) as string)).toContain("f10.py"));
    expect(a.view.getDisplayText()).toBe("f10.py");
    expect(w.leaves).toHaveLength(1);
  });

  it("a rename while the embed is still loading is applied once it has loaded, with no stale tab", async () => {
    const w = world();
    const leaf = new MockLeaf() as unknown as WorkspaceLeaf & { detached: boolean };
    const gate: { release: () => void } = { release: () => undefined };
    const view = new CodeView(leaf as never, {
      vaultRoot: () => "/vault",
      embedElement: () => "webview",
      ensureServer: () => new Promise((r) => (gate.release = () => r({ baseUrl: "http://127.0.0.1:5555", port: 5555, token: "tok" }))),
      trackView: () => undefined,
      untrackView: () => undefined,
      serverState: () => "running",
      onServerState: () => () => undefined,
      restartServer: async () => undefined,
      userDataCopy: () => null,
      admitFile: async (f) => w.open.claim(f, leaf as never) === null,
      releaseFile: (f, l) => w.open.release(f, l as never),
      openInSystemApp: () => undefined,
    });
    (view as unknown as { contentEl: Embed }).contentEl = new Embed("div");
    leaf.detach = () => {
      leaf.detached = true;
      void view.onClose();
    };
    await view.onOpen();
    const loading = view.setState({ file: "a.py" }, {} as never);
    await new Promise((r) => setTimeout(r, 0));
    const sync = new VaultSync<WorkspaceLeaf>({ registry: w.registry, tabFor: () => view, eligible: (p) => opensInCodeTab(p) });
    sync.onRename("b.py", "a.py");
    gate.release();
    await loading;
    const embed = (view as unknown as { contentEl: Embed }).contentEl.children[0];
    await vi.waitFor(() => expect(decodeURIComponent(embed.srcs.at(-1) as string)).toContain("/vault/b.py"));
    expect(w.open.entries().map((c) => c.path)).toEqual(["b.py"]);
  });

  it("a delete by Obsidian closes the tab at once, with no prompt even with unsaved edits", async () => {
    const w = world({ answers: ["cancel"] });
    const t = await w.openTab("a.py");
    t.embed().dirty = true;
    const app = { vault: { delete: async (_f: { path: string }) => w.sync.onDelete("a.py") } };
    const restore = trackObsidianDeletes(app, w.sync);
    await app.vault.delete({ path: "a.py" });
    expect(t.leaf.detached).toBe(true);
    expect(w.prompts).toEqual([]);
    expect(w.open.entries()).toEqual([]);
    restore();
  });

  it("a delete event that Obsidian fires after the delete call settled is still Obsidian's own: the tab closes with no prompt (PR-5 R3)", async () => {
    const w = world({ answers: ["cancel"] });
    const t = await w.openTab("a.py");
    t.embed().dirty = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const app = { vault: { delete: async (_f: { path: string }) => undefined } }; // settles without the event
      const restore = trackObsidianDeletes(app, w.sync);
      await app.vault.delete({ path: "a.py" });
      await vi.advanceTimersByTimeAsync(300); // the file watcher's event arrives afterwards
      await w.sync.onDelete("a.py");
      expect(t.leaf.detached).toBe(true);
      expect(w.prompts).toEqual([]);
      restore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("after the grace period a delete of the same path counts as an outside delete again: a dirty tab stays open", async () => {
    const w = world();
    const t = await w.openTab("a.py");
    t.embed().dirty = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const app = { vault: { delete: async (_f: { path: string }) => undefined } };
      const restore = trackObsidianDeletes(app, w.sync);
      await app.vault.delete({ path: "a.py" });
      await vi.advanceTimersByTimeAsync(OBSIDIAN_DELETE_GRACE_MS + 10);
      await w.sync.onDelete("a.py");
      expect(t.leaf.detached).toBe(false);
      restore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an external delete closes a clean tab", async () => {
    const w = world();
    const t = await w.openTab("a.py");
    await w.sync.onDelete("a.py");
    expect(t.leaf.detached).toBe(true);
    expect(w.open.entries()).toEqual([]);
  });

  it("an external delete leaves a tab with unsaved edits open, still claimed, with no prompt of the plugin's own", async () => {
    const w = world();
    const t = await w.openTab("a.py");
    t.embed().dirty = true;
    await w.sync.onDelete("a.py");
    expect(t.leaf.detached).toBe(false);
    expect(w.prompts).toEqual([]);
    expect(w.open.entries().map((c) => c.path)).toEqual(["a.py"]);
  });

  it("an external delete of a folder closes only the clean tabs under it", async () => {
    const w = world();
    const clean = await w.openTab("d/a.py");
    const dirty = await w.openTab("d/b.py");
    const outside = await w.openTab("e/c.py");
    dirty.embed().dirty = true;
    await w.sync.onDelete("d");
    expect([clean.leaf.detached, dirty.leaf.detached, outside.leaf.detached]).toEqual([true, false, false]);
  });

  it("a delete while the embed is loading closes the tab once it has loaded (queued), leaving nothing behind", async () => {
    const w = world();
    const leaf = new MockLeaf() as unknown as WorkspaceLeaf & { detached: boolean };
    const gate: { release: () => void } = { release: () => undefined };
    const view = new CodeView(leaf as never, {
      vaultRoot: () => "/vault",
      embedElement: () => "webview",
      ensureServer: () => new Promise((r) => (gate.release = () => r({ baseUrl: "http://127.0.0.1:5555", port: 5555, token: "tok" }))),
      trackView: () => undefined,
      untrackView: () => undefined,
      serverState: () => "running",
      onServerState: () => () => undefined,
      restartServer: async () => undefined,
      userDataCopy: () => null,
      admitFile: async (f) => w.open.claim(f, leaf as never) === null,
      releaseFile: (f, l) => w.open.release(f, l as never),
      openInSystemApp: () => undefined,
    });
    (view as unknown as { contentEl: Embed }).contentEl = new Embed("div");
    await view.onOpen();
    const loading = view.setState({ file: "a.py" }, {} as never);
    await new Promise((r) => setTimeout(r, 0));
    const app = { vault: { delete: async (_f: { path: string }) => sync.onDelete("a.py") } };
    const sync = new VaultSync<WorkspaceLeaf>({ registry: w.registry, tabFor: () => view, eligible: (p) => opensInCodeTab(p) });
    const restore = trackObsidianDeletes(app, sync);
    await app.vault.delete({ path: "a.py" });
    expect(leaf.detached).toBe(false);
    gate.release();
    await loading;
    await vi.waitFor(() => expect(leaf.detached).toBe(true));
    expect(w.open.entries()).toEqual([]);
    restore();
  });

  it.each([
    ["a name ending .md", "notes.md"],
    ["a binary extension", "pic.png"],
  ])("a rename to %s closes the tab through the unsaved-changes prompt and is never handed to a Code tab (F6)", async (_n, to) => {
    const w = world({ answers: ["discard"] });
    const t = await w.openTab("a.py");
    t.embed().dirty = true;
    w.sync.onRename(to, "a.py");
    await vi.waitFor(() => expect(t.leaf.detached).toBe(true));
    expect(w.prompts).toHaveLength(1);
    expect(w.open.entries()).toEqual([]);
    expect(w.leaves).toHaveLength(1);
    expect(t.embed().srcs.every((s) => !s.includes(to))).toBe(true);
  });

  it("a modify event is not handled: nothing is sent to the tab, no prompt appears and the buffer is never touched (G4)", async () => {
    const w = world();
    const t = await w.openTab("a.py");
    t.embed().dirty = true;
    const srcs = t.embed().srcs.length;
    const handlers = Object.getOwnPropertyNames(VaultSync.prototype);
    expect(handlers).not.toContain("onModify");
    await new Promise((r) => setTimeout(r, 20));
    expect(t.embed().srcs).toHaveLength(srcs);
    expect(t.embed().keys).toBe(0);
    expect(t.embed().dirty).toBe(true);
    expect(w.prompts).toEqual([]);
  });
});

describe("the trust seed on every tab load (G5, G6, E3, E11)", () => {
  const trustScripts = (e: Embed) => e.seeds.filter((c) => c.includes("content.trust.model.key"));

  it("runs once per tab, after the settings seed and before the workbench page starts, for the vault folder", async () => {
    const outcomes: string[] = [];
    const w = world({ root: "/Users/dan/My Notes", trust: { enabled: () => true, held: () => [5555], outcomes } });
    const a = await w.openTab("a.py");
    const b = await w.openTab("b.py"); // a second tab on the same server
    for (const t of [a, b]) {
      expect(t.embed().seeds).toHaveLength(2);
      expect(t.embed().seeds[0]).toContain("vscode-web-db");
      expect(t.embed().seeds[1]).toContain("content.trust.model.key");
      expect(t.embed().seeds[1]).toContain('"path":"/Users/dan/My Notes"');
      expect(t.embed().srcs[0]).toBe("http://127.0.0.1:5555/"); // seeded on the bare origin
      expect(t.embed().srcs[1]).toContain("tkn=tok");
    }
    expect(outcomes).toEqual(["seeded", "seeded"]);
  });

  it("a restart reseeds on the new port and keeps the other running server's port in the keep-list", async () => {
    const outcomes: string[] = [];
    const trust = { enabled: () => true, held: () => [5555, 7000], outcomes, port: 5555 };
    const w = world({ trust });
    const before = await w.openTab("a.py");
    expect(trustScripts(before.embed())[0]).toContain("const keep = [5555,7000];");
    trust.port = 6001;
    trust.held = () => [6001, 7000];
    const after = await w.openTab("b.py");
    const script = trustScripts(after.embed())[0];
    expect(script).toContain('"authority":"127.0.0.1:6001"');
    expect(script).toContain("const keep = [6001,7000];");
  });

  it("with the setting off, no trust script runs and the tab opens", async () => {
    const outcomes: string[] = [];
    const w = world({ trust: { enabled: () => false, held: () => [5555], outcomes } });
    const t = await w.openTab("a.py");
    expect(trustScripts(t.embed())).toEqual([]);
    expect(t.embed().srcs[1]).toContain("tkn=tok");
    expect(outcomes).toEqual([]);
  });

  it.each(["version-mismatch", "no-store", "error:SecurityError", "timeout", "unsupported"])("opens the tab, not closed or blank, when the trust seed answers %s", async (answer) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const outcomes: string[] = [];
    const w = world({ trust: { enabled: () => true, held: () => [5555], outcomes } });
    const orig = document.createElement;
    vi.stubGlobal("document", {
      createElement: (t: string) => {
        const e = orig.call(document, t) as unknown as Embed;
        e.trustAnswer = () => Promise.resolve(answer);
        return e;
      },
    });
    const t = await w.openTab("a.py");
    expect(t.leaf.detached).toBeFalsy();
    expect(t.embed().srcs[1]).toContain("tkn=tok");
    expect(outcomes).toEqual([answer]);
    warn.mockRestore();
  });

  it("a trust script that is rejected still opens the tab", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const outcomes: string[] = [];
    const w = world({ trust: { enabled: () => true, held: () => [5555], outcomes } });
    const orig = document.createElement;
    vi.stubGlobal("document", {
      createElement: (t: string) => {
        const e = orig.call(document, t) as unknown as Embed;
        e.trustAnswer = () => Promise.reject(new Error("blocked"));
        return e;
      },
    });
    const t = await w.openTab("a.py");
    expect(t.leaf.detached).toBeFalsy();
    expect(t.embed().srcs[1]).toContain("tkn=tok");
    expect(outcomes).toEqual(["error:blocked"]);
    warn.mockRestore();
  });
});

describe("no writes to any note", () => {
  it("renames, deletes, closes and discards leave the files of a temp vault byte-for-byte unchanged", async () => {
    const vault = tempDir();
    const files: Record<string, string> = { "a b.py": "print('a')\n", "ünï.ts": "export {};\n", Makefile: "all:\n\ttrue\n", "note.md": "# note\n" };
    for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(vault, n), c);
    const snapshot = () => Object.fromEntries(fs.readdirSync(vault).sort().map((n) => [n, fs.readFileSync(path.join(vault, n), "utf8")]));
    const before = snapshot();
    const w = world({ answers: ["discard", "discard"] });
    const tabs = await Promise.all(["a b.py", "ünï.ts", "Makefile"].map((f) => w.openTab(f)));
    tabs[0].embed().dirty = true;
    tabs[1].embed().dirty = true;
    w.sync.onRename("renamed.py", "a b.py");
    await w.sync.onDelete("Makefile");
    for (const t of tabs.slice(0, 2)) t.leaf.detach();
    await vi.waitFor(() => expect(tabs.every((t) => t.leaf.detached)).toBe(true));
    expect(snapshot()).toEqual(before);
  });
});

describe("the keybinding overlay step runs at every load of a Code tab (GP4, E9, F3)", () => {
  const hiding = () => ({ keybindings: overlayKeybindings(), unbind: unbindCommands(), script: "/* page script */ 'installed'" });
  const withOverlay = (seed: string) => seed.includes(OVERLAY_BEGIN) && seed.includes(OVERLAY_END) && seed.includes('"-workbench.action.toggleSidebarVisibility"');
  /** The overlay step is part of the settings seed; the trust seed is the other script. Counts the settings seeds that carry the overlay. */
  const overlaySeeds = (embed: Embed) => embed.seeds.filter(withOverlay).length;

  it("tab open: the settings seed carries the overlay (the disabled chords and the unbinding of revealing commands)", async () => {
    const w = world({ chromeHiding: hiding });
    const tab = await w.openTab("a.js");
    await vi.waitFor(() => expect(overlaySeeds(tab.embed())).toBe(1));
    const seed = tab.embed().seeds.find(withOverlay) as string;
    // written out literally: the removals of the four chords of GP4
    for (const [key, command] of [
      ["cmd+b", "-workbench.action.toggleSidebarVisibility"],
      ["cmd+j", "-workbench.action.togglePanel"],
      ["cmd+k z", "-workbench.action.toggleZenMode"],
      ["cmd+w", "-workbench.action.closeActiveEditor"],
    ]) expect(seed).toContain(JSON.stringify({ key, command }));
    expect(seed).toContain(JSON.stringify(unbindCommands()));
  });

  it("reload (the same tab, a second load): the step runs again, not once per tab or per server start", async () => {
    const w = world({ chromeHiding: hiding });
    const tab = await w.openTab("a.js");
    await vi.waitFor(() => expect(overlaySeeds(tab.embed())).toBe(1));
    const first = tab.embed();
    tab.view.reload(); // the fake embed has no reload(): the tab loads the workbench again, which is a fresh page
    await vi.waitFor(() => expect(tab.embed()).not.toBe(first));
    await vi.waitFor(() => expect(overlaySeeds(tab.embed())).toBe(1));
    expect(w.leaves).toHaveLength(1); // the same tab, not a second one
  });

  it("server restart: the tab reloads onto the new server and runs the step again", async () => {
    const serverListeners: Array<(state: "running" | "stopped") => void> = [];
    const w = world({ chromeHiding: hiding, serverListeners });
    const tab = await w.openTab("a.js");
    await vi.waitFor(() => expect(overlaySeeds(tab.embed())).toBe(1));
    const first = tab.embed();
    for (const cb of serverListeners) cb("stopped");
    for (const cb of serverListeners) cb("running");
    await vi.waitFor(() => expect(tab.embed()).not.toBe(first));
    await vi.waitFor(() => expect(overlaySeeds(tab.embed())).toBe(1));
  });

  it.each([
    ["the host's chromeHiding throws", { chromeHiding: () => { throw new Error("no overlay"); } }, () => Promise.resolve("seeded")],
    ["the seed script (which holds the overlay step) throws in the page", { chromeHiding: hiding }, () => Promise.reject(new Error("page refused"))],
    ["the seed script answers an error outcome", { chromeHiding: hiding }, () => Promise.resolve("error:SyntaxError")],
  ])("F3: %s: the tab still opens and navigates to its editor", async (_name, opts, answer) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // the answer is set on the embed before its page's dom-ready, which fires on the first src
      vi.stubGlobal("document", { createElement: (t: string) => Object.assign(new Embed(t), { seedAnswer: answer }) });
      const w = world(opts as never);
      const tab = await w.openTab("a.js");
      await vi.waitFor(() => expect(tab.embed().srcs).toHaveLength(2));
      expect(tab.embed().srcs[1]).toContain("tkn=tok");
      expect(tab.leaf.detached).toBe(false);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
