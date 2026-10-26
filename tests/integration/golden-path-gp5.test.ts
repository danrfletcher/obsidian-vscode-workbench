// @vitest-environment jsdom
/**
 * Golden path GP5 over the real Python PTY helper and a real /bin/sh, in a temp vault: a click on the strip (GP5a)
 * or Ctrl+` slides the drawer up with a shell in the open file's folder; `python3 estimate_time.py --help` prints the
 * script's usage (GP5c); hiding and revealing again shows the same shell with its history (GP5d). The terminal
 * emulator is a fake that records what it is written; every shell is killed after each test.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChildRegistry } from "../../src/child-registry";
import { DrawerToggle } from "../../src/hotkey/drawer-toggle";
import { listDescendants } from "../../src/process-utils";
import { TerminalFeature, type TerminalHost } from "../../src/terminal/feature";
import { FakeTerminalView } from "../fake-terminal-view";
import { CODE_VIEW, resetPage } from "../feature-rig";
import { isAlive, tempDir } from "../helpers";

const SCRIPT_REL = "AWS SA Associate Mock Exams/scripts/estimate_time.py";
/** A one-line stand-in for the real script: `--help` prints a usage block. */
const STUB_SCRIPT = 'import argparse; argparse.ArgumentParser(prog="estimate_time.py", description="Estimate how long a mock exam takes.").parse_args()\n';

interface Live {
  vault: string;
  feature: TerminalFeature;
  views: FakeTerminalView[];
  registry: ChildRegistry;
  active: { file: string | null };
}

const live: Live[] = [];
const everyPid = new Set<number>();

function start(files: Record<string, string>, activeFile: string | null): Live {
  const vault = tempDir();
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), content);
  }
  const registry = new ChildRegistry(null);
  const views: FakeTerminalView[] = [];
  const active = { file: activeFile };
  const statusBar = document.createElement("div");
  document.body.appendChild(statusBar);
  const host: TerminalHost = {
    document,
    window,
    vaultRoot: () => vault,
    activeFile: () => active.file,
    data: () => ({}),
    save: async () => undefined,
    shell: () => "/bin/sh",
    runtimeDir: () => path.join(vault, ".server"),
    registry,
    deviceStore: { get: () => "device-aaaa-1111", set: () => undefined },
    nonCodeDrawer: () => true,
    activeViewType: () => CODE_VIEW,
    codeViewType: CODE_VIEW,
    addStatusBarItem: () => {
      const el = document.createElement("div");
      statusBar.appendChild(el);
      return el;
    },
    confirmKill: async () => true,
  };
  const feature = new TerminalFeature(host, {
    createTerminal: () => {
      const v = new FakeTerminalView();
      views.push(v);
      return v;
    },
    // The real helper and a real /bin/sh; only the python3 lookup is fixed so the test does not depend on PATH.
    preflight: async () => ({ ok: true, python: "python3", shell: "/bin/sh" }),
    baseEnv: { ...process.env, PS1: "$ ", ENV: "" },
  });
  const l: Live = { vault, feature, views, registry, active };
  live.push(l);
  return l;
}

async function waitUntil(cond: () => boolean, ms = 10000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  if (!cond()) throw new Error(`condition not met in ${ms} ms`);
}

