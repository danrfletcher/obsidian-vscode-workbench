/**
 * The one module that owns the `code serve-web` child process: locating a VS Code
 * build, the argument list, the mode-0600 token file, readiness, and stop.
 * (Do not split this across PRs: start and stop belong together.)
 *
 * Rules this file enforces:
 *  - bound to 127.0.0.1 only (F4);
 *  - the connection token is passed through --connection-token-file, never an
 *    argument, and is never logged, shown in a Notice or written to data.json;
 *  - telemetry is switched off when the build supports it (F5).
 */
import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

/**
 * SPIKE ONLY. The server licence flag is accepted by a hard-coded dev constant.
 * PR-2 replaces this with the licence modal; nothing is downloaded from
 * Microsoft in the shipped plugin until Dan has accepted the terms.
 */
export const DEV_ACCEPT_SERVER_LICENSE = true;

export const LOOPBACK_HOST = "127.0.0.1";
export const READY_TIMEOUT_MS = 30_000;
/** Once the server answers "still downloading" (HTTP 202) we wait this long in total. */
export const DOWNLOAD_TIMEOUT_MS = 300_000;
export const STDERR_TAIL_LINES = 10;
const COMMIT_RE = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export interface ServeWebArgsOptions {
  port: number;
  tokenFile: string;
  serverDataDir: string;
  cliDataDir: string;
  /** Pass --accept-server-license-terms. Only true after the licence flag is set. */
  acceptLicense: boolean;
  /** Pass --disable-telemetry (default true; false only if the build lacks it). */
  disableTelemetry?: boolean;
  /**
   * The installed build's commit. Passed as --commit-id so serve-web uses (and, the
   * first time only, downloads) the server for that commit. Without it the CLI asks
   * update.code.visualstudio.com for the latest server on every start (F5).
   */
  commitId?: string | null;
}

/** Build the `serve-web` argument list. The token itself never appears here. */
export function buildServeWebArgs(o: ServeWebArgsOptions): string[] {
  const args = [
    "serve-web",
    "--host",
    LOOPBACK_HOST,
    "--port",
    String(o.port),
    "--connection-token-file",
    o.tokenFile,
    "--server-data-dir",
    o.serverDataDir,
    "--cli-data-dir",
    o.cliDataDir,
  ];
  if (o.disableTelemetry !== false) args.push("--disable-telemetry");
  if (o.commitId && COMMIT_RE.test(o.commitId)) args.push("--commit-id", o.commitId);
  if (o.acceptLicense) args.push("--accept-server-license-terms");
  return args;
}

// ---------------------------------------------------------------------------
// Token file
// ---------------------------------------------------------------------------

/**
 * Create a fresh connection-token file (mode 0600) and return the token.
 * Any previous file is removed first so the token is regenerated on each start
 * and the mode is applied to a brand-new file.
 */
export function createTokenFile(filePath: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.rmSync(filePath, { force: true });
  const token = randomBytes(32).toString("hex");
  const fd = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeSync(fd, token);
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  return token;
}

