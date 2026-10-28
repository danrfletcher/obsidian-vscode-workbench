/**
 * Reading one value out of a VS Code `state.vscdb` with the system `sqlite3` command line tool (F4: no native
 * module, no SQL library in the bundle).
 *
 * The database is never opened where it lives (F1). It is copied, with any `-wal` and `-shm` sidecar next to it,
 * into a new folder of its own under the plugin's temp root, and `sqlite3 -readonly` is given the copy. The folder
 * is removed afterwards, whatever happened, and a cancelled read removes it too. Two reads at once use two folders.
 *
 * `sqlite3` is started by name from `PATH` through `execFile` with an argument array: no shell, so no path or key
 * is ever parsed as shell text. A hung `sqlite3` is killed (SIGKILL) after `SQLITE_TIMEOUT_MS`.
 *
 * Nothing here throws for a bad database: every outcome is a value, so the server start never depends on it.
 */
import { execFile } from "node:child_process";
import * as path from "node:path";
import { errorCode, isMissing, realMirrorFs, type MirrorFs } from "./mirror-fs";

/** The key VS Code keeps its list of disabled extensions under, in the `ItemTable` of a `state.vscdb`. */
export const DISABLED_KEY = "extensionsIdentifiers/disabled";
export const SQLITE_TIMEOUT_MS = 5000;
/** Cap on what `sqlite3` may print: the value is a short list of extension ids. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** A temp folder left by a killed Obsidian is removed once it is this old. */
const STALE_TEMP_MS = 10 * 60 * 1000;
const TEMP_PREFIX = "read-";

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export type SqliteOutcome =
  | { kind: "ok"; stdout: string }
  /** `sqlite3` is not on PATH (ENOENT on spawn). */
  | { kind: "missing" }
  /** It ran and exited non-zero (or could not be run for another reason: `code` is null). */
  | { kind: "exit"; code: number | null; stderr: string }
  | { kind: "timeout" }
  | { kind: "aborted" };

export interface RunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Runs `sqlite3` with these arguments. Injectable so a unit test needs no real binary. */
export type SqliteRunner = (args: string[], options: RunOptions) => Promise<SqliteOutcome>;

/** The real runner: `execFile("sqlite3", args)`, never through a shell. `env` is for tests (a stub first on PATH). */
export function createSqliteRunner(env?: NodeJS.ProcessEnv): SqliteRunner {
  return (args, { timeoutMs, signal }) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve({ kind: "aborted" });
      execFile(
        "sqlite3",
        args,
        { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8", windowsHide: true, signal, ...(env ? { env } : {}) },
        (err, stdout, stderr) => {
          if (!err) return resolve({ kind: "ok", stdout });
          if (signal?.aborted) return resolve({ kind: "aborted" });
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.code === "ENOENT") return resolve({ kind: "missing" });
          if (e.killed) return resolve({ kind: "timeout" });
          resolve({ kind: "exit", code: typeof e.code === "number" ? e.code : null, stderr: String(stderr ?? "") });
        },
      );
    });
}

// ---------------------------------------------------------------------------
// One read
// ---------------------------------------------------------------------------

export type FailureKind = "sqlite-missing" | "locked" | "timeout" | "unreadable" | "bad-output" | "cancelled";

export type DbRead =
  /** `missing`: the database file is not there (an empty list, for the caller to judge). `ids`: lower case, no duplicates. */
  | { ok: true; ids: string[]; missing: boolean }
  | { ok: false; kind: FailureKind; reason: string };

export interface SqliteDeps {
  fs?: MirrorFs;
  run?: SqliteRunner;
  timeoutMs?: number;
}

export interface ReadOptions extends SqliteDeps {
  /** The folder the temp copies are made in (inside the plugin's own folder). */
  tmpRoot: string;
  signal?: AbortSignal;
}

const SQL = `SELECT CAST(value AS TEXT) AS value FROM ItemTable WHERE key = '${DISABLED_KEY}'`;

/** The ids in the stored value: a JSON array of `{id}` objects or bare strings. Lower case, trimmed, no duplicates. */
export function parseDisabledValue(text: string): { ok: true; ids: string[] } | { ok: false; reason: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the stored value is not JSON" }; // never quote it: it is not ours
  }
  if (!Array.isArray(json)) return { ok: false, reason: "the stored value is JSON but not a list" };
  const ids = new Set<string>();
  for (const item of json) {
    const id = typeof item === "string" ? item : typeof item === "object" && item !== null ? (item as { id?: unknown }).id : undefined;
    // An entry that names no extension cannot be skipped safely: a partial list would share what Dan disabled.
    if (typeof id !== "string" || id.trim() === "") return { ok: false, reason: "the stored list has an entry that names no extension" };
    ids.add(id.trim().toLowerCase());
  }
  return { ok: true, ids: [...ids].sort() };
}

