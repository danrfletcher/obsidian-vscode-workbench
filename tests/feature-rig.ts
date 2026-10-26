/** The terminal feature on a jsdom page with fake helper processes and a fake terminal emulator, for the tab, layout and status-bar tests. */
import * as fs from "node:fs";
import * as path from "node:path";
import { ChildRegistry } from "../src/child-registry";
import { TerminalFeature, type TerminalHost } from "../src/terminal/feature";
import type { PreflightResult } from "../src/terminal/pty-preflight";
import { fakeWorld } from "./fake-pty";
import { FakeTerminalView } from "./fake-terminal-view";
import { tempDir } from "./helpers";

export const GOOD: PreflightResult = { ok: true, python: "/usr/bin/python3", shell: "/bin/zsh" };
export const tick = () => new Promise((r) => setTimeout(r, 5));

export const CODE_VIEW = "vscode-workbench-code";

export interface Rig {
  host: TerminalHost;
  data: Record<string, unknown>;
  views: FakeTerminalView[];
  world: ReturnType<typeof fakeWorld>;
  feature: TerminalFeature;
  vault: string;
  confirm: { answer: boolean; asked: string[] };
  view: { type: string };
  setting: { nonCodeDrawer: boolean };
  statusBar: HTMLElement;
  /** The preflight result for the next shells; a function so a test can change it. */
  preflight: { result: () => PreflightResult };
}

export function featureRig(opts: { data?: Record<string, unknown>; vault?: string } = {}): Rig {
  const vault = opts.vault ?? tempDir();
  fs.mkdirSync(path.join(vault, "scripts"), { recursive: true });
  const world = fakeWorld();
  const views: FakeTerminalView[] = [];
  const data = opts.data ?? {};
  const statusBar = document.createElement("div");
  statusBar.className = "status-bar";
  document.body.appendChild(statusBar);
  const r = { confirm: { answer: true, asked: [] as string[] }, view: { type: "markdown" }, setting: { nonCodeDrawer: true }, preflight: { result: () => GOOD }, statusBar } as unknown as Rig;
  const host: TerminalHost = {
    document,
    window,
    vaultRoot: () => vault,
    activeFile: () => "scripts/run.py",
    data: () => data,
    save: async () => undefined,
    shell: () => "/bin/zsh",
    runtimeDir: () => path.join(vault, ".server"),
    registry: new ChildRegistry(null),
    deviceStore: { get: () => "device-aaaa-1111", set: () => undefined },
    nonCodeDrawer: () => r.setting.nonCodeDrawer,
    activeViewType: () => r.view.type,
    codeViewType: CODE_VIEW,
    addStatusBarItem: () => {
      const el = document.createElement("div");
      statusBar.appendChild(el);
      return el;
    },
    confirmKill: async (title) => {
      r.confirm.asked.push(title);
      return r.confirm.answer;
    },
  };
  const feature = new TerminalFeature(host, {
    createTerminal: () => {
      const v = new FakeTerminalView();
      views.push(v);
      return v;
    },
    preflight: async () => r.preflight.result(),
    session: world.deps,
    baseEnv: { PATH: "/usr/bin" },
  });
  return Object.assign(r, { host, data, views, world, feature, vault });
}

export const q = <T extends Element = HTMLElement>(sel: string): T => document.querySelector(sel) as T;
export const qa = <T extends Element = HTMLElement>(sel: string): T[] => [...document.querySelectorAll(sel)] as T[];
export const strip = () => q<HTMLButtonElement>(".vscw-strip");
export const root = () => q(".vscw-root");
export const px = (name: string) => Number.parseFloat(document.body.style.getPropertyValue(name));
export const tabs = () => qa(".vscw-tab");
/** The tab's label text, in order. */
export const tabLabels = () => tabs().map((t) => t.textContent);
export const activeTab = () => q(".vscw-tab.vscw-active");
/** The panes that are showing (not hidden). */
export const shownPanes = () => qa(".vscw-pane").filter((p) => !p.hidden);
export const statusText = (r: Rig) => r.statusBar.textContent;

export function resetPage(): void {
  document.body.className = "";
  document.body.removeAttribute("style");
  document.body.innerHTML = "";
}
