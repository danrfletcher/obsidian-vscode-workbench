/**
 * Integration: WorkbenchServer against tests/fixtures/fake-code.sh, a shell script
 * that mimics `code serve-web`. The real VS Code binary is not used in this file.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerStartError, StartCancelledError, WorkbenchServer, checkServeWebSupport, findFreePort as freePort, heldPortsSnapshot, type CodeBuild } from "../../src/server";
import type { MirrorRequest } from "../../src/mirror/mirror";
import { FAKE_CODE, isAlive, listenersOn, tempDir } from "../helpers";
import { buildTree, snapshotTree, stateDb } from "../mirror-tree";

let runtimeDir: string;
let pidFile: string;
let argsFile: string;
let servers: WorkbenchServer[] = [];

const build: CodeBuild = { cli: FAKE_CODE, version: [1, 0, 0], versionText: "1.0.0", extensionsDir: null };

function make(env: NodeJS.ProcessEnv = {}, extra: Partial<ConstructorParameters<typeof WorkbenchServer>[0]> = {}): WorkbenchServer {
  const s = new WorkbenchServer({
    build,
    runtimeDir,
    acceptLicense: true,
    pollIntervalMs: 25,
    env: { FAKE_CODE_NODE: process.execPath, FAKE_CODE_PIDFILE: pidFile, FAKE_CODE_ARGSFILE: argsFile, ...env },
    ...extra,
  });
  servers.push(s);
  return s;
}

function get(port: number, urlPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: urlPath }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on("error", reject);
  });
}

const serverPids = () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : []);

beforeEach(() => {
  runtimeDir = path.join(tempDir(), ".server");
  pidFile = path.join(tempDir(), "pids");
  argsFile = path.join(tempDir(), "args.json");
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map((s) => s.stop()));
  for (const pid of serverPids()) if (isAlive(pid)) process.kill(pid, "SIGKILL");
});

describe("start", () => {
  it("starts, becomes ready on a loopback port and answers only with the token", async () => {
    const s = make();
    const r = await s.ensureStarted();
    expect(r.baseUrl).toBe(`http://127.0.0.1:${r.port}`);
    expect(await get(r.port, `/?tkn=${r.token}`)).toBe(302);
    expect(await get(r.port, "/?tkn=wrong")).toBe(403);
    expect(await get(r.port, "/")).toBe(403);
  });

  it("spawns with the loopback host, a token file and no token on the command line", async () => {
    const s = make();
    const r = await s.ensureStarted();
    const args = JSON.parse(fs.readFileSync(argsFile, "utf8")) as string[];
    expect(args[args.indexOf("--host") + 1]).toBe("127.0.0.1");
    expect(args[args.indexOf("--port") + 1]).toBe(String(r.port));
    const tokenFile = args[args.indexOf("--connection-token-file") + 1];
    expect(fs.readFileSync(tokenFile, "utf8")).toBe(r.token);
    expect(args.join(" ")).not.toContain(r.token);
    expect(args).toContain("--accept-server-license-terms");
    expect(args).toContain("--disable-telemetry");
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
  });

  it("passes the build's commit as --commit-id to the spawned process (F5)", async () => {
    const sha = "a57ca762e62475ed8fc64b5aec67485c06766141";
    const s = make({}, { build: { ...build, commit: sha } });
    await s.ensureStarted();
    const args = JSON.parse(fs.readFileSync(argsFile, "utf8")) as string[];
    expect(args[args.indexOf("--commit-id") + 1]).toBe(sha);
  });

  it("listens only on 127.0.0.1 (F4)", async () => {
    const s = make();
    const r = await s.ensureStarted();
    expect(listenersOn(r.port).length).toBeGreaterThan(0);
    const lsof = (await import("node:child_process")).execFileSync("lsof", ["-nP", `-iTCP:${r.port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    expect(lsof).toContain(`127.0.0.1:${r.port}`);
    expect(lsof).not.toMatch(/\*:\d+|0\.0\.0\.0|\[::\]/);
  });

  it("waits through a 202 'still downloading' phase before reporting ready", async () => {
    const s = make({ FAKE_CODE_DOWNLOAD_REQUESTS: "4" });
    const r = await s.ensureStarted();
    expect(await get(r.port, `/?tkn=${r.token}`)).toBe(302);
  });

  it("uses a fresh token on every start", async () => {
    const a = make();
    const t1 = (await a.ensureStarted()).token;
    await a.stop();
    const b = make();
    const t2 = (await b.ensureStarted()).token;
    expect(t2).not.toBe(t1);
    expect(fs.readFileSync(path.join(runtimeDir, "connection-token"), "utf8")).toBe(t2);
  });
});

describe("reuse (a second file reuses the one server)", () => {
  it("concurrent and repeated ensureStarted calls share one process", async () => {
    const s = make();
    const [a, b] = await Promise.all([s.ensureStarted(), s.ensureStarted()]);
    const c = await s.ensureStarted();
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(serverPids()).toHaveLength(1);
  });
});

describe("heldPortsSnapshot (the trust seed's keep-list)", () => {
  it("holds a running server's port, loses it on stop, and is a copy a caller cannot use to change the real set", async () => {
    const s = make();
    const r = await s.ensureStarted();
    const during = heldPortsSnapshot();
    expect(during).toContain(r.port);
    during.length = 0;
    expect(heldPortsSnapshot()).toContain(r.port);
    await s.stop();
    expect(heldPortsSnapshot()).not.toContain(r.port);
  });

  it("lists two running servers sorted", async () => {
    const [a, b] = [make(), make()];
    const [ra, rb] = [await a.ensureStarted(), await b.ensureStarted()];
    const snap = heldPortsSnapshot();
    expect(snap).toEqual(expect.arrayContaining([ra.port, rb.port]));
    expect(snap).toEqual([...snap].sort((x, y) => x - y));
  });
});

describe("stop", () => {
  it("kills the wrapper and every child, and frees the port", async () => {
    const s = make();
    const r = await s.ensureStarted();
    const wrapper = s.pid as number;
    const [serverPid] = serverPids();
    expect(isAlive(wrapper)).toBe(true);
    expect(isAlive(serverPid)).toBe(true);
    await s.stop();
    expect(isAlive(wrapper)).toBe(false);
    expect(isAlive(serverPid)).toBe(false);
    expect(listenersOn(r.port)).toEqual([]);
    expect(s.current).toBeNull();
  });

  it("can start again after a stop", async () => {
    const s = make();
    const first = await s.ensureStarted();
    await s.stop();
    const second = await s.ensureStarted();
    expect(second.token).not.toBe(first.token);
    expect(await get(second.port, `/?tkn=${second.token}`)).toBe(302);
  });

  it("is a no-op when nothing was started", async () => {
    await expect(make().stop()).resolves.toBeUndefined();
  });

  it("a stop() that lands while the port is being picked cancels the start: nothing is spawned (PR-1 R3)", async () => {
    let releasePort!: (port: number) => void;
    const findPort = () => new Promise<number>((resolve) => (releasePort = resolve));
    const s = make({}, { findPort });
    const start = s.ensureStarted();
    const outcome = start.catch((e: unknown) => e);
    await vi.waitFor(() => expect(releasePort).toBeTypeOf("function"));
    await s.stop(); // before the spawn: there is no child yet
    releasePort(await freePort());
    expect(await outcome).toBeInstanceOf(StartCancelledError);
    expect(s.pid).toBeUndefined();
    expect(s.current).toBeNull();
    expect(serverPids()).toEqual([]); // the fake server writes its pid when it runs: it never ran
  });

  it("a stop() before a first start does not poison the next start", async () => {
    const s = make();
    await s.stop();
    const r = await s.ensureStarted();
    expect(await get(r.port, `/?tkn=${r.token}`)).toBe(302);
  });
});

describe("the stable port", () => {
  const picks: Array<{ port: number; usedStored: boolean; note: string | null }> = [];
  const track = (p: (typeof picks)[number]) => void picks.push(p);
  beforeEach(() => void (picks.length = 0));

  it("stored port free: the server listens on it, and again after a stop and a start", async () => {
    const stored = await freePort();
    const s = make({}, { storedPort: stored, onPortPick: track });
    const first = await s.ensureStarted();
    expect(first.port).toBe(stored);
    await s.stop();
    const second = await s.ensureStarted();
    expect(second.port).toBe(stored);
    expect(second.token).not.toBe(first.token);
    expect(picks).toEqual([
      { port: stored, usedStored: true, note: null },
      { port: stored, usedStored: true, note: null },
    ]);
  });

  it("stored port held by a running server of ours: the second server starts on a free port and says so", async () => {
    const stored = await freePort();
    const a = make({}, { storedPort: stored, onPortPick: track });
    expect((await a.ensureStarted()).port).toBe(stored);
    const b = new WorkbenchServer({
      build,
      runtimeDir: path.join(tempDir(), ".server"),
      acceptLicense: true,
      pollIntervalMs: 25,
      env: { FAKE_CODE_NODE: process.execPath, FAKE_CODE_PIDFILE: pidFile },
      storedPort: stored,
      onPortPick: track,
    });
    servers.push(b);
    const second = await b.ensureStarted();
    expect(second.port).not.toBe(stored);
    expect(picks[1].usedStored).toBe(false);
    expect(picks[1].note).toContain(`stored port ${stored} is not available: a VS Code server of this plugin already holds it`);
    expect(await get(stored, `/?tkn=${(a.current as { token: string }).token}`)).toBe(302); // the first server is untouched
  });

  it("stored port held by another process: the server still starts, on a free port, and the other process keeps its port", async () => {
    const other = net.createServer((sock) => sock.destroy());
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    const stored = (other.address() as net.AddressInfo).port;
    try {
      const s = make({}, { storedPort: stored, onPortPick: track });
      const r = await s.ensureStarted();
      expect(r.port).not.toBe(stored);
      expect(await get(r.port, `/?tkn=${r.token}`)).toBe(302);
      expect(picks[0].note).toContain(`stored port ${stored} is not available: another program is using it`);
      expect(other.listening).toBe(true);
    } finally {
      await new Promise<void>((r) => other.close(() => r()));
    }
  });

  it("no stored port: a free port is picked and reported with no note", async () => {
    const s = make({}, { onPortPick: track });
    const r = await s.ensureStarted();
    expect(picks).toEqual([{ port: r.port, usedStored: false, note: null }]);
  });
});

describe("failure", () => {
  it("early exit: error carries the exit code and last stderr lines, token excluded", async () => {
    const s = make({ FAKE_CODE_MODE: "exit-early" });
    const err = await s.ensureStarted().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerStartError);
    const e = err as ServerStartError;
    expect(e.exitCode).toBe(3);
    expect(e.message).toContain("exited with code 3");
    expect(e.message).toContain("address already in use");
    const token = fs.readFileSync(path.join(runtimeDir, "connection-token"), "utf8");
    expect(e.message).not.toContain(token);
    expect(e.stderrTail).not.toContain(token);
    expect(e.message).toContain("tkn=<redacted>");
  });

  it("times out when the server never becomes ready, with a Notice-ready message", async () => {
    const s = make({ FAKE_CODE_MODE: "hang" }, { readyTimeoutMs: 400 });
    const err = (await s.ensureStarted().catch((e: unknown) => e)) as ServerStartError;
    expect(err).toBeInstanceOf(ServerStartError);
    expect(err.message).toMatch(/not ready after/);
    // the hung child is cleaned up
    for (const pid of serverPids()) expect(isAlive(pid)).toBe(false);
  });

  it("reports a missing CLI without crashing", async () => {
    const s = new WorkbenchServer({ build: { ...build, cli: "/nonexistent/code" }, runtimeDir, acceptLicense: true });
    servers.push(s);
    const err = (await s.ensureStarted().catch((e: unknown) => e)) as ServerStartError;
    expect(err).toBeInstanceOf(ServerStartError);
    expect(err.message).toMatch(/Could not run VS Code/);
  });
});

describe("checkServeWebSupport (test-start with --help)", () => {
  it("accepts the fake serve-web", async () => {
    const s = await checkServeWebSupport(FAKE_CODE);
    expect(s).toEqual({ serveWeb: true, disableTelemetry: true, connectionTokenFile: true });
  });

  it("refuses a build without serve-web", async () => {
    process.env.FAKE_CODE_MODE = "no-serve-web";
    try {
      expect((await checkServeWebSupport(FAKE_CODE)).serveWeb).toBe(false);
    } finally {
      delete process.env.FAKE_CODE_MODE;
    }
  });

  it("refuses a CLI that does not exist", async () => {
    expect((await checkServeWebSupport("/nonexistent/code")).serveWeb).toBe(false);
  });
});

describe("the mirror read at server start (PR-4)", () => {
  const request = (t: ReturnType<typeof buildTree>): MirrorRequest => ({
    instanceId: "vscode-insiders:/Applications/Visual Studio Code.app",
    userDataRoot: t.userDataRoot,
    vaultPath: t.vault,
    profile: { location: "__default__profile__", isDefault: true, dir: path.join(t.userDataRoot, "User") },
  });

  it("reads the disabled lists before the child is spawned, from real databases, and records the answer", async () => {
    const t = buildTree({ base: tempDir(), global: ["--disabled", "g.one"], workspace: { dbArgs: ["--disabled", "w.one"] } });
    const order: string[] = [];
    const s = make({}, { mirror: request(t), onMirror: () => order.push(fs.existsSync(argsFile) ? "after-spawn" : "before-spawn"), onPortPick: () => order.push("port") });
    expect(s.mirror).toBeNull();
    await s.ensureStarted();
    expect(order).toEqual(["before-spawn", "port"]);
    expect(s.mirror).toMatchObject({ source: "read", disabled: ["g.one", "w.one"] });
    expect(fs.existsSync(path.join(s.serverDataDir, "mirror-snapshot.json"))).toBe(true);
  });

  it("reads once per start: a restart reads again, and a start reads once", async () => {
    const t = buildTree({ base: tempDir(), global: ["--disabled", "g.one"] });
    let reads = 0;
    const s = make({}, { mirror: request(t), onMirror: () => reads++ });
    await s.ensureStarted();
    await s.ensureStarted(); // already running: no new start, no new read
    expect(reads).toBe(1);
    await s.stop();
    const again = make({}, { mirror: request(t), onMirror: () => reads++ });
    await again.ensureStarted();
    expect(reads).toBe(2);
  });

  it("no mirror asked for: nothing is read and nothing is written", async () => {
    const s = make();
    await s.ensureStarted();
    expect(s.mirror).toBeNull();
    expect(fs.existsSync(path.join(s.serverDataDir, "mirror-snapshot.json"))).toBe(false);
  });

  it("desktop VS Code's files are byte-identical and unchanged in mtime after a start and a stop (F1)", async () => {
    const t = buildTree({ base: tempDir(), global: ["--wal", "--disabled", "g.one"], workspace: { dbArgs: ["--disabled", "w.one"] } });
    const root = path.join(t.base, "AppSupport");
    const home = path.join(t.base, "Home");
    const before = { root: snapshotTree(root), home: snapshotTree(home), vault: snapshotTree(t.vault) };
    const s = make({}, { mirror: request(t) });
    await s.ensureStarted();
    await s.stop();
    expect({ root: snapshotTree(root), home: snapshotTree(home), vault: snapshotTree(t.vault) }).toEqual(before);
    expect(s.mirror?.source).toBe("read");
    expect(fs.readdirSync(path.join(runtimeDir, "mirror-tmp"))).toEqual([]);
  });

  it("a database that cannot be read does not stop the server from starting: the answer is none, with why", async () => {
    const t = buildTree({ base: tempDir(), global: ["--corrupt"] });
    const s = make({}, { mirror: request(t) });
    const r = await s.ensureStarted();
    expect(await get(r.port, `/?tkn=${r.token}`)).toBe(302);
    expect(s.mirror).toMatchObject({ source: "none", disabled: [] });
    expect(s.mirror?.source === "none" && s.mirror.why).toContain("corrupt");
  });

  it("an unlocatable instance does not stop the start either", async () => {
    const s = make({}, { mirror: { unavailable: "no user-data folder" } });
    await s.ensureStarted();
    expect(s.mirror).toEqual({ source: "none", disabled: [], why: "desktop VS Code's state cannot be located (no user-data folder)" });
  });

  it("a second start uses the snapshot of the first when the second read fails", async () => {
    const t = buildTree({ base: tempDir(), global: ["--disabled", "g.one"] });
    const s = make({}, { mirror: request(t) });
    await s.ensureStarted();
    await s.stop();
    stateDb(t.globalDb, "--corrupt");
    const again = make({}, { mirror: request(t) });
    await again.ensureStarted();
    expect(again.mirror).toMatchObject({ source: "snapshot", disabled: ["g.one"] });
  });

  it("a listener that throws does not stop the start", async () => {
    const t = buildTree({ base: tempDir(), global: [] });
    const s = make({}, { mirror: request(t), onMirror: () => { throw new Error("listener"); } });
    await s.ensureStarted();
    expect(s.mirror?.source).toBe("read");
  });

  it("stop() during the read cancels the start, kills sqlite3 and leaves no temp copy, and no server process is spawned", async () => {
    const t = buildTree({ base: tempDir(), global: ["--disabled", "g.one"] });
    const mirrorDeps = { run: (_args: string[], o: { signal?: AbortSignal }) => new Promise<{ kind: "aborted" }>((resolve) => o.signal?.addEventListener("abort", () => resolve({ kind: "aborted" }))) };
    const s = make({}, { mirror: request(t), mirrorDeps });
    const starting = s.ensureStarted();
    const outcome = starting.then(() => "started", (e: unknown) => e);
    await vi.waitFor(() => expect(fs.existsSync(path.join(runtimeDir, "mirror-tmp")) && fs.readdirSync(path.join(runtimeDir, "mirror-tmp")).length).toBe(1));
    await s.stop();
    expect(await outcome).toBeInstanceOf(StartCancelledError);
    expect(fs.readdirSync(path.join(runtimeDir, "mirror-tmp"))).toEqual([]);
    expect(serverPids()).toEqual([]);
    expect(fs.existsSync(argsFile)).toBe(false);
    expect(s.mirror).toBeNull();
  });
});

describe("the shared extensions at server start (PR-5)", () => {
  const TCL = "chakrounanas.turbo-console-log-3.0.0";
  const PY = "ms-python.python-2026.10.0";
  const request = (t: ReturnType<typeof buildTree>): MirrorRequest => ({
    instanceId: "vscode-insiders:/Applications/Visual Studio Code.app",
    userDataRoot: t.userDataRoot,
    vaultPath: t.vault,
    profile: { location: "__default__profile__", isDefault: true, dir: path.join(t.userDataRoot, "User") },
  });
  const entry = (dir: string, id: string, folder: string) => ({ identifier: { id }, relativeLocation: folder, location: { $mid: 1, path: path.join(dir, folder), scheme: "file" } });
  const linksOf = (s: WorkbenchServer) => fs.readdirSync(path.join(s.serverDataDir, "extensions")).filter((n) => n !== "extensions.json").sort();

  it("the on-disk extensions folder holds exactly the enabled links, and the list is written before the child is spawned", async () => {
    const t = buildTree({ base: tempDir(), global: ["--disabled", "ms-python.python"] });
    const ext = path.join(t.base, "Home", ".vscode-insiders", "extensions");
    for (const n of [TCL, PY, "other.unlisted-1.0.0"]) fs.mkdirSync(path.join(ext, n), { recursive: true });
    const list = path.join(ext, "extensions.json");
    fs.writeFileSync(list, JSON.stringify([entry(ext, "chakrounanas.turbo-console-log", TCL), entry(ext, "ms-python.python", PY)]));
    const before = snapshotTree(ext);
    let seen: string[] | null = null;
    const s = make({}, { build: { ...build, extensionsDir: ext }, mirror: request(t), profileExtensionsFile: list, onPortPick: () => (seen = linksOf(s)) });
    await s.ensureStarted();
    expect(seen).toEqual([TCL]); // linked before the port was picked and the child spawned
    expect(linksOf(s)).toEqual([TCL]);
    expect(fs.lstatSync(path.join(s.serverDataDir, "extensions", TCL)).isSymbolicLink()).toBe(true);
    const written = JSON.parse(fs.readFileSync(path.join(s.serverDataDir, "extensions", "extensions.json"), "utf8")) as Array<{ relativeLocation: string; location: { path: string } }>;
    expect(written.map((e) => e.relativeLocation)).toEqual([TCL]);
    expect(written[0].location.path).toBe(path.join(s.serverDataDir, "extensions", TCL));
    expect(snapshotTree(ext)).toEqual(before);
  });

  it("nothing readable (no database, no snapshot): the server still starts, with no links and an empty list", async () => {
    const t = buildTree({ base: tempDir(), global: null });
    const ext = path.join(t.base, "Home", ".vscode-insiders", "extensions");
    fs.mkdirSync(path.join(ext, TCL), { recursive: true });
    const list = path.join(ext, "extensions.json");
    fs.writeFileSync(list, JSON.stringify([entry(ext, "chakrounanas.turbo-console-log", TCL)]));
    const s = make({}, { build: { ...build, extensionsDir: ext }, mirror: request(t), profileExtensionsFile: list });
    await s.ensureStarted();
    expect(s.mirror?.source).toBe("none");
    expect(linksOf(s)).toEqual([]);
    expect(fs.readFileSync(path.join(s.serverDataDir, "extensions", "extensions.json"), "utf8")).toBe("[]");
  });
});