/** Remove the token (and any `tkn=` query value) from text bound for a Notice or log. */
export function redactToken(text: string, token: string | null): string {
  let out = text.replace(/tkn=[^\s&"']+/g, "tkn=<redacted>");
  if (token) out = out.split(token).join("<redacted>");
  return out;
}

// ---------------------------------------------------------------------------
// Locating a VS Code build
// ---------------------------------------------------------------------------

export interface CodeBuild {
  cli: string;
  version: number[];
  versionText: string;
  /** e.g. ~/.vscode-insiders/extensions, from the build's product.json dataFolderName. */
  extensionsDir: string | null;
  /** The build's commit from product.json (40 hex chars), when it has one. */
  commit?: string | null;
}

export function parseVersion(text: string): number[] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function macCandidates(home: string): string[] {
  const apps = ["Visual Studio Code.app", "Visual Studio Code - Insiders.app"];
  const roots = ["/Applications", path.join(home, "Applications")];
  return roots.flatMap((r) => apps.map((a) => path.join(r, a, "Contents/Resources/app/bin/code")));
}

const LINUX_CANDIDATES = ["/usr/bin/code", "/usr/local/bin/code", "/usr/share/code/bin/code", "/opt/visual-studio-code/bin/code"];

function readBuild(cli: string, home: string): CodeBuild | null {
  let real: string;
  try {
    real = fs.realpathSync(cli);
  } catch {
    return null;
  }
  // .../app/bin/code  or  .../resources/app/bin/code
  const productJson = path.join(path.dirname(path.dirname(real)), "product.json");
  const altProductJson = path.join(path.dirname(path.dirname(real)), "resources/app/product.json");
  const file = [productJson, altProductJson].find((p) => fs.existsSync(p));
  let versionText = "0.0.0";
  let dataFolderName: string | null = null;
  let commit: string | null = null;
  if (file) {
    try {
      const product = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: string; dataFolderName?: string; commit?: string };
      versionText = product.version ?? versionText;
      dataFolderName = product.dataFolderName ?? null;
      commit = typeof product.commit === "string" && COMMIT_RE.test(product.commit) ? product.commit : null;
    } catch {
      /* unreadable product.json: treat as version 0 */
    }
  }
  return {
    cli: real,
    version: parseVersion(versionText),
    versionText,
    extensionsDir: dataFolderName ? path.join(home, dataFolderName, "extensions") : null,
    commit,
  };
}

/**
 * Find the newest installed VS Code build. `override` (a hand-edited
 * `codeCliPath` in data.json) wins when it exists.
 */
export function findNewestBuild(opts: { override?: string; home?: string; candidates?: string[] } = {}): CodeBuild | null {
  const home = opts.home ?? os.homedir();
  if (opts.override) return readBuild(opts.override, home);
  const candidates = opts.candidates ?? [...macCandidates(home), ...LINUX_CANDIDATES];
  const builds = candidates.map((c) => readBuild(c, home)).filter((b): b is CodeBuild => b !== null);
  builds.sort((a, b) => compareVersions(b.version, a.version));
  return builds[0] ?? null;
}

// ---------------------------------------------------------------------------
// serve-web support check
// ---------------------------------------------------------------------------

export interface ServeWebSupport {
  serveWeb: boolean;
  disableTelemetry: boolean;
  connectionTokenFile: boolean;
}

/** Interpret the output of `code serve-web --help`. */
export function parseServeWebHelp(exitCode: number | null, output: string): ServeWebSupport {
  const ok = exitCode === 0 && /serve-web/i.test(output);
  return {
    serveWeb: ok && output.includes("--connection-token-file"),
    disableTelemetry: ok && output.includes("--disable-telemetry"),
    connectionTokenFile: ok && output.includes("--connection-token-file"),
  };
}

/** Test-start the build with `serve-web --help`. */
export function checkServeWebSupport(cli: string, timeoutMs = 10_000): Promise<ServeWebSupport> {
  return new Promise((resolve) => {
    execFile(cli, ["serve-web", "--help"], { timeout: timeoutMs }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === "number" ? ((err as NodeJS.ErrnoException).code as unknown as number) : 1) : 0;
      resolve(parseServeWebHelp(code, `${stdout}\n${stderr}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Extension sharing
// ---------------------------------------------------------------------------

/**
 * Rewrite a real extensions.json so that nothing in it points into the instance's
 * own extensions folder. Each entry carries an absolute `location` (for example
 * `/Users/me/.vscode/extensions/ms-python.python-1.0`); if the server resolved an
 * extension through it, an uninstall or update in the embed would act on the
 * instance's real folder (F3). Every `location` is moved to the same-named
 * symlink under `targetDir`. `relativeLocation` stays as it is. Text that is not a
 * JSON array yields an empty list: the file is never copied through unchanged.
 */
export function rewriteExtensionsJson(raw: string, targetDir: string): string {
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    return "[]";
  }
  if (!Array.isArray(entries)) return "[]";
  const out = entries
    .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
    .map((e) => {
      const loc = e.location;
      const locPath = typeof loc === "object" && loc !== null ? (loc as { path?: unknown }).path : typeof loc === "string" ? loc : undefined;
      const rel = typeof e.relativeLocation === "string" ? e.relativeLocation : typeof locPath === "string" ? path.posix.basename(locPath) : undefined;
      if (loc === undefined || !rel) return e;
      const moved = path.join(targetDir, rel);
      return { ...e, location: typeof loc === "object" && loc !== null ? { ...(loc as object), path: moved, fsPath: undefined, external: undefined } : moved };
    });
  return JSON.stringify(out);
}

/**
 * Make the chosen build's installed extensions visible to the server without
 * touching that build's folder (F3): each extension directory is symlinked into
 * the plugin-owned server data dir, and extensions.json is rewritten (see
 * rewriteExtensionsJson) rather than copied or linked.
 * serve-web has no --extensions-dir flag, so this is how sharing is done.
 */
export function shareExtensions(sourceDir: string | null, serverDataDir: string): { linked: number } {
  const target = path.join(serverDataDir, "extensions");
  fs.mkdirSync(target, { recursive: true });
  if (!sourceDir || !fs.existsSync(sourceDir)) return { linked: 0 };
  // Drop links from a previous run so removed extensions disappear.
  for (const name of fs.readdirSync(target)) {
    const p = path.join(target, name);
    if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); // unlink the link itself, never the instance's folder
  }
  let linked = 0;
  for (const name of fs.readdirSync(sourceDir)) {
    const src = path.join(sourceDir, name);
    const dst = path.join(target, name);
    if (name === "extensions.json") {
      fs.writeFileSync(dst, rewriteExtensionsJson(fs.readFileSync(src, "utf8"), target));
    } else if (name.startsWith(".")) {
      continue;
    } else if (fs.statSync(src).isDirectory()) {
      if (!fs.existsSync(dst)) fs.symlinkSync(src, dst, "dir");
      linked++;
    }
  }
  return { linked };
}

// ---------------------------------------------------------------------------
// Ports and process helpers
// ---------------------------------------------------------------------------

/** Ask the OS for a free loopback port. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, LOOPBACK_HOST, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

/** Parse `ps -A -o pid=,ppid=` output into all descendant pids of `rootPid`. */
export function descendantsFromPs(psOutput: string, rootPid: number): number[] {
  const children = new Map<number, number[]>();
  for (const line of psOutput.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || Number.isNaN(ppid)) continue;
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const out: number[] = [];
  const queue = [rootPid];
  while (queue.length) {
    for (const c of children.get(queue.shift() as number) ?? []) {
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

/**
 * All descendant pids of `rootPid` (the `code` wrapper forks several layers and
 * some leave the process group). Synchronous so stop() can collect them before
 * the parent dies and its children are re-parented.
 */
export function listDescendants(rootPid: number): number[] {
  try {
    return descendantsFromPs(execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }), rootPid);
  } catch {
    return [];
  }
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    /* already gone */
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function httpStatus(port: number, token: string, timeoutMs = 2000): Promise<number | null> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: LOOPBACK_HOST, port, path: `/?tkn=${token}`, timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? null);
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export class ServerStartError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderrTail: string,
  ) {
    super(message);
    this.name = "ServerStartError";
  }
}

export interface ServerOptions {
  build: CodeBuild;
  /** Plugin-owned dir (inside the plugin folder): holds token, server data and CLI data. */
  runtimeDir: string;
  acceptLicense: boolean;
  disableTelemetry?: boolean;
  readyTimeoutMs?: number;
  downloadTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Extra env for the child (tests only). */
  env?: NodeJS.ProcessEnv;
}

export interface RunningServer {
  baseUrl: string;
  port: number;
  /** Held in memory only. Never log, show or persist it. */
  token: string;
}

export class WorkbenchServer {
  private child: ChildProcess | null = null;
  private starting: Promise<RunningServer> | null = null;
  private running: RunningServer | null = null;
  private stopping: Promise<void> | null = null;
  private stderrLines: string[] = [];
  private exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  constructor(private readonly opts: ServerOptions) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get current(): RunningServer | null {
    return this.running;
  }

  get serverDataDir(): string {
    return path.join(this.opts.runtimeDir, "server-data");
  }

  /** Start the server if it is not running; concurrent and repeated calls share one process. */
  ensureStarted(): Promise<RunningServer> {
    if (this.running && this.child && this.exit === null) return Promise.resolve(this.running);
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<RunningServer> {
    const { build, runtimeDir } = this.opts;
    const tokenFile = path.join(runtimeDir, "connection-token");
    const cliDataDir = path.join(runtimeDir, "cli-data");
    fs.mkdirSync(this.serverDataDir, { recursive: true });
    fs.mkdirSync(cliDataDir, { recursive: true });

    const token = createTokenFile(tokenFile);
    shareExtensions(build.extensionsDir, this.serverDataDir);
    const port = await findFreePort();
    const args = buildServeWebArgs({
      port,
      tokenFile,
      serverDataDir: this.serverDataDir,
      cliDataDir,
      acceptLicense: this.opts.acceptLicense,
      disableTelemetry: this.opts.disableTelemetry,
      commitId: build.commit,
    });

    this.stderrLines = [];
    this.exit = null;
    // detached => its own process group, so stop() can take the whole tree down.
    const child = spawn(build.cli, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...this.opts.env },
    });
    this.child = child;

    // stdout carries a "Web UI available at" line that includes the token: drain it, keep nothing.
    child.stdout?.on("data", () => undefined);
    let partial = "";
    child.stderr?.on("data", (buf: Buffer) => {
      const lines = (partial + buf.toString("utf8")).split("\n");
      partial = lines.pop() ?? "";
      for (const l of lines) this.pushStderr(l, token);
    });
    child.once("exit", (code, sig) => {
      if (partial) this.pushStderr(partial, token);
      this.exit = { code, signal: sig };
      if (this.child === child) {
        this.running = null;
      }
    });
    const spawnFailed = new Promise<never>((_, reject) => {
      child.once("error", (e) => reject(new ServerStartError(`Could not run VS Code: ${e.message}`, null, "")));
    });

    try {
      await Promise.race([this.waitUntilReady(port, token), spawnFailed]);
    } catch (e) {
      await this.stop();
      throw e;
    }
    this.running = { baseUrl: `http://${LOOPBACK_HOST}:${port}`, port, token };
    return this.running;
  }

  private pushStderr(line: string, token: string): void {
    const clean = redactToken(line, token).trimEnd();
    if (!clean) return;
    this.stderrLines.push(clean);
    if (this.stderrLines.length > STDERR_TAIL_LINES) this.stderrLines.shift();
  }

  private async waitUntilReady(port: number, token: string): Promise<void> {
    const start = Date.now();
    const readyMs = this.opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
    const downloadMs = this.opts.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
    const interval = this.opts.pollIntervalMs ?? 250;
    let downloading = false;
    for (;;) {
      if (this.exit) {
        const tail = this.stderrLines.join("\n");
        throw new ServerStartError(
          `VS Code server exited with code ${this.exit.code ?? this.exit.signal}${tail ? `:\n${tail}` : ""}`,
          this.exit.code,
          tail,
        );
      }
      const status = await httpStatus(port, token);
      if (status === 200 || status === 302) return;
      if (status === 202) downloading = true; // "downloading the VS Code Server, please wait"
      const limit = downloading ? downloadMs : readyMs;
      if (Date.now() - start > limit) {
        const tail = this.stderrLines.join("\n");
        throw new ServerStartError(
          `VS Code server was not ready after ${Math.round(limit / 1000)} s${tail ? `:\n${tail}` : ""}`,
          this.exit ? (this.exit as { code: number | null }).code : null,
          tail,
        );
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  /**
   * Kill the child and every descendant. The kill signals go out synchronously
   * (before the first await) so plugin unload can call this without waiting.
   */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const child = this.child;
    if (!child || child.pid === undefined) {
      this.running = null;
      return Promise.resolve();
    }
    const pid = child.pid;
    this.running = null;
    // Collect the tree before signalling: once the parent dies its children are re-parented.
    const descendants = listDescendants(pid);
    try {
      process.kill(-pid, "SIGTERM"); // own process group
    } catch {
      signal(pid, "SIGTERM");
    }
    for (const d of descendants) signal(d, "SIGTERM");
    this.stopping = (async () => {
      const all = [pid, ...descendants];
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && all.some(isAlive)) await new Promise((r) => setTimeout(r, 50));
      for (const p of all) if (isAlive(p)) signal(p, "SIGKILL");
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* group already gone */
      }
      if (this.child === child) this.child = null;
      this.stopping = null;
    })();
    return this.stopping;
  }
}
