/**
 * CodeView and the server lifecycle: the crash banner and its Restart button,
 * reload onto the new port and token, stale tabs after an idle stop, the dirty
 * read, and the save-all used at quit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeNode, WorkspaceLeaf } from "../mocks/obsidian";
import { CRASH_TEXT, CodeView, DIRTY_SCRIPT, RESTART_FAILED_TEXT, saveAllKeys, type CodeViewHost } from "../../src/code-view";
import type { ServerState } from "../../src/server-manager";

class El extends FakeNode {
  attrs: Record<string, string> = {};
  srcs: string[] = [];
  executed: string[] = [];
  keys: Array<{ type: string; keyCode?: string; modifiers?: string[] }> = [];
  dirtyAnswer: () => Promise<unknown> = async () => false;
  private fired: Record<string, Array<() => void>> = {};
  constructor(tag: string) {
    super(tag);
  }
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
  executeJavaScript(code: string) {
    this.executed.push(code);
    return code === DIRTY_SCRIPT ? this.dirtyAnswer() : Promise.resolve("seeded");
  }
  sendInputEvent(e: { type: string; keyCode?: string; modifiers?: string[] }) {
    this.keys.push(e);
  }
  appendChild(c: El) {
    this.children.push(c);
  }
  addClass() {}
  focus() {}
  shown = true;
  isShown() {
    return this.shown;
  }
}

let listeners: Array<(s: ServerState) => void>;
let state: ServerState;
let ports: number;
let ensure: ReturnType<typeof vi.fn>;
let restart: ReturnType<typeof vi.fn>;

function emit(s: ServerState) {
  state = s;
  for (const l of [...listeners]) l(s);
}

function makeView() {
  const host: CodeViewHost = {
    vaultRoot: () => "/vault",
    embedElement: () => "webview",
    ensureServer: ensure as never,
    trackView: vi.fn(),
    untrackView: vi.fn(),
    serverState: () => state,
    onServerState: (cb) => {
      listeners.push(cb);
      return () => (listeners = listeners.filter((l) => l !== cb));
    },
    restartServer: restart as never,
    userDataCopy: () => null,
    admitFile: async () => true,
    releaseFile: () => undefined,
    openInSystemApp: () => undefined,
    // A host like the plugin's: it gives the chrome-hiding script and opens files from the editor, so a clean title is trusted (PR-5 R10).
    chromeHiding: () => ({ keybindings: [], script: "0" }),
    openFromEditor: async () => undefined,
  };
  const leaf = new WorkspaceLeaf();
  const view = new CodeView(leaf as never, host);
  const contentEl = new El("div");
  (view as unknown as { contentEl: El }).contentEl = contentEl;
  return { view, contentEl, leaf: leaf as WorkspaceLeaf & { detached: boolean } };
}

const frame = (c: El) => c.children.find((n) => n.tag === "webview") as El;
const banner = (c: El) => c.children.find((n) => n.cls === "vscode-workbench-banner" && !n.removed);

beforeEach(() => {
  listeners = [];
  state = "running";
  ports = 5000;
  ensure = vi.fn(async () => {
    ports++;
    return { baseUrl: `http://127.0.0.1:${ports}`, port: ports, token: `tok${ports}` };
  });
  restart = vi.fn(async () => {
    emit("starting");
    emit("running"); // as the real manager does once the new server answers
  });
  vi.stubGlobal("document", { createElement: (t: string) => new El(t) });
});
afterEach(() => vi.unstubAllGlobals());

async function open() {
  const v = makeView();
  await v.view.onOpen();
  await v.view.setState({ file: "a.py" }, {} as never);
  await vi.waitFor(() => expect(frame(v.contentEl).srcs).toHaveLength(2));
  return v;
}

describe("crash banner", () => {
  it("shows the crash banner with a Restart button, keeping the dead page in place so text can be copied", async () => {
    const { view, contentEl } = await open();
    emit("crashed");
    const b = banner(contentEl);
    expect(b?.textContent()).toContain(CRASH_TEXT);
    expect(CRASH_TEXT).toMatch(/unsaved changes.*lost/);
    expect(b?.buttons().map((x) => x.text)).toEqual(["Restart"]);
    expect(frame(contentEl)).toBeDefined();
    expect(view.getState()).toEqual({ file: "a.py" });
  });

  it("Restart restarts the server and reloads this tab onto the new port and token, once", async () => {
    const { contentEl } = await open();
    const first = frame(contentEl).srcs[1];
    emit("crashed");
    banner(contentEl)!.buttons()[0].click();
    await vi.waitFor(() => expect(frame(contentEl)?.srcs.length).toBe(2));
    const second = frame(contentEl).srcs[1];
    expect(restart).toHaveBeenCalledTimes(1);
    expect(second).not.toBe(first);
    expect(second).toContain("tok");
    expect(second).not.toContain(new URL(first).searchParams.get("tkn") as string);
    expect(banner(contentEl)).toBeUndefined();
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it("if Restart fails the banner stays, says so, and Restart can be pressed again", async () => {
    const { contentEl } = await open();
    emit("crashed");
    restart.mockRejectedValueOnce(new Error("no"));
    banner(contentEl)!.buttons()[0].click();
    await vi.waitFor(() => expect(banner(contentEl)?.textContent()).toContain(RESTART_FAILED_TEXT));
    expect(restart).toHaveBeenCalledTimes(1);
    banner(contentEl)!.buttons()[0].click();
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(banner(contentEl)).toBeUndefined());
  });

  it("a crash with no page loaded shows no banner", async () => {
    const v = makeView();
    await v.view.onOpen();
    emit("crashed");
    expect(banner(v.contentEl)).toBeUndefined();
  });

  it("a view that is closed stops listening", async () => {
    const { view } = await open();
    expect(listeners).toHaveLength(1);
    await view.onClose();
    expect(listeners).toHaveLength(0);
  });

  it("release() does what closing does without a leaf being removed, once, however often it is asked", async () => {
    const { view, contentEl } = await open();
    expect(listeners).toHaveLength(1);
    const first = view.release();
    expect(view.release()).toBe(first);
    await first;
    await view.onClose(); // the user closing the leftover tab afterwards joins it
    expect(listeners).toHaveLength(0);
    expect(frame(contentEl).removed).toBe(true);
  });
});

describe("tab left behind by an idle stop", () => {
  it("reloads when it is shown again: notifyVisible asks for a server, which starts anew", async () => {
    const { view, contentEl } = await open();
    emit("stopped-by-idle");
    contentEl.shown = false;
    view.notifyVisible();
    expect(ensure).toHaveBeenCalledTimes(1); // hidden: nothing starts
    contentEl.shown = true;
    view.notifyVisible();
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(frame(contentEl)?.srcs).toHaveLength(2));
  });

  it("a tab that was never stale does not reload when shown", async () => {
    const { view, contentEl } = await open();
    view.notifyVisible();
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(frame(contentEl)).toBeDefined();
  });
});

describe("a tab whose server cannot start", () => {
  it("is closed when it never had a page", async () => {
    ensure.mockRejectedValueOnce(new Error("declined"));
    const v = makeView();
    await v.view.onOpen();
    await v.view.setState({ file: "a.py" }, {} as never);
    expect(v.leaf.detached).toBe(true);
  });

  it("keeps its place and offers Restart when it showed the crash banner and the reload fails", async () => {
    const { view, contentEl, leaf } = await open();
    emit("crashed");
    ensure.mockRejectedValueOnce(new Error("failed"));
    restart.mockImplementationOnce(async () => emit("running"));
    banner(contentEl)!.buttons()[0].click();
    await vi.waitFor(() => expect(banner(contentEl)?.textContent()).toContain(RESTART_FAILED_TEXT));
    expect(leaf.detached).toBe(false);
    expect(view.getState()).toEqual({ file: "a.py" });
  });

  it("is closed, not left blank, when a stopped tab's reload fails (G14)", async () => {
    const { leaf, contentEl } = await open();
    emit("stopped-by-idle");
    ensure.mockRejectedValueOnce(new Error("failed"));
    emit("running");
    await vi.waitFor(() => expect(leaf.detached).toBe(true));
    expect(banner(contentEl)).toBeUndefined();
  });

  it("is closed when the server fails to start and the tab still showed the stopped server's page (G14)", async () => {
    const { contentEl, leaf } = await open();
    const page = frame(contentEl);
    emit("stopped");
    emit("starting");
    emit("failed");
    expect(leaf.detached).toBe(true);
    expect(page.removed).toBe(true);
  });

  it("a failed start leaves a tab with the crash banner in place, so Restart can try again", async () => {
    const { contentEl, leaf } = await open();
    emit("crashed");
    emit("starting");
    emit("failed");
    expect(leaf.detached).toBe(false);
    expect(banner(contentEl)).toBeDefined();
  });

  it("a failed start does nothing to a tab that has no page", async () => {
    const v = makeView();
    await v.view.onOpen();
    emit("failed");
    expect(v.leaf.detached).toBe(false);
  });
});

describe("unsaved buffer detection", () => {
  it("reads the workbench page: true when it reports a dirty editor, false when not", async () => {
    const { view, contentEl } = await open();
    const f = frame(contentEl);
    f.dirtyAnswer = async () => true;
    await expect(view.isDirty()).resolves.toBe(true);
    f.dirtyAnswer = async () => false;
    await expect(view.isDirty()).resolves.toBe(false);
    expect(f.executed).toContain(DIRTY_SCRIPT);
  });

  it("treats a page that cannot be asked as dirty: an unsaved buffer is never risked on a guess", async () => {
    const { view, contentEl } = await open();
    frame(contentEl).dirtyAnswer = async () => {
      throw new Error("webview destroyed");
    };
    await expect(view.isDirty()).resolves.toBe(true);
  });

  it("a view with no page is not dirty", async () => {
    const v = makeView();
    await expect(v.view.isDirty()).resolves.toBe(false);
  });

  // The script is run against stand-in pages shaped like the chosen signal (docs/spike-chrome.md S5): a workbench whose window title
  // carries "●" while the active editor is dirty. There is no VS Code tab strip in any of them.
  const MARK = "\u25cf";
  const run = (page: { title: string; workbench?: boolean; dirtyTab?: boolean; editor?: boolean }) => {
    const doc = {
      title: page.title,
      querySelector: (sel: string) => {
        if (sel.includes(".tab")) return page.dirtyTab ? {} : null; // an old tab marker: ignored by the script
        if (sel.includes("data-uri")) return page.editor ? {} : null; // an editor on screen
        return sel === ".monaco-workbench" && page.workbench !== false ? {} : null;
      },
    };
    return new Function("document", `return ${DIRTY_SCRIPT}`)(doc);
  };

  it.each([
    ["dirty: the title starts with the mark", { title: `${MARK} a.py \u2014 Visual Studio Code` }, true],
    ["clean: the title has no mark", { title: "a.py \u2014 Visual Studio Code" }, false],
    ["nothing open: the title is the bare app name", { title: "Visual Studio Code" }, false],
    ["a restored, unsaved editor that is not the active one: the title names the active editor only", { title: "b.py \u2014 Visual Studio Code" }, false],
    ["a file name that has quotes: the signal does not use the name", { title: `${MARK} a"b.py \u2014 Visual Studio Code` }, true],
    ["a non-ASCII file name", { title: `${MARK} \u00e4\u6587.py \u2014 Visual Studio Code` }, true],
    ["a mark that is not at the start is not the dirty mark", { title: `a.py ${MARK} Visual Studio Code` }, false],
    ["a tab marked dirty in the page but a clean title: the old tab signal is not read", { title: "a.py \u2014 Visual Studio Code", dirtyTab: true }, false],
  ])("the dirty script says %s -> %s", (_n, page, expected) => {
    expect(run(page)).toBe(expected);
  });

  // PR-5 R2/R3: with an editor on screen a title that does not have the shape of the plugin's own template (name, separator, app name) is
  // not trusted to be clean: a workspace `window.title` that wins over the plugin's, or a VS Code update that builds the title another way.
  it.each([
    ["the plugin's template, em dash (macOS)", "a.py \u2014 Visual Studio Code"],
    ["the plugin's template, hyphen (other platforms)", "a.py - Visual Studio Code"],
    ["the Insiders app name", "a.py \u2014 Visual Studio Code - Insiders"],
  ])("an editor on screen and a title of the right shape (%s) reads clean", (_n, title) => {
    expect(run({ title, editor: true })).toBe(false);
  });

  it.each([
    ["a workspace window.title of just the file name", "a.py"],
    ["the app name alone while an editor is on screen", "Visual Studio Code"],
    ["a title whose dirty mark moved", `a.py ${MARK} Visual Studio Code`],
  ])("an editor on screen and a title of the wrong shape (%s) throws, so the tab reads unreadable and not clean", (_n, title) => {
    expect(() => run({ title, editor: true })).toThrow(/shape/);
  });

  it("a dirty title is dirty whatever its shape, and no editor on screen needs no shape", () => {
    expect(run({ title: `${MARK} a.py`, editor: true })).toBe(true);
    expect(run({ title: "a.py", editor: false })).toBe(false);
  });

  it("two files with one name in different folders cannot be mixed up: the title of the active editor decides, whichever folder it is in", () => {
    // VS Code's title is `${dirty}${activeEditorShort} - ...`: the short name is the same for x/a.py and y/a.py, and only the mark differs.
    expect(run({ title: `${MARK} a.py \u2014 Visual Studio Code` })).toBe(true); // x/a.py typed in this tab
    expect(run({ title: "a.py \u2014 Visual Studio Code" })).toBe(false); // y/a.py in another tab, nothing typed
  });

  it.each([
    ["an empty title", { title: "" }],
    ["no workbench in the page", { title: "Visual Studio Code", workbench: false }],
    ["no workbench and an empty title", { title: "", workbench: false }],
  ])("the signal missing (%s): the script throws, so the tab reads unreadable and not clean", (_n, page) => {
    expect(() => run(page)).toThrow();
  });

  it("the script names no VS Code tab-strip selector and no data-resource-name", () => {
    expect(DIRTY_SCRIPT).not.toContain(".tab");
    expect(DIRTY_SCRIPT).not.toContain("data-resource-name");
  });

  it("answers exactly true or false when it answers", () => {
    for (const title of [`${MARK} x`, "x", "Visual Studio Code"]) expect(typeof run({ title })).toBe("boolean");
  });

  describe("bufferState", () => {
    it("is clean, dirty or unreadable by what the page answers", async () => {
      const { view, contentEl } = await open();
      const f = frame(contentEl);
      f.dirtyAnswer = async () => true;
      await expect(view.bufferState()).resolves.toBe("dirty");
      f.dirtyAnswer = async () => false;
      await expect(view.bufferState()).resolves.toBe("clean");
    });

    it("is unreadable when executeJavaScript throws (the signal is missing, the page is gone)", async () => {
      const { view, contentEl } = await open();
      frame(contentEl).dirtyAnswer = async () => {
        throw new Error("the window title is not readable");
      };
      await expect(view.bufferState()).resolves.toBe("unreadable");
    });

    it("is unreadable when executeJavaScript throws synchronously", async () => {
      const { view, contentEl } = await open();
      frame(contentEl).dirtyAnswer = () => {
        throw new Error("webview destroyed");
      };
      await expect(view.bufferState()).resolves.toBe("unreadable");
    });

    it("is unreadable when the page does not answer in time", async () => {
      const { view, contentEl } = await open();
      frame(contentEl).dirtyAnswer = () => new Promise(() => undefined);
      vi.useFakeTimers();
      try {
        const asked = view.bufferState();
        await vi.advanceTimersByTimeAsync(3500);
        await expect(asked).resolves.toBe("unreadable");
      } finally {
        vi.useRealTimers();
      }
    });

    it("is unreadable when the frame is not domReady, and the page is not asked", async () => {
      const { view, contentEl } = await open();
      const f = frame(contentEl);
      f.dirtyAnswer = async () => false; // would read clean if it were asked
      (view as unknown as { domReady: boolean }).domReady = false;
      const before = f.executed.length;
      await expect(view.bufferState()).resolves.toBe("unreadable");
      expect(f.executed.length).toBe(before);
    });
  });
});

describe("saveBuffers", () => {
  it.each([
    ["darwin", [["meta", "alt"]], ["S"]],
    ["linux", [["control"], []], ["K", "S"]],
    ["win32", [["control"], []], ["K", "S"]],
  ])("%s: the Save All sequence, not plain Save", (platform, mods, codes) => {
    expect(saveAllKeys(platform).map((k) => k.keyCode)).toEqual(codes);
    expect(saveAllKeys(platform).map((k) => k.modifiers)).toEqual(mods);
  });

  it("sends the Save All keys and waits until nothing is dirty", async () => {
    const { view, contentEl } = await open();
    const f = frame(contentEl);
    let dirty = true;
    f.dirtyAnswer = async () => dirty;
    f.sendInputEvent = (e) => {
      f.keys.push(e);
      if (e.type === "keyUp" && f.keys.length === saveAllKeys(process.platform).length * 2) dirty = false;
    };
    await expect(view.saveBuffers(2000)).resolves.toBe(true);
    const expected = saveAllKeys(process.platform).flatMap((k) => [
      { type: "keyDown", keyCode: k.keyCode, modifiers: k.modifiers },
      { type: "keyUp", keyCode: k.keyCode, modifiers: k.modifiers },
    ]);
    expect(f.keys).toEqual(expected);
  });

  it("saves every dirty editor in the tab: a plain Cmd/Ctrl+S would leave the others dirty", async () => {
    const { view, contentEl } = await open();
    const f = frame(contentEl);
    // A stand-in workbench with three dirty editors. Plain Save writes the active one; Save All writes all.
    let dirtyEditors = 3;
    const all = saveAllKeys(process.platform);
    let matched = 0;
    f.dirtyAnswer = async () => dirtyEditors > 0;
    f.sendInputEvent = (e) => {
      f.keys.push(e);
      if (e.type !== "keyDown") return;
      const want = all[matched];
      const same = e.keyCode === want.keyCode && JSON.stringify(e.modifiers) === JSON.stringify(want.modifiers);
      matched = same ? matched + 1 : 0;
      if (matched === all.length) dirtyEditors = 0;
      else if (e.keyCode === "S" && e.modifiers?.length === 1 && ["meta", "control"].includes(e.modifiers[0])) dirtyEditors = Math.max(0, dirtyEditors - 1);
    };
    await expect(view.saveBuffers(600)).resolves.toBe(true);
    expect(dirtyEditors).toBe(0);
  });

  it("reports false when the buffer stays dirty past the timeout", async () => {
    const { view, contentEl } = await open();
    frame(contentEl).dirtyAnswer = async () => true;
    await expect(view.saveBuffers(300)).resolves.toBe(false);
  });
});
