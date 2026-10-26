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
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as dns from "node:dns";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildRegistry } from "./child-registry";
import { isAlive, listDescendants, pidsWithCommandContaining, signal, signalGroup } from "./process-utils";

export { descendantsFromPs, listDescendants } from "./process-utils";

export const LOOPBACK_HOST = "127.0.0.1";
export const READY_TIMEOUT_MS = 30_000;
/** Once the server answers "still downloading" (HTTP 202) we wait this long in total. */
export const DOWNLOAD_TIMEOUT_MS = 300_000;
/** How many of the child's last output lines (stdout and stderr) are kept for failure messages. */
export const LOG_TAIL_LINES = 10;
/** Where `serve-web` downloads its server build from; the only host the start talks to (F5). */
export const DOWNLOAD_HOST = "update.code.visualstudio.com";
export const COMMIT_RE = /^[0-9a-f]{40}$/;

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
// Ports and probing
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

/** Ports of servers this process started and that are still up: a new start never reuses one. */
const heldPorts = new Set<number>();

/** A free loopback port that no server of ours still holds. */
export async function pickPort(pick: () => Promise<number> = findFreePort): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const port = await pick();
    if (!heldPorts.has(port)) return port;
  }
  throw new ServerStartError("Could not find a free port on 127.0.0.1.", null, "", { kind: "port-bind" });
}

export function httpStatus(port: number, token: string, timeoutMs = 2000): Promise<number | null> {
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

/** One probe: the status code and the start of the body (for the "download failed" page). */
export interface ProbeResult {
  status: number | null;
  body: string;
}

export function httpProbe(port: number, token: string, timeoutMs = 2000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: LOOPBACK_HOST, port, path: `/?tkn=${token}`, timeout: timeoutMs },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (body.length < 2048) body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? null, body: body.slice(0, 2048) }));
        res.on("error", () => resolve({ status: res.statusCode ?? null, body }));
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve({ status: null, body: "" }));
  });
}

/**
 * Whether the download host can be reached: a name lookup, then a TCP connect to
 * port 443 (no request is sent). `serve-web` does not say why a download failed,
 * so this is how "the network is unreachable" is told apart from any other
 * download failure.
 */
export function checkDownloadHostReachable(host = DOWNLOAD_HOST, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    dns.lookup(host, (err, address) => {
      if (err) return resolve(false);
      const socket = net.connect({ host: address, port: 443, timeout: timeoutMs });
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.once("connect", () => done(true));
      socket.once("timeout", () => done(false));
      socket.once("error", () => done(false));
    });
  });
}

// ---------------------------------------------------------------------------
// Reading the child's log
// ---------------------------------------------------------------------------

/** `[time] info Downloading server <commit>`: logged when a download attempt starts. */
const DOWNLOAD_START_RE = /\binfo\s+Downloading server\b/i;
/** An error-level log line that is about the download. */
const DOWNLOAD_ERROR_LINE_RE = /^\[[^\]]*\]\s+(error|critical)\b.*download/i;
/** What `serve-web` answers (instead of the "please wait" page) when the download failed. */
const DOWNLOAD_ERROR_BODY_RE = /error was encountered downloading the server/i;

/** Lines that say nothing useful in a failure message: the licence banner and the line that carries the token. */
export function isLogNoise(line: string): boolean {
  return line.startsWith("*") || /^Web UI available at\b/.test(line);
}

/**
 * Whether the child's output and the probe show a failed download. The real
 * `serve-web` keeps answering 202 "downloading" after a failed attempt and logs
 * no reason: every new request starts another attempt and logs another
 * "Downloading server" line. A download that is really in progress logs that
 * line once, however many requests arrive, so a second line means the first
 * attempt failed.
 */
export function downloadFailureSignal(input: { startLines: number; errorLine: string | null; probeBody: string }): string | null {
  if (input.errorLine) return input.errorLine;
  if (DOWNLOAD_ERROR_BODY_RE.test(input.probeBody)) return input.probeBody.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  if (input.startLines >= 2) return "The server download was attempted again after it failed.";
  return null;
}