async function waitFor(view: FakeTerminalView, pattern: RegExp, ms = 10000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pattern.test(view.text())) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no output matching ${pattern} in ${ms} ms; got ${JSON.stringify(view.text())}`);
}

/** Run `pwd` and return what the shell printed between two markers. */
async function pwdOf(view: FakeTerminalView): Promise<string> {
  const id = Math.random().toString(36).slice(2, 8);
  view.type(`echo B${id}; pwd; echo E${id}\n`);
  await waitFor(view, new RegExp(`(?:^|\\n)B${id}\\r?\\n[^\\n]*\\n\\s*E${id}`));
  const m = view.text().match(new RegExp(`(?:^|\\n)B${id}\\r?\\n([^\\n]*?)\\r?\\n\\s*E${id}`));
  return m![1];
}

const remember = (l: Live) => l.registry.list().forEach((c) => everyPid.add(c.pid));

beforeEach(() => resetPage());

afterEach(async () => {
  await Promise.allSettled(live.splice(0).map((l) => l.feature.dispose()));
  for (const pid of everyPid) {
    if (!isAlive(pid)) continue;
    for (const d of listDescendants(pid)) {
      try { process.kill(d, "SIGKILL"); } catch { /* gone */ }
    }
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
  everyPid.clear();
  resetPage();
});

describe("GP5 with a real shell", () => {
  it("GP5a/c: a strip click slides the drawer up with a shell in the scripts folder, and `python3 estimate_time.py --help` prints the usage", async () => {
    const l = start({ [SCRIPT_REL]: STUB_SCRIPT }, SCRIPT_REL);
    l.feature.mount();
    expect(l.feature.drawer?.open).toBe(false);
    (document.querySelector(".vscw-strip") as HTMLElement).click(); // the strip, focus nowhere near an editor
    expect(l.feature.drawer?.open).toBe(true);
    expect(document.body.classList.contains("vscw-terminal-open")).toBe(true);
    await waitUntil(() => l.feature.sessions.count === 1);
    remember(l);
    const folder = fs.realpathSync(path.join(l.vault, "AWS SA Associate Mock Exams/scripts"));
    expect(await pwdOf(l.views[0])).toBe(folder);
    l.views[0].type("python3 estimate_time.py --help\n");
    await waitFor(l.views[0], /usage: estimate_time\.py \[-h\]/);
    await waitFor(l.views[0], /Estimate how long a mock exam takes\./);
  });

  it("GP5b/d/e: Ctrl+` (the relayed toggle) reveals the same, hides, and reveals the same shell with its history; focus follows", async () => {
    const l = start({ [SCRIPT_REL]: STUB_SCRIPT }, SCRIPT_REL);
    l.feature.mount();
    const toggle = new DrawerToggle(l.feature);
    const embed = { calls: [] as string[], blur() { this.calls.push("blur"); }, focus() { this.calls.push("focus"); } };
    expect(toggle.press(embed)).toBe("revealing");
    await waitUntil(() => l.feature.sessions.count === 1);
    remember(l);
    expect(embed.calls).toEqual(["blur"]);
    expect(l.views[0].focuses).toBeGreaterThan(0); // GP5e: the terminal has the keyboard
    l.views[0].type("python3 estimate_time.py --help\n");
    await waitFor(l.views[0], /usage: estimate_time\.py/);
    const firstPid = l.registry.list().map((c) => c.pid);
    expect(toggle.press(embed)).toBe("hidden");
    expect(embed.calls).toEqual(["blur", "focus"]);
    expect(toggle.press(embed)).toBe("shown");
    expect(l.registry.list().map((c) => c.pid)).toEqual(firstPid); // the same process
    expect(l.views).toHaveLength(1);
    expect(l.views[0].text()).toMatch(/usage: estimate_time\.py/); // history intact
    l.views[0].type("echo still-$((6*7))\n");
    await waitFor(l.views[0], /still-42/);
  });

  it("a shell variable set before hiding is still set after the drawer comes back (same shell, not a new one)", async () => {
    const l = start({ [SCRIPT_REL]: STUB_SCRIPT }, SCRIPT_REL);
    l.feature.mount();
    const toggle = new DrawerToggle(l.feature);
    toggle.press();
    await waitUntil(() => l.feature.sessions.count === 1);
    remember(l);
    l.views[0].type("GP5_MARK=kept\n");
    toggle.press();
    toggle.press();
    l.views[0].type("echo mark-[$GP5_MARK]\n");
    await waitFor(l.views[0], /mark-\[kept\]/);
  });

  it("E5: a file path with spaces and non-ASCII characters starts the shell in its folder", async () => {
    const rel = "Café Notes/my script.py";
    const l = start({ [rel]: STUB_SCRIPT }, rel);
    l.feature.mount();
    new DrawerToggle(l.feature).press();
    await waitUntil(() => l.feature.sessions.count === 1);
    remember(l);
    expect((await pwdOf(l.views[0])).normalize("NFC")).toBe(fs.realpathSync(path.join(l.vault, "Café Notes")).normalize("NFC"));
  });

  it("G12: with no active file the shell starts in the vault root", async () => {
    const l = start({ "note.md": "# n\n" }, null);
    l.feature.mount();
    new DrawerToggle(l.feature).press();
    await waitUntil(() => l.feature.sessions.count === 1);
    remember(l);
    expect(await pwdOf(l.views[0])).toBe(fs.realpathSync(l.vault));
  });

  it("G12: the folder is taken at creation and does not follow later tab switches; a new shell takes the then-active folder", async () => {
    const l = start({ [SCRIPT_REL]: STUB_SCRIPT, "Other/b.py": "x = 1\n" }, SCRIPT_REL);
    l.feature.mount();
    const toggle = new DrawerToggle(l.feature);
    toggle.press();
    await waitUntil(() => l.feature.sessions.count === 1);
    remember(l);
    const scripts = fs.realpathSync(path.join(l.vault, "AWS SA Associate Mock Exams/scripts"));
    l.active.file = "Other/b.py"; // the user switches tabs
    toggle.press();
    toggle.press();
    expect(await pwdOf(l.views[0])).toBe(scripts);
    l.feature.newSession(); // a new shell is created now: it starts in Other
    await waitUntil(() => l.feature.sessions.count === 2);
    remember(l);
    expect(await pwdOf(l.views[1])).toBe(fs.realpathSync(path.join(l.vault, "Other")));
    expect(await pwdOf(l.views[0])).toBe(scripts);
  });

  it("hiding the drawer leaves the shell process alive; quitting ends it", async () => {
    const l = start({ [SCRIPT_REL]: STUB_SCRIPT }, SCRIPT_REL);
    l.feature.mount();
    const toggle = new DrawerToggle(l.feature);
    toggle.press();
    await waitUntil(() => l.feature.sessions.count === 1);
    remember(l);
    const [pid] = [...everyPid];
    toggle.press();
    await new Promise((r) => setTimeout(r, 100));
    expect(isAlive(pid)).toBe(true);
    await l.feature.dispose();
    await waitUntil(() => !isAlive(pid));
  });
});
