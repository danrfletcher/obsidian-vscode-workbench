/**
 * Integration: the managed server against tests/fixtures/fake-code.sh, a stub with
 * the same CLI shape as `code serve-web` (VS Code itself is not in the test
 * image). Real processes, real ports, real signals: loopback binding, token-file
 * mode, no token in any argument list, `kill -9` crash detection, restart, and
 * the shutdown of every child registered with the registry.
 */
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChildRegistry } from "../../src/child-registry";
import { PidFile } from "../../src/pidfile";
import { describeFailure } from "../../src/failure-messages";
import { ServerStartError, WorkbenchServer, type CodeBuild } from "../../src/server";
import { ServerManager } from "../../src/server-manager";
import { FAKE_CODE, isAlive, listenersOn, tempDir } from "../helpers";

const build: CodeBuild = { cli: FAKE_CODE, version: [1, 0, 0], versionText: "1.0.0", extensionsDir: null };

let runtimeDir: string;
let fakePids: string;
let argsFile: string;
let registry: ChildRegistry;
let pidfile: PidFile;
let managers: ServerManager[] = [];
const extraPids: number[] = [];

function makeManager(over: { runtimeDir?: string; workspace?: string; healthIntervalMs?: number } = {}): ServerManager {
  const m = new ServerManager({
    registry,
    healthIntervalMs: over.healthIntervalMs ?? 0,
    create: async () =>
      new WorkbenchServer({
        build,
        runtimeDir: over.runtimeDir ?? runtimeDir,
        acceptLicense: true,
        pollIntervalMs: 25,
        registry,
        workspace: over.workspace,
        env: { FAKE_CODE_NODE: process.execPath, FAKE_CODE_PIDFILE: fakePids, FAKE_CODE_ARGSFILE: argsFile },
      }),
  });
  managers.push(m);
  return m;
}

const serverPids = () => (fs.existsSync(fakePids) ? fs.readFileSync(fakePids, "utf8").split("\n").filter(Boolean).map(Number) : []);
const argsOf = (pid: number) => execFileSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8" });
const until = (fn: () => void) => import("vitest").then(({ vi }) => vi.waitFor(fn, { timeout: 8000, interval: 50 }));

beforeEach(() => {
  runtimeDir = path.join(tempDir(), ".server");
  fakePids = path.join(tempDir(), "fake-pids");
  argsFile = path.join(tempDir(), "args.json");
  pidfile = new PidFile(path.join(runtimeDir, "pids.json"));
  registry = new ChildRegistry(pidfile);
  managers = [];
});

afterEach(async () => {
  await Promise.all(managers.map((m) => m.stop("quit")));
  for (const pid of [...serverPids(), ...extraPids.splice(0)]) if (isAlive(pid)) process.kill(pid, "SIGKILL");
});

