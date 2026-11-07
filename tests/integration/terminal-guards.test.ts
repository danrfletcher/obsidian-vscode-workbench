/**
 * Integration: the terminal page is never asked anything (G14). A host page whose webview throws, never answers, or reports a dirty
 * editor changes nothing about `dirtyViews()`, the idle clock, the restart prompt or the quit flow: they read the Code tabs and the
 * server's process tree, not the page.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal, Notice, Plugin, Tasks } from "../mocks/obsidian";
import VSCodeWorkbenchPlugin, { SPIKE_FILE } from "../../src/main";
import { FAKE_CODE, isAlive, tempDir, openTerminal } from "../helpers";
import { installFakeDocument, makeHostApp, type FakeDocument } from "../fake-host-page";
import type { FakeHostEl } from "../host-fakes";

let vault: string;
let pidFile: string;
let plugin: VSCodeWorkbenchPlugin;
let doc: FakeDocument;

const inner = () =>
  plugin as unknown as {
    manager: import("../../src/server-manager").ServerManager;
    idle: import("../../src/idle-timer").IdleTimer;
    dirtyViews(): Promise<unknown[]>;
    trackView(v: unknown): void;
  };
const host = () => (plugin as unknown as { terminalHost: import("../../src/terminal-host/host-page").TerminalHostPage }).terminalHost;
const serverPids = () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : []);

function view(dirty: boolean) {
  return {
    filePath: "a.py",
    leaf: {},
    isVisible: () => false,
    isDirty: async () => dirty,
    saveBuffers: async () => true,
    notifyVisible: () => undefined,
    settleRename: async () => undefined,
    abandonRename: () => undefined,
    pathTaken: () => undefined,
    reload: () => undefined,
  };
}

/** The ways a page can misbehave when it is asked something (nothing should ask). */
const PAGES: Array<{ name: string; ask: (wv: FakeHostEl, asked: string[]) => void }> = [
  { name: "throws", ask: (wv, asked) => void (wv.executeJavaScript = (code: string) => (asked.push(code), Promise.reject(new Error("page is gone")))) },
  { name: "never answers", ask: (wv, asked) => void (wv.executeJavaScript = (code: string) => (asked.push(code), new Promise(() => undefined))) },
  { name: "reports a dirty editor", ask: (wv, asked) => void (wv.executeJavaScript = (code: string) => (asked.push(code), Promise.resolve({ dirty: true, isDirty: true, hasUnsavedChanges: true }))) },
];

beforeEach(() => {
  vault = tempDir();
  fs.mkdirSync(path.join(vault, path.dirname(SPIKE_FILE)), { recursive: true });
  fs.writeFileSync(path.join(vault, SPIKE_FILE), "import os\n");
  pidFile = path.join(tempDir(), "pids");
  Plugin.reset();
  Notice.reset();
  Modal.reset();
  doc = installFakeDocument();
});

afterEach(async () => {
  plugin?.onunload();
  await new Promise((r) => setTimeout(r, 400));
  for (const pid of serverPids()) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  for (const k of ["FAKE_CODE_NODE", "FAKE_CODE_PIDFILE"]) delete process.env[k];
  vi.unstubAllGlobals();
});

async function loadWithPage(): Promise<void> {
  Object.assign(process.env, { FAKE_CODE_NODE: process.execPath, FAKE_CODE_PIDFILE: pidFile });
  plugin = new VSCodeWorkbenchPlugin(makeHostApp(vault) as never, { id: "obsidian-vscode-workbench", dir: ".obsidian/plugins/obsidian-vscode-workbench" } as never);
  (plugin as unknown as { pluginData: unknown }).pluginData = { codeCliPath: FAKE_CODE, embed: "iframe", serverLicenceAccepted: true };
  await plugin.onload();
  openTerminal(plugin);
  await host().settled();
  expect(host().view()).toBe("running");
}

for (const page of PAGES) {
  describe(`a terminal page that ${page.name}`, () => {
    it("is never asked by dirtyViews(): the answer is the Code tabs' alone", async () => {
      await loadWithPage();
      const asked: string[] = [];
      page.ask(doc.webviews[0], asked);
      expect(await inner().dirtyViews()).toEqual([]);
      const clean = view(false);
      const dirty = view(true);
      inner().trackView(clean);
      inner().trackView(dirty);
      expect(await inner().dirtyViews()).toEqual([dirty]);
      expect(asked).toEqual([]);
    });

    it("does not change the idle clock", async () => {
      await loadWithPage();
      const asked: string[] = [];
      page.ask(doc.webviews[0], asked);
      (plugin as unknown as { processTable: () => Promise<string> }).processTable = async () => "";
      inner().idle.stop();
      inner().idle.start();
      await inner().idle.evaluate();
      expect(inner().idle.counting).toBe(true); // no shell, no visible tab, nothing dirty: the clock runs whatever the page says
      expect(asked).toEqual([]);
    });

    it("does not raise the restart prompt", async () => {
      await loadWithPage();
      const asked: string[] = [];
      page.ask(doc.webviews[0], asked);
      (plugin as unknown as { processTable: () => Promise<string> }).processTable = async () => "";
      await plugin.restartServer();
      expect(Modal.opened).toHaveLength(0);
      expect(asked).toEqual([]);
    });

    it("does not raise the quit prompt, and the quit finishes", async () => {
      await loadWithPage();
      const asked: string[] = [];
      page.ask(doc.webviews[0], asked);
      const tasks = new Tasks();
      for (const e of Plugin.events.filter((x) => x.name === "quit")) e.cb(tasks);
      await tasks.runAll();
      expect(Modal.opened).toHaveLength(0);
      expect(inner().manager.state).toBe("stopped");
      expect(asked).toEqual([]);
    });

    it("leaves the Code tabs' own quit prompt as it was", async () => {
      await loadWithPage();
      const asked: string[] = [];
      page.ask(doc.webviews[0], asked);
      const dirty = view(true);
      inner().trackView(dirty);
      const tasks = new Tasks();
      for (const e of Plugin.events.filter((x) => x.name === "quit")) e.cb(tasks);
      const quitting = tasks.runAll();
      await vi.waitFor(() => expect(Modal.opened).toHaveLength(1), { timeout: 3000 });
      const modal = Modal.opened[0] as unknown as { contentEl: { textContent(): string; buttons(): Array<{ text: string; click(): void }> } };
      expect(modal.contentEl.textContent()).toContain("a.py");
      modal.contentEl.buttons().find((b) => b.text === "Discard changes")!.click();
      await quitting;
      expect(Modal.opened).toHaveLength(1);
      expect(asked).toEqual([]);
    });
  });
}
