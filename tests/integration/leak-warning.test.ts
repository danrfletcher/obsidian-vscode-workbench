/**
 * Integration: the leak report at the end of a run (GP6). Real processes, real `ps`, the real wrapper (tests/fixtures/fake-code.sh)
 * and the real `teardown` of tests/global-setup.ts. Nothing here is stubbed except `console.log`, to read what the teardown prints.
 *
 *  - the teardown, called directly over a hand-written ledger that points at a live `sleep` this test owns;
 *  - the wrapper, started the way `WorkbenchServer` does (detached, piped stdio), and the one ledger line it writes;
 *  - nested `vitest run`s over throwaway tests (one leaks a fake, one stops it) whose output and exit code are read.
 *
 * Every process this file starts is ended in afterEach, by pid (`sleep`, the wrapper's group) or by its own unique temp dir on the
 * command line, so a failing test leaves nothing behind.
 */
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findFreePort, httpStatus } from "../../src/server";
import { FAKE_CODE, FIXTURES, REPO_ROOT, isAlive, tempDir } from "../helpers";
import { teardown } from "../global-setup";

const FAKE_SERVE_WEB = path.join(FIXTURES, "fake-serve-web.mjs");
const TOKEN = "l".repeat(64);
const isRoot = process.getuid?.() === 0;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, timeout: number, what: string, interval = 100): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return Date.now() - t0;
    if (Date.now() - t0 > timeout) throw new Error(`timed out after ${timeout} ms: ${what}`);
    await sleep(interval);
  }
}

/** `ps -o lstart=` for `pid`, white space collapsed; "" when it is not running. */
function lstart(pid: number): string {
  const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  return out.stdout.trim().replace(/\s+/g, " ");
}