// ---------------------------------------------------------------------------
// The serve-web download cache
// ---------------------------------------------------------------------------

/** Commits whose server build is cached under `<cliDataDir>/serve-web/`. */
export function cachedServerCommits(cliDataDir: string): Set<string> {
  try {
    return new Set(fs.readdirSync(path.join(cliDataDir, "serve-web")).filter((n) => COMMIT_RE.test(n)));
  } catch {
    return new Set();
  }
}

/**
 * Remove server builds that appeared in the cache after `before` was taken: a
 * download that failed part-way must not be left looking like a usable build.
 */
export function removePartialDownloads(cliDataDir: string, before: ReadonlySet<string>): string[] {
  const removed: string[] = [];
  for (const commit of cachedServerCommits(cliDataDir)) {
    if (before.has(commit)) continue;
    fs.rmSync(path.join(cliDataDir, "serve-web", commit), { recursive: true, force: true });
    fs.rmSync(path.join(cliDataDir, "serve-web", ".locks", commit), { recursive: true, force: true });
    removed.push(commit);
  }
  return removed;
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export type StartErrorKind = "missing-binary" | "no-serve-web" | "spawn" | "exit" | "timeout" | "port-bind" | "download";

export class ServerStartError extends Error {
  readonly kind: StartErrorKind;
  readonly port?: number;
  /** Extra text for the Notice (e.g. the CLI path for "no serve-web"). */
  readonly detail?: string;
  /** Seconds waited, for a timeout. */
  readonly seconds?: number;

  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderrTail: string,
    extra: { kind?: StartErrorKind; port?: number; detail?: string; seconds?: number } = {},
  ) {
    super(message);
    this.name = "ServerStartError";
    this.kind = extra.kind ?? "exit";
    this.port = extra.port;
    this.detail = extra.detail;
    this.seconds = extra.seconds;
  }
}

/** Thrown to callers of a start that was cancelled by stop() or restart() before it finished. */
export class StartCancelledError extends Error {
  constructor() {
    super("The VS Code server start was cancelled.");
    this.name = "StartCancelledError";
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
  /** The child registers here (and so in the pidfile) the moment it is spawned. */
  registry?: ChildRegistry;
  /** The vault folder; recorded in the pidfile entry. */
  workspace?: string;
  /** Replaces the readiness/health HTTP probe (tests). */
  probe?: (port: number, token: string) => Promise<number | null>;
  /** Replaces the check that tells an unreachable network from another download failure (tests). */
  downloadHostReachable?: () => Promise<boolean>;
  /** Replaces the free-port lookup (tests). */
  findPort?: () => Promise<number>;
}

export interface RunningServer {
  baseUrl: string;
  port: number;
  /** Held in memory only. Never log, show or persist it. */
  token: string;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class WorkbenchServer {
  private child: ChildProcess | null = null;
  private starting: Promise<RunningServer> | null = null;
  private running: RunningServer | null = null;
  private stopping: Promise<void> | null = null;
  private stopRequested = false;
  private heldPort: number | null = null;
  private tokenFile = "";
  private logLines: string[] = [];
  private downloadStartLines = 0;
  private downloadErrorLine: string | null = null;
  private exit: ExitInfo | null = null;
  private exitListeners: Array<(info: ExitInfo) => void> = [];

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

  get cliDataDir(): string {
    return path.join(this.opts.runtimeDir, "cli-data");
  }

  /** Called when the server dies without stop() having been asked for (a crash, `kill -9`). */
  onUnexpectedExit(listener: (info: ExitInfo) => void): void {
    this.exitListeners.push(listener);
  }

  /** One HTTP check of the running server: the status code, or null when nothing answers. */
  async probe(): Promise<number | null> {
    const r = this.running;
    if (!r) return null;
    return (this.opts.probe ?? httpStatus)(r.port, r.token);
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
    this.tokenFile = tokenFile;
    const cliDataDir = this.cliDataDir;
    fs.mkdirSync(this.serverDataDir, { recursive: true });
    fs.mkdirSync(cliDataDir, { recursive: true });

    const token = createTokenFile(tokenFile);
    shareExtensions(build.extensionsDir, this.serverDataDir);
    const port = await pickPort(this.opts.findPort);
    const args = buildServeWebArgs({
      port,
      tokenFile,
      serverDataDir: this.serverDataDir,
      cliDataDir,
      acceptLicense: this.opts.acceptLicense,
      disableTelemetry: this.opts.disableTelemetry,
      commitId: build.commit,
    });

    this.logLines = [];
    this.downloadStartLines = 0;
    this.downloadErrorLine = null;
    this.exit = null;
    this.stopRequested = false;
    // detached => its own process group, so stop() can take the whole tree down.
    const child = spawn(build.cli, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...this.opts.env },
    });
    this.child = child;
    heldPorts.add(port);
    this.heldPort = port;
    if (child.pid !== undefined) {
      const server = this;
      this.opts.registry?.register({
        pid: child.pid,
        label: "vscode-server",
        match: "serve-web",
        workspace: this.opts.workspace,
        group: true,
        kill: () => server.stop(),
      });
    }

