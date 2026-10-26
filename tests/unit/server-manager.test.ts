/**
 * The server state machine (stopped, starting, running, crashed, stopped-by-idle,
 * and failed): single-flight start, a port chosen per start, stop on quit,
 * crash detection and restart. `child_process.spawn` is replaced by a fake child
 * that can run, exit, crash or print a failure line; process signalling is
 * mocked so no real pid is ever touched.
 */
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned: Array<{ child: FakeChild; cmd: string; args: string[] }> = [];
let nextPid = 2_000_000_000;

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = nextPid++;
  /** Print a stderr line then exit, like a server that fails to start. */
  failWith(line: string, code = 3): void {
    this.stderr.emit("data", Buffer.from(`${line}\n`));
    this.emit("exit", code, null);
  }
  crash(sig: NodeJS.Signals = "SIGKILL"): void {
    this.emit("exit", null, sig);
  }
}

vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawn: vi.fn((cmd: string, args: string[]) => {
    const child = new FakeChild();
    spawned.push({ child, cmd, args });
    return child;
  }),
}));

const signals: Array<{ pid: number; sig: string; group: boolean }> = [];
vi.mock("../../src/process-utils", async (orig) => ({
  ...(await orig<typeof import("../../src/process-utils")>()),
  listDescendants: () => [],
  pidsWithCommandContaining: () => [],
  isAlive: () => false,
  signal: (pid: number, sig: string) => void signals.push({ pid, sig, group: false }),
  signalGroup: (pid: number, sig: string) => void signals.push({ pid, sig, group: true }),
}));

import { ChildRegistry } from "../../src/child-registry";
import { ServerStartError, StartCancelledError, WorkbenchServer, type CodeBuild } from "../../src/server";
import { ServerManager, type ServerState } from "../../src/server-manager";
import { tempDir } from "../helpers";

const build: CodeBuild = { cli: "/fake/code", version: [1, 0, 0], versionText: "1.0.0", extensionsDir: null };

let runtimeDir: string;
let ports: number[];
let probeStatus: number | null;
let registry: ChildRegistry;
let created = 0;
let freshPort = 60000;
const managers: ServerManager[] = [];

function makeManager(over: { healthIntervalMs?: number; probe?: () => Promise<number | null> } = {}): ServerManager {
  const m = new ServerManager({
    registry,
    healthIntervalMs: over.healthIntervalMs ?? 0,
    create: async () => {
      created++;
      return new WorkbenchServer({
        build,
        runtimeDir,
        acceptLicense: true,
        registry,
        pollIntervalMs: 5,
        findPort: async () => ports.shift() ?? freshPort++,
        probe: over.probe ?? (async () => probeStatus),
      });
    },
  });
  managers.push(m);
  return m;
}

const lastChild = () => spawned[spawned.length - 1].child;
const portOf = (i: number) => Number(spawned[i].args[spawned[i].args.indexOf("--port") + 1]);

function track(m: ServerManager): ServerState[] {
  const seen: ServerState[] = [];
  m.onChange((s) => seen.push(s));
  return seen;
}

beforeEach(() => {
  spawned.length = 0;
  signals.length = 0;
  runtimeDir = path.join(tempDir(), ".server");
  ports = [];
  probeStatus = 302;
  created = 0;
  registry = new ChildRegistry(null);
});
afterEach(async () => {
  vi.useRealTimers();
  // release the ports the fake servers hold, so tests do not see each other's
  await Promise.all(managers.splice(0).map((m) => m.stop("quit")));
});