/** What `sqlite3 -json` printed for the query: nothing (no row), or `[{"value": "..."}]`. */
function parseOutput(stdout: string): { ok: true; ids: string[] } | { ok: false; reason: string } {
  const text = stdout.trim();
  if (text === "") return { ok: true, ids: [] }; // the key is not there: nothing is disabled in this database
  let rows: unknown;
  try {
    rows = JSON.parse(text);
  } catch {
    return { ok: false, reason: "sqlite3 printed something that is not JSON" };
  }
  if (!Array.isArray(rows)) return { ok: false, reason: "sqlite3 printed no list of rows" };
  if (rows.length === 0) return { ok: true, ids: [] };
  const value = (rows[0] as { value?: unknown } | null)?.value;
  if (typeof value !== "string") return { ok: false, reason: "sqlite3 printed no usable value" };
  return parseDisabledValue(value);
}

function describeExit(code: number | null, stderr: string): { kind: FailureKind; reason: string } {
  if (/database (?:table )?is (?:locked|busy)/i.test(stderr)) return { kind: "locked", reason: "the database is busy or locked" };
  if (/no such table/i.test(stderr)) return { kind: "unreadable", reason: "the database has no ItemTable" };
  if (/not a database|malformed|corrupt/i.test(stderr)) return { kind: "unreadable", reason: "the database is corrupt or truncated" };
  return { kind: "unreadable", reason: code === null ? "sqlite3 could not be run" : `sqlite3 exited with code ${code}` };
}

/** Remove temp folders an earlier, killed run left behind. Never throws. */
async function sweepStale(tmpRoot: string, io: MirrorFs): Promise<void> {
  try {
    for (const name of await io.readdir(tmpRoot)) {
      if (!name.startsWith(TEMP_PREFIX)) continue;
      const dir = path.join(tmpRoot, name);
      try {
        if (Date.now() - (await io.stat(dir)).mtimeMs > STALE_TEMP_MS) await io.rm(dir, { recursive: true, force: true });
      } catch {
        /* a folder another read just removed, or one that cannot be removed: leave it */
      }
    }
  } catch {
    /* no temp root yet */
  }
}

/**
 * The disabled-extension ids stored in one `state.vscdb`, read from a temp copy. A database file that is not
 * there is `{ ok: true, ids: [], missing: true }`; a key that is not in it is `{ ok: true, ids: [], missing: false }`;
 * everything else that goes wrong is `{ ok: false }` with a plain reason.
 */
export async function readDisabledFromDb(dbPath: string, opts: ReadOptions): Promise<DbRead> {
  const io = opts.fs ?? realMirrorFs;
  const run = opts.run ?? createSqliteRunner();
  const cancelled: DbRead = { ok: false, kind: "cancelled", reason: "the read was cancelled" };
  if (opts.signal?.aborted) return cancelled;

  let dir: string | null = null;
  try {
    try {
      await io.mkdir(opts.tmpRoot, { recursive: true });
      await sweepStale(opts.tmpRoot, io);
      dir = await io.mkdtemp(path.join(opts.tmpRoot, TEMP_PREFIX));
    } catch (e) {
      return { ok: false, kind: "unreadable", reason: `a temp folder could not be made (${errorCode(e) ?? "error"})` };
    }
    const copy = path.join(dir, "state.vscdb");

    try {
      await io.copyFile(dbPath, copy);
    } catch (e) {
      if (isMissing(e)) return { ok: true, ids: [], missing: true };
      return { ok: false, kind: "unreadable", reason: `the database could not be copied (${errorCode(e) ?? "error"})` };
    }
    for (const suffix of ["-wal", "-shm"]) {
      try {
        await io.copyFile(dbPath + suffix, copy + suffix);
      } catch (e) {
        if (!isMissing(e)) return { ok: false, kind: "unreadable", reason: `the database's ${suffix} file could not be copied (${errorCode(e) ?? "error"})` };
      }
    }
    if (opts.signal?.aborted) return cancelled;

    const outcome = await run(["-readonly", "-json", copy, SQL], { timeoutMs: opts.timeoutMs ?? SQLITE_TIMEOUT_MS, signal: opts.signal });
    switch (outcome.kind) {
      case "aborted":
        return cancelled;
      case "missing":
        return { ok: false, kind: "sqlite-missing", reason: "sqlite3 was not found on PATH" };
      case "timeout":
        return { ok: false, kind: "timeout", reason: "sqlite3 did not answer in time and was stopped" };
      case "exit":
        return { ok: false, ...describeExit(outcome.code, outcome.stderr) };
      case "ok":
      default: {
        const parsed = parseOutput(outcome.stdout);
        return parsed.ok ? { ok: true, ids: parsed.ids, missing: false } : { ok: false, kind: "bad-output", reason: parsed.reason };
      }
    }
  } finally {
    if (dir !== null) await io.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