describe("a started server", () => {
  it("listens on 127.0.0.1 only, with a 0600 token file and no token in any argument list (F4, token rule)", async () => {
    const m = makeManager();
    const r = await m.ensureStarted();

    const lsof = execFileSync("lsof", ["-nP", `-iTCP:${r.port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    expect(lsof).toContain(`127.0.0.1:${r.port}`);
    expect(lsof).not.toMatch(/\*:\d+|0\.0\.0\.0|\[::\]/);

    const args = JSON.parse(fs.readFileSync(argsFile, "utf8")) as string[];
    expect(args[args.indexOf("--host") + 1]).toBe("127.0.0.1");
    const tokenFile = args[args.indexOf("--connection-token-file") + 1];
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(tokenFile, "utf8")).toBe(r.token);

    const wrapper = m.serverInstance?.pid as number;
    for (const pid of [wrapper, ...serverPids()]) expect(argsOf(pid)).not.toContain(r.token);
    expect(JSON.stringify(args)).not.toContain(r.token);
  });

  it("records the child and the vault path (spaces, non-ASCII) in the pidfile, and removes the entry on stop (E5)", async () => {
    const vault = path.join(tempDir(), "Mock Exams", "ünïcode dir");
    fs.mkdirSync(vault, { recursive: true });
    const rd = path.join(vault, ".server");
    pidfile = new PidFile(path.join(rd, "pids.json"));
    registry = new ChildRegistry(pidfile);
    const m2 = makeManager({ runtimeDir: rd, workspace: vault });
    const r = await m2.ensureStarted();
    const wrapper = m2.serverInstance?.pid as number;

    const { entries } = pidfile.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ pid: wrapper, label: "vscode-server", match: "serve-web", workspace: vault, group: true });
    expect(JSON.stringify(entries)).not.toContain(r.token);

    await m2.stop("manual");
    expect(isAlive(wrapper)).toBe(false);
    expect(listenersOn(r.port)).toEqual([]);
    expect(fs.existsSync(pidfile.file)).toBe(false);
  });

  it("two servers running at once get two different ports", async () => {
    const a = makeManager({ runtimeDir: path.join(tempDir(), ".server") });
    const b = makeManager({ runtimeDir: path.join(tempDir(), ".server") });
    const [ra, rb] = await Promise.all([a.ensureStarted(), b.ensureStarted()]);
    expect(ra.port).not.toBe(rb.port);
    expect(listenersOn(ra.port).length).toBeGreaterThan(0);
    expect(listenersOn(rb.port).length).toBeGreaterThan(0);
  });

  it("stop frees the port and kills the wrapper and the server behind it", async () => {
    const m = makeManager();
    const r = await m.ensureStarted();
    const wrapper = m.serverInstance?.pid as number;
    const [server] = serverPids();
    await m.stop("idle");
    expect(isAlive(wrapper)).toBe(false);
    expect(isAlive(server)).toBe(false);
    expect(listenersOn(r.port)).toEqual([]);
    expect(m.state).toBe("stopped-by-idle");
  });
});

describe("crash (kill -9)", () => {
  it("kill -9 of the server process is noticed, state is crashed, and nothing restarts by itself", async () => {
    const m = makeManager();
    const r = await m.ensureStarted();
    const [server] = serverPids();
    process.kill(server, "SIGKILL");
    await until(() => expect(m.state).toBe("crashed"));
    await new Promise((res) => setTimeout(res, 400));
    expect(m.state).toBe("crashed");
    expect(serverPids()).toHaveLength(1); // no second server was started
    expect(listenersOn(r.port)).toEqual([]);
  });

  it("kill -9 of the wrapper leaves the real server running; the crash cleanup finds it by its token file and stops it", async () => {
    const m = makeManager();
    const r = await m.ensureStarted();
    const wrapper = m.serverInstance?.pid as number;
    const [server] = serverPids();
    process.kill(wrapper, "SIGKILL");
    await until(() => expect(m.state).toBe("crashed"));
    await until(() => expect(isAlive(server)).toBe(false));
    expect(listenersOn(r.port)).toEqual([]);
  });

  it("restart gives a new port and a new token; a second crash shows crashed again without looping", async () => {
    const m = makeManager();
    const first = await m.ensureStarted();
    process.kill(serverPids()[0], "SIGKILL");
    await until(() => expect(m.state).toBe("crashed"));

    const second = await m.restart();
    expect(m.state).toBe("running");
    expect(second.port).not.toBe(first.port);
    expect(second.token).not.toBe(first.token);
    expect(fs.readFileSync(path.join(runtimeDir, "connection-token"), "utf8")).toBe(second.token);

    process.kill(serverPids()[1], "SIGKILL");
    await until(() => expect(m.state).toBe("crashed"));
    await new Promise((res) => setTimeout(res, 400));
    expect(serverPids()).toHaveLength(2);
    expect(m.state).toBe("crashed");
  });

  it("a server that stops answering while its process lingers is noticed by the health probe", async () => {
    const m = makeManager({ healthIntervalMs: 100 });
    await m.ensureStarted();
    const [server] = serverPids();
    process.kill(server, "SIGSTOP"); // alive but not answering
    try {
      await until(() => expect(m.state).toBe("crashed"));
    } finally {
      process.kill(server, "SIGCONT");
    }
  });
});

describe("the child registry on quit", () => {
  it("shutdown kills the server and every other registered child process", async () => {
    const m = makeManager();
    const r = await m.ensureStarted();
    const wrapper = m.serverInstance?.pid as number;
    const [server] = serverPids();

    // A stand-in for a shell that a later PR registers: its own process group, killed through the registry.
    const shell = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    shell.unref();
    const shellPid = shell.pid as number;
    extraPids.push(shellPid);
    registry.register({
      pid: shellPid,
      label: "shell",
      match: "sleep",
      group: true,
      kill: () => {
        process.kill(-shellPid, "SIGTERM");
      },
    });
    expect(registry.size).toBe(2);
    expect(pidfile.read().entries.map((e) => e.label).sort()).toEqual(["shell", "vscode-server"]);

    await m.shutdown();

    await until(() => {
      expect(isAlive(wrapper)).toBe(false);
      expect(isAlive(server)).toBe(false);
      expect(isAlive(shellPid)).toBe(false);
    });
    expect(listenersOn(r.port)).toEqual([]);
    expect(registry.size).toBe(0);
    expect(fs.existsSync(pidfile.file)).toBe(false);
    expect(m.state).toBe("stopped");
  });
});

describe("start failures with real processes", () => {
  /** A manager over the fake serve-web in `mode`, with the download-host reachability answered by `reachable`. */
  function failing(mode: string, extra: Record<string, string> = {}, reachable = false, over: Record<string, unknown> = {}) {
    const m = new ServerManager({
      registry,
      healthIntervalMs: 0,
      create: async () =>
        new WorkbenchServer({
          build,
          runtimeDir,
          acceptLicense: true,
          pollIntervalMs: 25,
          registry,
          downloadHostReachable: async () => reachable,
          env: { FAKE_CODE_NODE: process.execPath, FAKE_CODE_MODE: mode, FAKE_CODE_PIDFILE: fakePids, ...extra },
          ...over,
        }),
    });
    managers.push(m);
    return m;
  }
  const failure = async (m: ServerManager) => (await m.ensureStarted().catch((e: unknown) => e)) as ServerStartError;

  // The real `code serve-web` (checked by hand against VS Code 1.144) writes its log to stdout, leaves stderr
  // empty, never exits after a failed download, keeps answering 202 and logs a new "Downloading server" line
  // for each request. The fixture's "offline" mode does the same.
  it("a failed download is noticed while the server still answers 202, and says the network is unreachable", async () => {
    const t0 = Date.now();
    const err = await failure(failing("offline"));
    expect(err).toBeInstanceOf(ServerStartError);
    expect(err.kind).toBe("download");
    expect(Date.now() - t0).toBeLessThan(5000); // not the 300 s download timeout
    expect(err.stderrTail).toContain("Downloading server");
    expect(err.stderrTail).toContain("Network is unreachable");
    expect(describeFailure(err).kind).toBe("offline-first-run");
    expect(describeFailure(err).message).toContain("the network is unreachable");
    expect(managersState()).toBe("failed");
    expect(registry.size).toBe(0);
    for (const pid of serverPids()) expect(isAlive(pid)).toBe(false);
  });

  it("the same failure with the download host reachable is a plain download failure, not an offline one", async () => {
    const err = await failure(failing("offline", {}, true));
    expect(err.kind).toBe("download");
    expect(describeFailure(err).kind).toBe("download");
    expect(describeFailure(err).message).not.toContain("network is unreachable");
  });

  it("an error-level log line about the download fails the start", async () => {
    const err = await failure(failing("download-error-log"));
    expect(err.kind).toBe("download");
    expect(err.stderrTail).toContain("error Error downloading server: connection failed");
  });

  it("the page that reports a failed download fails the start", async () => {
    const err = await failure(failing("download-500"));
    expect(err.kind).toBe("download");
    expect(err.stderrTail).toContain("An error was encountered downloading the server");
  });

  it("a slow download that is really in progress does not fail: one log line, many 202s, then ready", async () => {
    const m = failing("slow-download", { FAKE_CODE_DOWNLOAD_REQUESTS: "12" });
    await expect(m.ensureStarted()).resolves.toMatchObject({ port: expect.any(Number) });
    expect(m.state).toBe("running");
  });

  it("a cached build still starts while the network is down (the fixture's exception)", async () => {
    const commit = "c".repeat(40);
    const m = failing("offline", { FAKE_CODE_OFFLINE_EXCEPT: commit }, false, { build: { ...build, commit } });
    await expect(m.ensureStarted()).resolves.toMatchObject({ port: expect.any(Number) });
  });

  it("keeps the stdout log lines in the failure tail: the last line of an exit comes from stdout, with no token and no banner", async () => {
    const err = await failure(failing("exit-stdout"));
    expect(err.kind).toBe("exit");
    expect(err.exitCode).toBe(7);
    expect(err.stderrTail).toBe("[2026-10-26 11:36:36] error could not bind to 127.0.0.1:1 (os error 48)");
    expect(describeFailure(err).kind).toBe("port-bind");
    expect(describeFailure(err).message).toContain("Last message: [2026-10-26 11:36:36] error could not bind");
  });

  function managersState() {
    return managers[managers.length - 1].state;
  }
});
