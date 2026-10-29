// @vitest-environment jsdom
/**
 * The real session manager over the real Python PTY helper and /bin/sh: two sessions stay independent, and
 * killing one leaves the other running. The Obsidian side is a stub (a workspace view type, a status-bar element);
 * the terminal emulator is a fake that records what it is written. Every shell is killed in afterEach.
 */
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChildRegistry } from "../../src/child-registry";
import { TerminalFeature, type TerminalHost } from "../../src/terminal/feature";
import { listDescendants } from "../../src/process-utils";
import { FakeTerminalView } from "../fake-terminal-view";
import { CODE_VIEW, resetPage } from "../feature-rig";
import { isAlive, tempDir } from "../helpers";

interface Live {
  feature: TerminalFeature;
  views: FakeTerminalView[];
  registry: ChildRegistry;
  statusBar: HTMLElement;
  asked: string[];
}

const live: Live[] = [];
const everyPid = new Set<number>();

function start(): Live {
  const vault = tempDir();
  const registry = new ChildRegistry(null);
  const statusBar = document.createElement("div");
  document.body.appendChild(statusBar);
  const views: FakeTerminalView[] = [];
  const asked: string[] = [];
  const host: TerminalHost = {
    document,
    window,
    vaultRoot: () => vault,
    activeFile: () => null,
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
    confirmKill: async (title) => {
      asked.push(title);
      return true;
    },
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
  const l: Live = { feature, views, registry, statusBar, asked };
  live.push(l);
  return l;
}

/** Wait until `view`'s output matches, or fail with what it holds. */
async function waitFor(view: FakeTerminalView, pattern: RegExp, ms = 10000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pattern.test(view.text())) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no output matching ${pattern} in ${ms} ms; got ${JSON.stringify(view.text())}`);
}

async function waitUntil(cond: () => boolean, ms = 10000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  if (!cond()) throw new Error(`condition not met in ${ms} ms`);
}

const pidsOf = (l: Live) => l.registry.list().map((c) => c.pid);

beforeEach(() => resetPage());

afterEach(async () => {
  const cleaning = live.splice(0).map((l) => l.feature.dispose());
  await Promise.allSettled(cleaning);
  // Whatever a failed test left behind is killed by pid: only the helpers this test started, and what is under them.
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

async function twoSessions(): Promise<Live> {
  const l = start();
  l.feature.mount();
  l.feature.toggle();
  l.feature.newSession();
  await waitUntil(() => l.feature.sessions.count === 2);
  for (const pid of pidsOf(l)) everyPid.add(pid);
  return l;
}

describe("two real shells in the drawer", () => {
  it("the first reveal starts one real shell that runs commands (echo one)", async () => {
    const l = start();
    l.feature.mount();
    l.feature.toggle();
    await waitUntil(() => l.feature.sessions.count === 1);
    for (const pid of pidsOf(l)) everyPid.add(pid);
    l.views[0].type("echo one-$((20+22))\n");
    await waitFor(l.views[0], /one-42/);
  });

  it("two sessions are two processes, and a variable set in one is not there in the other", async () => {
    const l = await twoSessions();
    expect(l.feature.sessions.sessions).toHaveLength(2);
    expect(new Set(pidsOf(l)).size).toBe(2);
    const [a, b] = l.views;
    a.type("VSCW_TEST=alpha; echo A-[$VSCW_TEST]\n");
    b.type("echo B-[$VSCW_TEST]\n");
    await waitFor(a, /A-\[alpha\]/);
    await waitFor(b, /B-\[\]/);
    expect(a.text()).not.toMatch(/B-\[/);
    expect(b.text()).not.toMatch(/A-\[/);
    b.type("VSCW_TEST=beta; echo B2-[$VSCW_TEST]\n");
    a.type("echo A2-[$VSCW_TEST]\n");
    await waitFor(b, /B2-\[beta\]/);
    await waitFor(a, /A2-\[alpha\]/);
  });

  it("switching tabs does not disturb either shell: a command started in one finishes while the other tab is showing", async () => {
    const l = await twoSessions();
    const [a, b] = l.views;
    a.type("sleep 0.3; echo SLEPT\n");
    const ids = l.feature.sessions.sessions.map((s) => s.id);
    l.feature.sessions.activate(ids[0]);
    l.feature.sessions.activate(ids[1]);
    b.type("echo B-ready\n");
    await waitFor(b, /B-ready/);
    await waitFor(a, /SLEPT/);
    expect(l.feature.sessions.count).toBe(2);
  });

  it("killing one leaves the other running, and the status count follows", async () => {
    const l = await twoSessions();
    const [a, b] = l.views;
    expect(l.statusBar.textContent).toBe("2 shells");
    const [firstPid, secondPid] = pidsOf(l);
    await l.feature.killSession(l.feature.sessions.sessions[0].id);
    expect(l.asked).toEqual(["sh 1"]);
    await waitUntil(() => !isAlive(firstPid));
    expect(isAlive(secondPid)).toBe(true);
    expect(l.feature.sessions.sessions).toHaveLength(1);
    expect(l.feature.sessions.count).toBe(1);
    expect(l.statusBar.textContent).toBe("1 shell");
    b.type("echo still-here-$((6*7))\n");
    await waitFor(b, /still-here-42/);
    expect(a.disposed).toBe(true);
  });

  it("a shell that exits by itself (exit 3) leaves its tab, drops the count, and the other keeps working", async () => {
    const l = await twoSessions();
    const [a, b] = l.views;
    a.type("exit 3\n");
    await waitFor(a, /The shell has exited \(code 3\)/);
    await waitUntil(() => l.feature.sessions.count === 1);
    expect(l.statusBar.textContent).toBe("1 shell");
    expect(l.feature.sessions.sessions).toHaveLength(2);
    b.type("echo alive-$((1+1))\n");
    await waitFor(b, /alive-2/);
  });

  it("killing the last shell closes the drawer and ends the helper; the next reveal makes a fresh one", async () => {
    const l = start();
    l.feature.mount();
    l.feature.toggle();
    await waitUntil(() => l.feature.sessions.count === 1);
    const [pid] = pidsOf(l);
    everyPid.add(pid);
    await l.feature.killActive();
    await waitUntil(() => !isAlive(pid));
    expect(l.feature.drawer?.open).toBe(false);
    expect(l.statusBar.children).toHaveLength(0);
    l.feature.toggle();
    await waitUntil(() => l.feature.sessions.count === 1);
    for (const p of pidsOf(l)) everyPid.add(p);
    expect(pidsOf(l)).not.toContain(pid);
    l.views[1].type("echo fresh-$((2*3))\n");
    await waitFor(l.views[1], /fresh-6/);
  });

  it("disposing the feature (quit) takes every helper and shell down", async () => {
    const l = await twoSessions();
    const pids = pidsOf(l);
    const children = pids.flatMap((p) => listDescendants(p));
    await l.feature.dispose();
    await waitUntil(() => pids.every((p) => !isAlive(p)) && children.every((p) => !isAlive(p)));
    expect(l.registry.size).toBe(0);
  });
});