/** The whole process table (pid, command). */
function table(): { pid: number; command: string }[] {
  const out = spawnSync("ps", ["-A", "-ww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const rows: { pid: number; command: string }[] = [];
  for (const l of out.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(l);
    if (m) rows.push({ pid: Number(m[1]), command: m[2] });
  }
  return rows;
}

const commandOf = (pid: number): string => spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();

/** Pids of every process whose command line has `needle` (a path unique to one test). */
const withPath = (needle: string): number[] => (needle ? table() : []).filter((r) => r.command.includes(needle) && r.pid !== process.pid).map((r) => r.pid);

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** Ends every process whose command line carries `needle`, then waits for them to go. Only paths unique to this test are passed. */
function endAllWith(needle: string): () => Promise<void> {
  return async () => {
    for (let round = 0; round < 5; round++) {
      const pids = withPath(needle);
      if (!pids.length) return;
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
      await sleep(100);
    }
  };
}

/** Runs the real teardown with FAKE_CODE_LEDGER = `ledger`, and returns what it printed. */
async function runTeardown(ledger: string | undefined): Promise<{ lines: string[]; ms: number }> {
  const saved = process.env.FAKE_CODE_LEDGER;
  if (ledger === undefined) delete process.env.FAKE_CODE_LEDGER;
  else process.env.FAKE_CODE_LEDGER = ledger;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const t0 = Date.now();
  try {
    await teardown();
    return { lines: log.mock.calls.map((c) => String(c[0])), ms: Date.now() - t0 };
  } finally {
    log.mockRestore();
    if (saved === undefined) delete process.env.FAKE_CODE_LEDGER;
    else process.env.FAKE_CODE_LEDGER = saved;
  }
}

/** A `sleep 30` this test owns. */
function startSleeper(): ChildProcess {
  const c = spawn("sleep", ["30"], { stdio: "ignore" });
  cleanups.push(() => {
    c.kill("SIGKILL");
  });
  return c;
}

describe("the run's own ledger (GP6: set by the global setup, before any test file)", () => {
  it("FAKE_CODE_LEDGER reaches this worker: a file under the run's lease folder named with the runner's pid", () => {
    const ledger = process.env.FAKE_CODE_LEDGER;
    const run = process.env.WORKBENCH_TEST_RUN;
    expect(run).toMatch(/^\d+$/);
    expect(ledger).toBeDefined();
    expect(path.basename(ledger!)).toBe(`${run}.ledger`);
    expect(path.dirname(ledger!)).toBe(path.join(os.tmpdir(), "vscode-workbench-test-runs"));
    // the runner is the vitest main process, not this worker
    expect(Number(run)).not.toBe(process.pid);
  });

  it("two runs have two ledgers: the teardown reads only the one its own environment names", async () => {
    const dir = tempDir();
    const mine = path.join(dir, "111.ledger");
    const theirs = path.join(dir, "222.ledger");
    const a = startSleeper();
    const b = startSleeper();
    await until(() => lstart(a.pid!) !== "" && lstart(b.pid!) !== "", 5000, "the sleepers are up");
    fs.writeFileSync(mine, `${a.pid}\t${lstart(a.pid!)}\t${dir}/mine\n`);
    fs.writeFileSync(theirs, `${b.pid}\t${lstart(b.pid!)}\t${dir}/theirs\n`);
    const { lines } = await runTeardown(mine);
    expect(lines).toEqual([`leaked server: pid ${a.pid} from ${dir}/mine`]);
    // the other run's ledger is untouched
    expect(fs.existsSync(theirs)).toBe(true);
  });
});

describe("teardown over a hand-written ledger (the real `ps`)", () => {
  it("prints the leak line for a live process, and the process is still alive afterwards (report only)", async () => {
    const dir = tempDir();
    const sleeper = startSleeper();
    const pid = sleeper.pid!;
    await until(() => lstart(pid) !== "", 5000, "sleep is up");
    const ledger = path.join(dir, "1.ledger");
    fs.writeFileSync(ledger, `${pid}\t${lstart(pid)}\t${dir}\n`);
    const before = process.exitCode;
    const { lines, ms } = await runTeardown(ledger);
    expect(lines).toEqual([`leaked server: pid ${pid} from ${dir}`]);
    // polled the full window before reporting
    expect(ms).toBeGreaterThanOrEqual(2900);
    expect(isAlive(pid)).toBe(true);
    expect(lstart(pid)).not.toBe("");
    expect(process.exitCode).toBe(before);
    // a clean teardown drops the run's ledger
    expect(fs.existsSync(ledger)).toBe(false);
  });

  it("prints a directory with spaces and unicode whole and unchanged", async () => {
    const dir = path.join(tempDir(), "my dir é世界 ✓");
    fs.mkdirSync(dir);
    const sleeper = startSleeper();
    await until(() => lstart(sleeper.pid!) !== "", 5000, "sleep is up");
    const ledger = path.join(dir, "1.ledger");
    fs.writeFileSync(ledger, `${sleeper.pid}\t${lstart(sleeper.pid!)}\t${dir}\n`);
    expect((await runTeardown(ledger)).lines).toEqual([`leaked server: pid ${sleeper.pid} from ${dir}`]);
  });

  it("a process that has exited, one whose pid shows another start time, and a zombie are not reported, and the clean case is fast", async () => {
    const dir = tempDir();
    const gone = spawnSync("true");
    const reused = startSleeper();
    await until(() => lstart(reused.pid!) !== "", 5000, "sleep is up");
    // a zombie: an exited child whose parent (a `sleep` after exec) never waits for it
    const zombieParent = spawn("sh", ["-c", "sh -c 'exit 0' & echo $!; exec sleep 30"], { stdio: ["ignore", "pipe", "ignore"] });
    cleanups.push(() => {
      zombieParent.kill("SIGKILL");
    });
    const zombiePid = await new Promise<number>((resolve) => zombieParent.stdout!.once("data", (d: Buffer) => resolve(Number(d.toString().trim()))));
    const zombieStart = lstart(zombiePid);
    // wait until it is a zombie (its state starts with Z)
    await until(() => spawnSync("ps", ["-o", "stat=", "-p", String(zombiePid)], { encoding: "utf8" }).stdout.trim().startsWith("Z"), 5000, "the child is a zombie");
    expect(isAlive(zombiePid)).toBe(true); // `kill -0` still says yes: only the state tells
    const ledger = path.join(dir, "1.ledger");
    fs.writeFileSync(
      ledger,
      [`${gone.pid}\tThu Nov 19 18:36:02 2026\t${dir}/gone`, `${reused.pid}\tMon Jan  1 00:00:00 2001\t${dir}/reused`, `${zombiePid}\t${zombieStart}\t${dir}/zombie`].join("\n") + "\n",
    );
    const { lines, ms } = await runTeardown(ledger);
    expect(lines).toEqual([]);
    expect(ms).toBeLessThan(1000);
  });

  it("an empty ledger and a ledger of 700 lines of dead pids print nothing and finish well under the poll window", async () => {
    const dir = tempDir();
    const ledger = path.join(dir, "1.ledger");
    fs.writeFileSync(ledger, "");
    expect((await runTeardown(ledger)).lines).toEqual([]);
    fs.writeFileSync(ledger, Array.from({ length: 700 }, (_, i) => `${90000 + (i % 9000)}\tThu Nov 19 18:36:02 2026\t${dir}/${i}`).join("\n") + "\n");
    const { lines, ms } = await runTeardown(ledger);
    expect(lines).toEqual([]);
    expect(ms).toBeLessThan(2000);
  });

  it("700 lines with one live leak: one line, and the teardown finishes inside the window plus a little", async () => {
    const dir = tempDir();
    const sleeper = startSleeper();
    await until(() => lstart(sleeper.pid!) !== "", 5000, "sleep is up");
    const lines700 = Array.from({ length: 699 }, (_, i) => `${95000 + (i % 4000)}\tThu Nov 19 18:36:02 2026\t${dir}/${i}`);
    lines700.splice(350, 0, `${sleeper.pid}\t${lstart(sleeper.pid!)}\t${dir}/live`);
    const ledger = path.join(dir, "1.ledger");
    fs.writeFileSync(ledger, lines700.join("\n") + "\n");
    const { lines, ms } = await runTeardown(ledger);
    expect(lines).toEqual([`leaked server: pid ${sleeper.pid} from ${dir}/live`]);
    expect(ms).toBeLessThan(4500);
  });

  it("a fake that is alive at first and gone within the window is not reported, and the poll returns as soon as it is gone", async () => {
    const dir = tempDir();
    const sleeper = startSleeper();
    await until(() => lstart(sleeper.pid!) !== "", 5000, "sleep is up");
    const ledger = path.join(dir, "1.ledger");
    fs.writeFileSync(ledger, `${sleeper.pid}\t${lstart(sleeper.pid!)}\t${dir}\n`);
    setTimeout(() => sleeper.kill("SIGKILL"), 800);
    const { lines, ms } = await runTeardown(ledger);
    expect(lines).toEqual([]);
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(ms).toBeLessThan(2000);
  });

  it("unset, missing, a directory, an unreadable file: prints nothing, throws nothing", async () => {
    const dir = tempDir();
    const asDir = path.join(dir, "a-directory.ledger");
    fs.mkdirSync(asDir);
    expect((await runTeardown(undefined)).lines).toEqual([]);
    expect((await runTeardown(path.join(dir, "missing.ledger"))).lines).toEqual([]);
    expect((await runTeardown(asDir)).lines).toEqual([]);
    expect(fs.existsSync(asDir)).toBe(true); // a directory under a ledger's name is not removed
    if (!isRoot) {
      const sleeper = startSleeper();
      await until(() => lstart(sleeper.pid!) !== "", 5000, "sleep is up");
      const unreadable = path.join(dir, "unreadable.ledger");
      fs.writeFileSync(unreadable, `${sleeper.pid}\t${lstart(sleeper.pid!)}\t${dir}\n`);
      fs.chmodSync(unreadable, 0o000);
      const { lines, ms } = await runTeardown(unreadable);
      expect(lines).toEqual([]);
      expect(ms).toBeLessThan(1000);
    }
  });

  it("malformed lines are skipped and the well-formed lines in the same file are still checked", async () => {
    const dir = tempDir();
    const sleeper = startSleeper();
    await until(() => lstart(sleeper.pid!) !== "", 5000, "sleep is up");
    const ledger = path.join(dir, "1.ledger");
    fs.writeFileSync(ledger, `\n123\nabc\tThu Nov 19 18:36:02 2026\t${dir}\n${sleeper.pid}\t${lstart(sleeper.pid!)}\t${dir}/good\n${sleeper.pid}\t${lstart(sleeper.pid!)}\t${dir}/trunc`);
    expect((await runTeardown(ledger)).lines).toEqual([`leaked server: pid ${sleeper.pid} from ${dir}/good`]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// The wrapper, started the way WorkbenchServer starts it.
// ---------------------------------------------------------------------------------------------------------------------------

interface Wrapper {
  child: ChildProcess;
  pid: number;
  dir: string;
  port: number;
  /** FAKE_CODE_PIDFILE: the node server's pid on its first line. */
  pidfile: string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

interface WrapperOptions {
  dir?: string;
  wrapperPath?: string;
  /** Keys set to undefined are removed from the environment. */
  env?: Record<string, string | undefined>;
  /** Path of the token file, relative to `dir` (default: connection-token). */
  tokenPath?: string;
}

/** Spawns the wrapper like server.ts: detached (own group), stdio [ignore, pipe, pipe] drained, env {...process.env, ...extra}. */
async function startWrapper(opts: WrapperOptions = {}): Promise<Wrapper> {
  const dir = opts.dir ?? tempDir();
  const tokenFile = path.join(dir, opts.tokenPath ?? "connection-token");
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
  const port = await findFreePort();
  const pidfile = path.join(dir, "server-pids");
  const env: Record<string, string | undefined> = { ...process.env, FAKE_CODE_NODE: process.execPath, FAKE_CODE_PIDFILE: pidfile, FAKE_CODE_MAX_LIFETIME_S: "120", ...opts.env };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const child = spawn(opts.wrapperPath ?? FAKE_CODE, ["serve-web", "--host", "127.0.0.1", "--port", String(port), "--connection-token-file", tokenFile], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: env as NodeJS.ProcessEnv,
  });
  child.stdout!.on("data", () => {});
  child.stderr!.on("data", () => {});
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const pid = child.pid!;
  cleanups.push(async () => {
    // the wrapper leads its own group: the server and the watchdog are in it
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* gone */
    }
    await endAllWith(dir)();
  });
  await until(async () => (await httpStatus(port, TOKEN)) === 302, 15_000, "the fake server answers", 50);
  return { child, pid, dir, port, pidfile, exit };
}

const serverPidOf = (w: Wrapper): number => Number(fs.readFileSync(w.pidfile, "utf8").trim().split("\n")[0]);

/** Lines of a ledger file, without the empty tail. */
const ledgerLines = (file: string): string[] => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : []);

describe("fake-code.sh writes the ledger (GP6)", () => {
  it("appends exactly one line per serve-web start: the node server's pid, its start time and the temp dir, tab-separated; `serve-web --help` adds none", async () => {
    const dir = tempDir();
    const ledger = path.join(dir, "1.ledger");
    const help = () => spawnSync(FAKE_CODE, ["serve-web", "--help"], { encoding: "utf8", env: { ...process.env, FAKE_CODE_NODE: process.execPath, FAKE_CODE_LEDGER: ledger } });
    expect(help().status).toBe(0);
    expect(fs.existsSync(ledger)).toBe(false);

    const w = await startWrapper({ dir, env: { FAKE_CODE_LEDGER: ledger } });
    const server = serverPidOf(w);
    expect(commandOf(server)).toContain("fake-serve-web.mjs");
    const lines = ledgerLines(ledger);
    expect(lines).toHaveLength(1);
    expect(fs.readFileSync(ledger, "utf8").endsWith("\n")).toBe(true);
    const fields = lines[0].split("\t");
    expect(fields).toHaveLength(3);
    expect(Number(fields[0])).toBe(server);
    expect(fields[1]).toBe(lstart(server));
    expect(fields[1]).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
    expect(fields[2]).toBe(dir);

    // --help again, with the server running: still one line
    expect(help().status).toBe(0);
    expect(ledgerLines(ledger)).toEqual(lines);
  });

  it("names the marked temp dir even when the token file is in a folder under it, and the token file's folder when no dir is marked", async () => {
    const root = tempDir();
    const ledger = path.join(root, "1.ledger");
    const nested = await startWrapper({ dir: root, tokenPath: path.join("deep", "er", "connection-token"), env: { FAKE_CODE_LEDGER: ledger } });
    expect(ledgerLines(ledger).map((l) => l.split("\t")[2])).toEqual([root]);
    expect(nested.pid).toBeGreaterThan(1);

    // a dir with no runner pid in its name (the setup did not run): the token file's own folder
    const plain = path.join(os.tmpdir(), `leak-warning-plain-${process.pid}-${Date.now()}`);
    fs.mkdirSync(plain);
    cleanups.push(async () => {
      await endAllWith(plain)();
      fs.rmSync(plain, { recursive: true, force: true });
    });
    const ledger2 = path.join(root, "2.ledger");
    await startWrapper({ dir: plain, env: { FAKE_CODE_LEDGER: ledger2 } });
    expect(ledgerLines(ledger2).map((l) => l.split("\t")[2])).toEqual([plain]);
  });

  it("many fakes started together write one whole line each, none interleaved", async () => {
    const dir = tempDir();
    const ledger = path.join(dir, "1.ledger");
    const wrappers = await Promise.all(Array.from({ length: 8 }, (_, i) => startWrapper({ dir: path.join(dir, `fake-${i}`), env: { FAKE_CODE_LEDGER: ledger } })));
    const servers = wrappers.map(serverPidOf).sort((a, b) => a - b);
    const lines = ledgerLines(ledger);
    expect(lines).toHaveLength(8);
    for (const l of lines) expect(l.split("\t")).toHaveLength(3);
    expect(lines.map((l) => Number(l.split("\t")[0])).sort((a, b) => a - b)).toEqual(servers);
    // each token file is in a folder under the one marked temp dir, which is the dir the ledger names
    expect(lines.map((l) => l.split("\t")[2])).toEqual(Array(8).fill(dir));
    expect(wrappers.map((w) => path.dirname(w.dir))).toEqual(Array(8).fill(dir));
  });

  it("with FAKE_CODE_LEDGER unset the wrapper writes nothing: the copy in a temp app dir, with no ledger in its environment", async () => {
    const app = tempDir();
    fs.copyFileSync(FAKE_CODE, path.join(app, "fake-code.sh"));
    fs.chmodSync(path.join(app, "fake-code.sh"), 0o755);
    fs.copyFileSync(FAKE_SERVE_WEB, path.join(app, "fake-serve-web.mjs"));
    const dir = path.join(app, "run");
    const before = fs.readdirSync(app).sort();
    const w = await startWrapper({ dir, wrapperPath: path.join(app, "fake-code.sh"), env: { FAKE_CODE_LEDGER: undefined } });
    expect(isAlive(serverPidOf(w))).toBe(true);
    // nothing new in the app dir but the run's own folder, and no ledger file anywhere in it
    expect(fs.readdirSync(app).sort()).toEqual([...before, "run"].sort());
    const all = fs.readdirSync(dir, { recursive: true }).map(String);
    expect(all.filter((f) => /ledger/i.test(f))).toEqual([]);
  });

  it("an empty FAKE_CODE_LEDGER writes nothing either", async () => {
    const dir = tempDir();
    const w = await startWrapper({ dir, env: { FAKE_CODE_LEDGER: "" } });
    expect(isAlive(serverPidOf(w))).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => /ledger/i.test(f))).toEqual([]);
  });

  /** Ends the server with SIGTERM and returns how the wrapper ended. */
  async function endedWith(w: Wrapper) {
    process.kill(serverPidOf(w), "SIGTERM");
    return Promise.race([w.exit, sleep(20_000).then(() => "the wrapper did not exit" as const)]);
  }

  it("a ledger that cannot be written (missing folder, a directory, a file with mode 000) does not stop the fake, and the wrapper exits as it does without a ledger", async () => {
    const base = tempDir();
    const baseline = await endedWith(await startWrapper({ dir: path.join(base, "baseline"), env: { FAKE_CODE_LEDGER: undefined } }));
    expect(baseline).not.toBe("the wrapper did not exit");

    const asDir = path.join(base, "ledger-dir");
    fs.mkdirSync(asDir);
    const noWrite = path.join(base, "nowrite.ledger");
    fs.writeFileSync(noWrite, "");
    fs.chmodSync(noWrite, isRoot ? 0o600 : 0o000);
    const bad = [path.join(base, "no-such-folder", "x.ledger"), asDir, ...(isRoot ? [] : [noWrite])];
    for (const [i, ledger] of bad.entries()) {
      const w = await startWrapper({ dir: path.join(base, `bad-${i}`), env: { FAKE_CODE_LEDGER: ledger } });
      // it started (startWrapper waited for the server to answer), and nothing was written
      expect(isAlive(serverPidOf(w))).toBe(true);
      expect(await endedWith(w)).toEqual(baseline);
    }
    expect(fs.statSync(asDir).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(base, "no-such-folder"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Nested `vitest run`s.
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * A throwaway "test process" that outlives the nested run: it starts the wrapper detached and stays up (at most 90 s), so the
 * fake's owner is alive past the teardown, which is what makes the fake a leak the watchdog does not end first.
 */
const OWNER_JS = `
import { spawn } from "node:child_process";
import fs from "node:fs";
const [out, bin, ...args] = process.argv.slice(2);
const child = spawn(bin, args, { detached: true, stdio: "ignore", env: process.env });
child.unref();
fs.writeFileSync(out, JSON.stringify({ owner: process.pid, wrapper: child.pid }));
setTimeout(() => process.exit(0), 90_000);
`;

interface NestedOptions {
  /** The throwaway test stops its fake before it ends. */
  stops?: boolean;
  /** A second throwaway test fails. */
  fails?: boolean;
  /** The ledger exists with mode 000 before the run, so it can be neither written nor read. */
  unreadableLedger?: boolean;
}

interface NestedResult {
  code: number | null;
  stdout: string;
  stderr: string;
  root: string;
  info: { dir: string; owner: number; wrapper: number; server: number };
  leakLines: string[];
}

let nestedCount = 0;

/** Writes a throwaway config, global setup and test under a temp dir and runs `vitest run` over them in a child process. */
async function nestedRun(opts: NestedOptions): Promise<NestedResult> {
  // Not a marked dir: the fake's own dir, inside it, is the one that names the run.
  const root = path.join(os.tmpdir(), `leak-warning-nested-${process.pid}-${Date.now()}-${nestedCount++}`);
  fs.mkdirSync(root);
  cleanups.push(async () => {
    await endAllWith(root)();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const port = await findFreePort();
  const toUrl = (p: string) => JSON.stringify(pathToFileURL(p).href);
  fs.writeFileSync(path.join(root, "owner.mjs"), OWNER_JS);
  // The setup names the run and its ledger like tests/global-setup.ts does (without its sweep, which acts on other runs' leftovers),
  // and exports the real teardown.
  fs.writeFileSync(
    path.join(root, "setup.mjs"),
    `import fs from "node:fs";
import path from "node:path";
export { teardown } from ${toUrl(path.join(REPO_ROOT, "tests", "global-setup.ts"))};
export function setup() {
  process.env.WORKBENCH_TEST_RUN = String(process.pid);
  const ledger = path.join(${JSON.stringify(root)}, process.pid + ".ledger");
  process.env.FAKE_CODE_LEDGER = ledger;
  ${opts.unreadableLedger ? `fs.writeFileSync(ledger, "", { mode: 0 });` : ""}
}
`,
  );
  fs.writeFileSync(
    path.join(root, "vitest.config.mjs"),
    `export default { root: ${JSON.stringify(root)}, test: { globals: true, include: ["*.probe.mjs"], globalSetup: [${JSON.stringify(path.join(root, "setup.mjs"))}], testTimeout: 60000, hookTimeout: 60000 } };\n`,
  );
  const infoFile = path.join(root, "info.json");
  fs.writeFileSync(
    path.join(root, "leak.probe.mjs"),
    `import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const root = ${JSON.stringify(root)};
test("starts a fake server", async () => {
  const dir = path.join(root, "vscode-workbench-test-" + process.env.WORKBENCH_TEST_RUN + "-" + Date.now());
  fs.mkdirSync(dir);
  const token = path.join(dir, "connection-token");
  fs.writeFileSync(token, ${JSON.stringify(TOKEN)});
  const ownerFile = path.join(dir, "owner.json");
  const owner = spawn(process.execPath, [path.join(root, "owner.mjs"), ownerFile, ${JSON.stringify(FAKE_CODE)}, "serve-web", "--host", "127.0.0.1", "--port", ${JSON.stringify(String(port))}, "--connection-token-file", token], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, FAKE_CODE_NODE: process.execPath, FAKE_CODE_MAX_LIFETIME_S: "120", FAKE_CODE_PIDFILE: path.join(dir, "server-pids") },
  });
  owner.unref();
  const ledger = process.env.FAKE_CODE_LEDGER;
  const pidfile = path.join(dir, "server-pids");
  let server = 0;
  for (let i = 0; i < 300 && !server; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      server = Number(fs.readFileSync(pidfile, "utf8").trim().split("\\n")[0]) || 0;
    } catch {}
  }
  // the wrapper writes its ledger line right after it starts the server; wait for it (an unreadable ledger has none to wait for)
  for (let i = 0; i < 100 && !${JSON.stringify(Boolean(opts.unreadableLedger))}; i++) {
    try { if (fs.readFileSync(ledger, "utf8").includes(dir)) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const { owner: ownerPid, wrapper } = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
  fs.writeFileSync(${JSON.stringify(infoFile)}, JSON.stringify({ dir, owner: ownerPid, wrapper, server }));
  expect(server).toBeGreaterThan(1);
  ${
    opts.stops
      ? `// this test stops its server: the wrapper's whole group and the owner
  process.kill(-wrapper, "SIGKILL");
  process.kill(ownerPid, "SIGKILL");
  for (let i = 0; i < 100; i++) {
    try { process.kill(server, 0); } catch { return; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the server did not stop");`
      : `// this test never stops its server; its owner stays up past the teardown`
  }
});
${opts.fails ? `test("fails", () => { expect(1).toBe(2); });\n` : ""}`,
  );
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(VITEST|VITE_|FAKE_CODE_|WORKBENCH_TEST_RUN)/.test(k)) env[k] = v;
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--config", path.join(root, "vitest.config.mjs"), "--root", root],
      { cwd: root, env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
  const info = fs.existsSync(infoFile) ? JSON.parse(fs.readFileSync(infoFile, "utf8")) : { dir: "", owner: 0, wrapper: 0, server: 0 };
  return { ...result, root, info, leakLines: result.stdout.split("\n").filter((l) => l.startsWith("leaked server:")) };
}

describe("a nested `vitest run` over throwaway tests (GP6 end to end)", () => {
  it("a test that starts a fake and never stops it, with its owner alive past the teardown: exactly one leak line naming that fake's temp dir, exit 0", async () => {
    const r = await nestedRun({});
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.info.server).toBeGreaterThan(1);
    expect(r.leakLines).toEqual([`leaked server: pid ${r.info.server} from ${r.info.dir}`]);
    expect(r.info.dir).toMatch(/\/vscode-workbench-test-\d+-\d+$/);
    expect(r.stdout).toMatch(/1 passed/);
    // report only: the fake is still alive when the run has ended
    expect(isAlive(r.info.server)).toBe(true);
    expect(isAlive(r.info.owner)).toBe(true);
    // and the run's own ledger is gone
    expect(fs.readdirSync(r.root).filter((f) => f.endsWith(".ledger"))).toEqual([]);
  }, 90_000);

  it("the same run with a test that stops its server prints no leak line, and exits 0", async () => {
    const r = await nestedRun({ stops: true });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.info.server).toBeGreaterThan(1);
    expect(r.leakLines).toEqual([]);
    expect(r.stdout).not.toContain("leaked server");
    expect(r.stderr).not.toContain("leaked server");
    expect(withPath(r.info.dir)).toEqual([]);
  }, 90_000);

  it("after a run with a failing test the report still prints and the exit code is the failure's, not changed by the report", async () => {
    const withLeak = await nestedRun({ fails: true });
    const without = await nestedRun({ fails: true, stops: true });
    expect(without.code).toBe(1);
    expect(without.leakLines).toEqual([]);
    expect(withLeak.code).toBe(without.code);
    expect(withLeak.leakLines).toEqual([`leaked server: pid ${withLeak.info.server} from ${withLeak.info.dir}`]);
    expect(withLeak.stdout).toMatch(/1 failed/);
  }, 180_000);

  it.skipIf(isRoot)("with the ledger made unreadable the run prints nothing and exits 0", async () => {
    const r = await nestedRun({ unreadableLedger: true });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.leakLines).toEqual([]);
  }, 90_000);
});

describe("a server left behind by a test", () => {
  it("one left alive with only its wrapper ended (as the deliberate-orphan tests leave one) is named by the teardown and not ended", async () => {
    // The three deliberate-orphan files (orphan-sweep, server-lifecycle, terminal-quit) pass unchanged in the full run. What this
    // adds is what happens to a server one of them leaves alive after its own cleanup: it is named, and it is not touched.
    const dir = tempDir();
    const w = await startWrapper({ dir, env: { FAKE_CODE_LEDGER: path.join(dir, "1.ledger") } });
    const server = serverPidOf(w);
    // orphan it the way those tests do: end the wrapper alone, its watchdog goes with it, the server stays
    process.kill(w.pid, "SIGKILL");
    await w.exit;
    await sleep(300);
    expect(isAlive(server)).toBe(true);
    const { lines } = await runTeardown(path.join(dir, "1.ledger"));
    expect(lines).toEqual([`leaked server: pid ${server} from ${dir}`]);
    expect(isAlive(server)).toBe(true);
  }, 30_000);
});
