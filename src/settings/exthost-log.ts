/**
 * What the extension host log says about the shared extensions (G3, G16, E4). The server's extension host
 * writes `<server data dir>/data/logs/<run>/exthost<N>/remoteexthost.log`, one `<run>` folder per server
 * process. This reads the newest run's host logs, only the tail of each, when the settings tab opens: nothing
 * here watches a file or keeps a result (F7), and nothing is written (the files are only opened to read).
 *
 * Lines look like `2026-10-27 22:08:38.379 [info] ExtensionService#_doActivateExtension <id>, startup: false, ...`
 * for an activation. A failure is an `[error]` line that names the extension's id; the reason is that line's
 * message, plus the line after it when the message ends in a colon (the error itself). Ids match
 * case-insensitively, and an id the caller did not give is ignored. Every reason is plain text, capped.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { cleanText } from "./extension-states";

/** How much of the end of each log is read. A log is read for its latest lines, so a huge one costs one bounded read. */
export const TAIL_BYTES = 512 * 1024;

/** The newest hosts of a run that are read (a host starts per Code tab load). */
export const MAX_HOSTS = 8;

export const LOG_FILE = "remoteexthost.log";

/** What the log last said about one extension. */
export type ExtFact = { kind: "active" } | { kind: "failed"; reason: string | null };

/** By lower-case id; only ids the caller asked about. */
export type ExtHostFacts = Map<string, ExtFact>;

const RECORD = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\s+\[(\w+)\]\s?(.*)$/;
const ACTIVATE = /_doActivateExtension\s+([^\s,]+)/;
const DOTTED = /[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+/g;
/** "Activating extension x failed due to an error:" says only that it failed; the error follows. */
const GENERIC_FAILURE = /^activating extension\b[^:]*\bfailed due to an error:?$/i;

interface LogRecord {
  level: string;
  head: string;
  /** Lines after the first that carry no timestamp (an error's message or stack). */
  rest: string[];
}

/** Group lines into records. Lines before the first timestamped one (a cut-off start) and garbage are dropped. */
function records(text: string): LogRecord[] {
  const out: LogRecord[] = [];
  for (const line of text.split(/\r\n?|\n/)) {
    const m = RECORD.exec(line);
    if (m) out.push({ level: m[1].toLowerCase(), head: m[2], rest: [] });
    else if (out.length > 0 && line.trim() !== "") out[out.length - 1].rest.push(line);
  }
  return out;
}

function idsIn(text: string): string[] {
  return (text.match(DOTTED) ?? []).map((t) => t.toLowerCase());
}

/** The reason an error record gives for the failure of `id`; null when it gives none beyond "it failed". */
function failureReason(rec: LogRecord, next: LogRecord | undefined): string | null {
  const head = rec.head.trim();
  const endsInColon = head.endsWith(":");
  const nextDetail = next && next.level === "error" && !GENERIC_FAILURE.test(next.head.trim()) && !ACTIVATE.test(next.head) ? next.head : "";
  const detail = endsInColon ? (rec.rest.find((l) => l.trim() !== "") ?? nextDetail) : "";
  if (GENERIC_FAILURE.test(head)) return cleanText(detail);
  const bare = head.replace(DOTTED, "").replace(/[\s:;,.'"`()[\]{}<>-]/g, "");
  if (bare === "" && detail.trim() === "") return null;
  return cleanText(detail.trim() !== "" ? `${head.replace(/:$/, "")}: ${detail.trim()}` : head.replace(/:$/, ""));
}

/**
 * Read the log text. The latest line about an extension decides, so an activation after a failure reads as
 * active and a failure after an activation reads as failed.
 */
export function parseExtHostLog(text: string, ids: ReadonlySet<string>): ExtHostFacts {
  const wanted = new Set([...ids].map((i) => i.toLowerCase()));
  const facts: ExtHostFacts = new Map();
  const recs = records(text);
  recs.forEach((rec, i) => {
    const activated = ACTIVATE.exec(rec.head);
    if (activated) {
      const id = activated[1].toLowerCase();
      if (wanted.has(id)) facts.set(id, { kind: "active" });
      return;
    }
    if (rec.level !== "error") return;
    const named = idsIn(rec.head).find((t) => wanted.has(t));
    if (named === undefined) return;
    facts.set(named, { kind: "failed", reason: failureReason(rec, recs[i + 1]) });
  });
  return facts;
}

/** Combine the facts of several hosts: a failure in any of them stands, else an activation in any. */
function merge(into: ExtHostFacts, from: ExtHostFacts): void {
  for (const [id, fact] of from) {
    const have = into.get(id);
    if (have === undefined || (have.kind === "active" && fact.kind === "failed") || (have.kind === "failed" && have.reason === null && fact.kind === "failed")) into.set(id, fact);
  }
}

/** The file access the reader needs; the real one reads, nothing more. */
export interface LogFs {
  /** The names in a folder; null when it cannot be listed. */
  list(dir: string): Promise<string[] | null>;
  /** The last `maxBytes` of a file, starting at a line start; null when it cannot be read. */
  tail(file: string, maxBytes: number): Promise<string | null>;
}

export const realLogFs: LogFs = {
  async list(dir) {
    try {
      return await fs.readdir(dir);
    } catch {
      return null;
    }
  },
  async tail(file, maxBytes) {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(file, "r");
      const { size } = await handle.stat();
      const length = Math.min(size, maxBytes);
      if (length === 0) return "";
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, size - length);
      const text = buf.toString("utf8", 0, bytesRead);
      if (size <= maxBytes) return text;
      const newline = text.indexOf("\n");
      return newline < 0 ? "" : text.slice(newline + 1); // the cut falls inside a line: start at the next one
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  },
};

export type ExtHostLogRead = { found: false } | { found: true; facts: ExtHostFacts };

export interface ReadOptions {
  fs?: LogFs;
  tailBytes?: number;
}

/** Host folder names, newest first: `exthost2` before `exthost1`. */
function hostsNewestFirst(names: readonly string[]): string[] {
  const num = (n: string) => Number(/^exthost(\d*)$/i.exec(n)?.[1] || 0);
  return names
    .filter((n) => /^exthost\d*$/i.test(n))
    .sort((a, b) => num(b) - num(a))
    .slice(0, MAX_HOSTS);
}

/**
 * Read the extension host log of the newest server run. `found: false` when there is no run, no host log, or
 * every log is empty or unreadable: active, failed and inactive cannot then be told. Never throws.
 */
export async function readExtHostLog(serverDataDir: string, ids: ReadonlySet<string>, opts: ReadOptions = {}): Promise<ExtHostLogRead> {
  const io = opts.fs ?? realLogFs;
  const tailBytes = opts.tailBytes ?? TAIL_BYTES;
  try {
    const logs = path.join(serverDataDir, "data", "logs");
    const runs = ((await io.list(logs)) ?? []).filter((n) => !n.startsWith(".")).sort().reverse();
    if (runs.length === 0) return { found: false };
    const runDir = path.join(logs, runs[0]);
    const hosts = hostsNewestFirst((await io.list(runDir)) ?? []);
    const facts: ExtHostFacts = new Map();
    let found = false;
    for (const host of hosts) {
      const text = await io.tail(path.join(runDir, host, LOG_FILE), tailBytes);
      if (text === null || text.trim() === "") continue;
      found = true;
      merge(facts, parseExtHostLog(text, ids));
    }
    return found ? { found: true, facts } : { found: false };
  } catch {
    return { found: false };
  }
}