describe("start", () => {
  it("is stopped until asked; a start goes stopped -> starting -> running", async () => {
    const m = makeManager();
    expect(m.state).toBe("stopped");
    expect(spawned).toHaveLength(0); // constructing a manager spawns nothing
    const seen = track(m);
    const r = await m.ensureStarted();
    expect(seen).toEqual(["starting", "running"]);
    expect(m.state).toBe("running");
    expect(m.current).toBe(r);
    expect(r.baseUrl).toBe(`http://127.0.0.1:${r.port}`);
  });

  it("passes the loopback host and a token file, never the token, to the spawned CLI", async () => {
    const m = makeManager();
    const r = await m.ensureStarted();
    const { args } = spawned[0];
    expect(args[args.indexOf("--host") + 1]).toBe("127.0.0.1");
    expect(args.join(" ")).not.toContain(r.token);
  });

  it("is single-flight: concurrent callers share one spawn and one result", async () => {
    probeStatus = 202; // still downloading, so the start stays in flight while the callers pile up
    const m = makeManager();
    const all = [m.ensureStarted(), m.ensureStarted(), m.ensureStarted()];
    await new Promise((r) => setTimeout(r, 30));
    expect(m.state).toBe("starting");
    probeStatus = 302;
    const results = await Promise.all(all);
    expect(spawned).toHaveLength(1);
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
    expect(await m.ensureStarted()).toBe(results[0]); // and a later call while running spawns nothing
    expect(spawned).toHaveLength(1);
  });

  it("chooses a port for every start", async () => {
    ports = [52001, 52002, 52003];
    const m = makeManager();
    await m.ensureStarted();
    await m.stop("manual");
    await m.ensureStarted();
    await m.stop("manual");
    await m.ensureStarted();
    expect([portOf(0), portOf(1), portOf(2)]).toEqual([52001, 52002, 52003]);
  });

  it("never reuses a port that another server of ours still holds", async () => {
    ports = [52010, 52010, 52010, 52011];
    const a = makeManager();
    const b = makeManager();
    await a.ensureStarted();
    await b.ensureStarted();
    expect(portOf(0)).toBe(52010);
    expect(portOf(1)).toBe(52011);
    await a.stop("manual");
    await b.stop("manual");
  });

  it("uses a different token for every start", async () => {
    const m = makeManager();
    const first = await m.ensureStarted();
    await m.stop("manual");
    const second = await m.ensureStarted();
    expect(second.token).not.toBe(first.token);
  });

  it("registers the child (for the quit sweep) as soon as it is spawned, and unregisters it on stop", async () => {
    const m = makeManager();
    await m.ensureStarted();
    expect(registry.list()).toEqual([{ pid: lastChild().pid, label: "vscode-server" }]);
    await m.stop("manual");
    expect(registry.size).toBe(0);
  });
});

describe("failure", () => {
  beforeEach(() => {
    probeStatus = null; // nothing answers yet, so the start is still waiting when the child fails
  });

  it("a server that prints a failure line and exits: state failed, error carries the code and last stderr line", async () => {
    const m = makeManager();
    const seen = track(m);
    const p = m.ensureStarted();
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    lastChild().failWith("Error: something specific broke", 3);
    const err = (await p.catch((e: unknown) => e)) as ServerStartError;
    expect(err).toBeInstanceOf(ServerStartError);
    expect(err.exitCode).toBe(3);
    expect(err.stderrTail).toBe("Error: something specific broke");
    expect(seen).toEqual(["starting", "failed"]);
    expect(m.state).toBe("failed");
    expect(m.lastError).toBe(err);
    expect(registry.size).toBe(0);
  });

  it("a spawn error (missing binary) fails the start", async () => {
    const m = makeManager();
    const p = m.ensureStarted();
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    lastChild().emit("error", new Error("spawn /fake/code ENOENT"));
    const err = (await p.catch((e: unknown) => e)) as ServerStartError;
    expect(err.kind).toBe("spawn");
    expect(m.state).toBe("failed");
  });

  it("restart works from the failed state and gives a running server", async () => {
    const m = makeManager();
    const p = m.ensureStarted();
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    lastChild().failWith("boom", 1);
    await p.catch(() => undefined);
    expect(m.state).toBe("failed");
    probeStatus = 302; // the next server answers
    const r = await m.restart();
    expect(m.state).toBe("running");
    expect(r.port).toBeGreaterThan(0);
    expect(spawned).toHaveLength(2);
  });
});