    // Both streams are the log: the real serve-web writes its log lines to stdout and leaves stderr empty.
    // stdout also carries a "Web UI available at" line that includes the token; every line is redacted
    // and that one is dropped (isLogNoise).
    const flushers = [child.stdout, child.stderr].map((stream) => {
      let partial = "";
      stream?.on("data", (buf: Buffer) => {
        const lines = (partial + buf.toString("utf8")).split("\n");
        partial = lines.pop() ?? "";
        for (const l of lines) this.pushLog(l, token);
      });
      return () => {
        if (partial) this.pushLog(partial, token);
        partial = "";
      };
    });
    child.once("exit", (code, sig) => {
      for (const flush of flushers) flush();
      this.exit = { code, signal: sig };
      heldPorts.delete(port);
      if (child.pid !== undefined) this.opts.registry?.unregister(child.pid);
      if (this.child === child) {
        const wasRunning = this.running !== null;
        this.running = null;
        if (wasRunning && !this.stopRequested) for (const l of this.exitListeners) l({ code, signal: sig });
      }
    });
    const spawnFailed = new Promise<never>((_, reject) => {
      child.once("error", (e) =>
        reject(new ServerStartError(`Could not run VS Code: ${e.message}`, null, "", { kind: "spawn" })),
      );
    });

    try {
      await Promise.race([this.waitUntilReady(port, token), spawnFailed]);
    } catch (e) {
      await this.stop();
      throw e;
    }
    if (this.stopRequested) throw new StartCancelledError();
    this.running = { baseUrl: `http://${LOOPBACK_HOST}:${port}`, port, token };
    return this.running;
  }

  private pushLog(line: string, token: string): void {
    const clean = redactToken(line, token).trim();
    if (!clean || isLogNoise(clean)) return;
    if (DOWNLOAD_START_RE.test(clean)) this.downloadStartLines++;
    if (DOWNLOAD_ERROR_LINE_RE.test(clean)) this.downloadErrorLine = clean;
    this.addTail(clean);
  }

  private addTail(line: string): void {
    this.logLines.push(line);
    if (this.logLines.length > LOG_TAIL_LINES) this.logLines.shift();
  }

