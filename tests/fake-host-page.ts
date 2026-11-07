/**
 * A stand-in for the document the terminal host page draws into, for tests that run the real plugin (`main.ts`), the real host page
 * and the fake `code` script, and want to look at what the drawer shows. The webview is the `FakeHostEl` of `tests/host-fakes.ts` with
 * a fake workbench behind it. `installFakeDocument()` stubs the globals (call `vi.unstubAllGlobals()` after).
 */
import { vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { FileSystemAdapter, TFile, WorkspaceLeaf, type MockApp } from "./mocks/obsidian";
import { FakeHostEl, FakeWorkbenchPage } from "./host-fakes";

export interface FakeDocument {
  body: FakeHostEl & { classList: { contains(c: string): boolean } };
  /** Every webview the host page made, in order. */
  webviews: FakeHostEl[];
  /** What the drawer shows now (hidden elements left out). */
  text(): string;
  /** The buttons in the drawer, by label. */
  button(label: string): FakeHostEl | undefined;
}

export function installFakeDocument(opts: { dark?: () => boolean } = {}): FakeDocument {
  const body = new FakeHostEl("body") as FakeDocument["body"];
  body.classList = { contains: (c: string) => c === "theme-dark" && (opts.dark?.() ?? false) };
  const webviews: FakeHostEl[] = [];
  vi.stubGlobal("window", { addEventListener: () => undefined });
  vi.stubGlobal("document", {
    body,
    createElement: (tag: string) => {
      const e = new FakeHostEl(tag);
      if (tag === "webview") {
        e.page = new FakeWorkbenchPage();
        webviews.push(e);
      }
      return e;
    },
  });
  return {
    body,
    webviews,
    text: () => body.visibleText(),
    button: (label) => {
      const visible = (e: FakeHostEl): boolean => {
        for (let p: FakeHostEl | null = e; p; p = p.parent) if (p.style.display === "none") return false;
        return true;
      };
      return body.find("button").find((b) => b.textContent === label && visible(b));
    },
  };
}

/** An app whose workspace never reports its layout (so the drawer does not mount) and whose vault is a real directory. */
export function makeHostApp(root: string): MockApp {
  const a = {
    vault: {
      adapter: new FileSystemAdapter(root),
      configDir: ".obsidian",
      getAbstractFileByPath: (p: string) => (fs.existsSync(path.join(root, p)) ? new TFile(p) : null),
      on: (name: string, cb: (...args: any[]) => void) => ({ name, cb }),
    },
    workspace: {
      onLayoutReady: () => undefined,
      activeFile: null as TFile | null,
      leaves: [] as WorkspaceLeaf[],
      getActiveFile: () => a.workspace.activeFile,
      getLeavesOfType: () => [] as WorkspaceLeaf[],
      getLeaf: () => {
        const l = new WorkspaceLeaf();
        a.workspace.leaves.push(l);
        return l;
      },
      revealLeaf: async () => undefined,
      detachLeavesOfType: () => undefined,
      on: (name: string, cb: (...args: unknown[]) => void) => ({ name, cb }),
    },
    openWithDefaultApp: async () => undefined,
  };
  return a as unknown as MockApp;
}