describe("stop", () => {
  it("stop('idle') gives stopped-by-idle, signals the child's group and clears the registry", async () => {
    const m = makeManager();
    await m.ensureStarted();
    const pid = lastChild().pid;
    const seen = track(m);
    await m.stop("idle");
    expect(seen).toEqual(["stopped-by-idle"]);
    expect(m.state).toBe("stopped-by-idle");
    expect(m.current).toBeNull();
    expect(signals).toContainEqual({ pid, sig: "SIGTERM", group: true });
    expect(registry.size).toBe(0);
  });

  it("a stopped-by-idle server starts again on the next ensureStarted, with a new port", async () => {
    ports = [52020, 52021];
    const m = makeManager();
    await m.ensureStarted();
    await m.stop("idle");
    const r = await m.ensureStarted();
    expect(m.state).toBe("running");
    expect(r.port).toBe(52021);
  });

  it("stop('quit') gives stopped, and the kill signals go out synchronously (before any await)", async () => {
    const m = makeManager();
    await m.ensureStarted();
    signals.length = 0;
    const done = m.stop("quit");
    expect(signals.length).toBeGreaterThan(0); // already signalled, nothing awaited yet
    await done;
    expect(m.state).toBe("stopped");
  });

  it("shutdown stops the server and kills every other registered child", async () => {
    const m = makeManager();
    await m.ensureStarted();
    const shell = vi.fn();
    registry.register({ pid: 2_100_000_001, label: "shell", match: "zsh", kill: shell });
    await m.shutdown();
    expect(m.state).toBe("stopped");
    expect(shell).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
  });

  it("stopping while a start is in flight cancels it: the caller gets StartCancelledError and the state is stopped", async () => {
    probeStatus = 202;
    const m = makeManager();
    const p = m.ensureStarted();
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    await m.stop("quit");
    await expect(p).rejects.toBeInstanceOf(StartCancelledError);
    expect(m.state).toBe("stopped");
  });

  it("stop with nothing started is harmless", async () => {
    const m = makeManager();
    await m.stop("quit");
    expect(m.state).toBe("stopped");
    expect(spawned).toHaveLength(0);
  });
});

describe("crash", () => {
  it("a server that dies on its own is crashed, not restarted by itself", async () => {
    vi.useFakeTimers();
    const m = makeManager();
    await m.ensureStarted();
    const seen = track(m);
    lastChild().crash("SIGKILL");
    expect(m.state).toBe("crashed");
    expect(m.current).toBeNull();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(spawned).toHaveLength(1); // no automatic restart, so nothing can loop
    expect(seen).toEqual(["crashed"]);
  });

  it("a restart after a crash gives a new port and token; a second crash within the same minute shows crashed again and still does not loop", async () => {
    vi.useFakeTimers();
    ports = [52030, 52031];
    const m = makeManager();
    const first = await m.ensureStarted();
    lastChild().crash();
    expect(m.state).toBe("crashed");

    const second = await m.restart();
    expect(m.state).toBe("running");
    expect(second.port).not.toBe(first.port);
    expect(second.token).not.toBe(first.token);

    await vi.advanceTimersByTimeAsync(20_000); // still inside the same minute
    lastChild().crash();
    expect(m.state).toBe("crashed");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(spawned).toHaveLength(2); // restarted once, by the user; the second crash started nothing
  });

  it("a stop is not a crash: the exit that follows stop() does not change the state", async () => {
    const m = makeManager();
    await m.ensureStarted();
    const child = lastChild();
    await m.stop("manual");
    child.crash("SIGTERM");
    expect(m.state).toBe("stopped");
  });

  it("notices a server that is gone while its process lingers: two failed probes in a row", async () => {
    vi.useFakeTimers();
    let answer: number | null = 302;
    const m = makeManager({ healthIntervalMs: 1000, probe: async () => answer });
    await m.ensureStarted();
    answer = null;
    await vi.advanceTimersByTimeAsync(1000);
    expect(m.state).toBe("running"); // one miss is not a crash
    answer = 302;
    await vi.advanceTimersByTimeAsync(1000);
    answer = null;
    await vi.advanceTimersByTimeAsync(1000);
    expect(m.state).toBe("running"); // the miss counter was reset by the good probe
    await vi.advanceTimersByTimeAsync(1000);
    expect(m.state).toBe("crashed");
  });

  it("clears whatever the dead server left behind by stopping it", async () => {
    const m = makeManager();
    await m.ensureStarted();
    signals.length = 0;
    lastChild().crash();
    await vi.waitFor(() => expect(registry.size).toBe(0));
  });
});