  private async waitUntilReady(port: number, token: string): Promise<void> {
    const start = Date.now();
    const readyMs = this.opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
    const downloadMs = this.opts.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
    const interval = this.opts.pollIntervalMs ?? 250;
    const probe = async (): Promise<ProbeResult> =>
      this.opts.probe ? { status: await this.opts.probe(port, token), body: "" } : httpProbe(port, token);
    let downloading = false;
    for (;;) {
      if (this.stopRequested) throw new StartCancelledError();
      if (this.exit) {
        const tail = this.logLines.join("\n");
        throw new ServerStartError(
          `VS Code server exited with code ${this.exit.code ?? this.exit.signal}${tail ? `:\n${tail}` : ""}`,
          this.exit.code,
          tail,
          { kind: "exit", port },
        );
      }
      const { status, body } = await probe();
      if (status === 200 || status === 302) return;
      if (status === 202) downloading = true; // "downloading the VS Code Server, please wait"
      if (status === 202 || status === 500 || this.downloadErrorLine) {
        // A failed download does not end the process: it keeps answering 202 (see downloadFailureSignal).
        const signal = downloadFailureSignal({ startLines: this.downloadStartLines, errorLine: this.downloadErrorLine, probeBody: redactToken(body, token) });
        if (signal) await this.failDownload(signal, port);
      }
      const limit = downloading ? downloadMs : readyMs;
      if (Date.now() - start > limit) {
        const tail = this.logLines.join("\n");
        throw new ServerStartError(
          `VS Code server was not ready after ${Math.round(limit / 1000)} s${tail ? `:\n${tail}` : ""}`,
          this.exit ? (this.exit as ExitInfo).code : null,
          tail,
          { kind: "timeout", port, seconds: Math.round(limit / 1000) },
        );
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  /**
   * The download failed. serve-web does not say why, so check whether the
   * download host can be reached and put the answer in the log tail: the
   * failure message is chosen from it (see failure-messages.ts).
   */
  private async failDownload(signal: string, port: number): Promise<never> {
    const reachable = await (this.opts.downloadHostReachable ?? checkDownloadHostReachable)();
    this.addTail(signal);
    this.addTail(
      reachable
        ? `The server download keeps failing although ${DOWNLOAD_HOST} answers.`
        : `Network is unreachable: could not connect to ${DOWNLOAD_HOST} (dns error: failed to lookup address information).`,
    );
    const tail = this.logLines.join("\n");
    throw new ServerStartError(`VS Code server download failed:\n${tail}`, null, tail, { kind: "download", port });
  }

  /**
   * Kill the child and every descendant. The kill signals go out synchronously
   * (before the first await) so plugin unload can call this without waiting.
   */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopRequested = true;
    const child = this.child;
    if (!child || child.pid === undefined) {
      this.running = null;
      return Promise.resolve();
    }
    const pid = child.pid;
    this.running = null;
    if (this.exit !== null) {
      // The wrapper is already gone, so its pid (and process group id) may have been reused by
      // another program: never signal it. Stragglers are found by our own token-file path, which
      // appears on the command line of every process the wrapper started.
      const stragglers = this.tokenFile ? pidsWithCommandContaining(this.tokenFile) : [];
      for (const d of stragglers) signal(d, "SIGTERM");
      this.stopping = (async () => {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && stragglers.some(isAlive)) await new Promise((r) => setTimeout(r, 50));
        for (const p of stragglers) if (isAlive(p)) signal(p, "SIGKILL");
        this.finishStop(child, pid);
      })();
      return this.stopping;
    }
    // Collect the tree before signalling: once the parent dies its children are re-parented.
    const descendants = listDescendants(pid);
    signalGroup(pid, "SIGTERM"); // own process group
    signal(pid, "SIGTERM");
    for (const d of descendants) signal(d, "SIGTERM");
    this.stopping = (async () => {
      const all = [pid, ...descendants];
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && all.some(isAlive)) await new Promise((r) => setTimeout(r, 50));
      for (const p of all) if (isAlive(p)) signal(p, "SIGKILL");
      signalGroup(pid, "SIGKILL");
      this.finishStop(child, pid);
    })();
    return this.stopping;
  }

  private finishStop(child: ChildProcess, pid: number): void {
    if (this.child === child) this.child = null;
    if (this.heldPort !== null) heldPorts.delete(this.heldPort);
    this.heldPort = null;
    this.opts.registry?.unregister(pid);
    this.stopping = null;
  }
}
