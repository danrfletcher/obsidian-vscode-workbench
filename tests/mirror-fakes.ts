/**
 * Test doubles for the mirror's unit tests (PR-4): an in-memory `MirrorFs` that records every call, and a
 * scripted `sqlite3` runner that answers by the database a temp copy was made from. Integration tests do not
 * use these: they run the real `sqlite3` against real files.
 */
import * as path from "node:path";
import type { MirrorFs } from "../src/mirror/mirror-fs";
import type { RunOptions, SqliteOutcome, SqliteRunner } from "../src/mirror/sqlite-read";

export interface FsOp {
  op: "mkdir" | "mkdtemp" | "copyFile" | "readFile" | "readdir" | "stat" | "writeFile" | "rename" | "rm";
  /** The path the call reads from (copyFile, rename) or acts on. */
  path: string;
  /** The path a copyFile or rename writes to. */
  to?: string;
}

function err(code: string, p: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${p}`), { code });
}

export class MemFs implements MirrorFs {
  files = new Map<string, string>();
  dirs = new Set<string>();
  /** Each temp copy's source: where `copyFile` copied it from. */
  origin = new Map<string, string>();
  mtimes = new Map<string, number>();
  ops: FsOp[] = [];
  /** Paths (files or folders) whose read or copy fails with this error code. */
  failures = new Map<string, string>();
  /** Fail the next call of this op with this code, once. */
  failNext = new Map<FsOp["op"], string>();
  private counter = 0;

  constructor(files: Record<string, string> = {}) {
    for (const [p, text] of Object.entries(files)) this.put(p, text);
  }

  put(p: string, text: string): void {
    this.files.set(p, text);
    let dir = path.dirname(p);
    while (dir !== path.dirname(dir)) {
      this.dirs.add(dir);
      dir = path.dirname(dir);
    }
  }

  private check(op: FsOp["op"], p: string): void {
    const once = this.failNext.get(op);
    if (once) {
      this.failNext.delete(op);
      throw err(once, p);
    }
    const code = this.failures.get(p);
    if (code) throw err(code, p);
  }

  async mkdir(dir: string): Promise<void> {
    this.ops.push({ op: "mkdir", path: dir });
    this.check("mkdir", dir);
    this.dirs.add(dir);
  }

  async mkdtemp(prefix: string): Promise<string> {
    const dir = `${prefix}${(++this.counter).toString().padStart(6, "0")}`;
    this.ops.push({ op: "mkdtemp", path: dir });
    this.check("mkdtemp", dir);
    this.dirs.add(dir);
    return dir;
  }

  async copyFile(src: string, dst: string): Promise<void> {
    this.ops.push({ op: "copyFile", path: src, to: dst });
    this.check("copyFile", src);
    const text = this.files.get(src);
    if (text === undefined) throw err("ENOENT", src);
    this.files.set(dst, text);
    this.origin.set(dst, this.origin.get(src) ?? src);
  }

  async readFile(file: string): Promise<string> {
    this.ops.push({ op: "readFile", path: file });
    this.check("readFile", file);
    const text = this.files.get(file);
    if (text === undefined) throw err("ENOENT", file);
    return text;
  }

  async readdir(dir: string): Promise<string[]> {
    this.ops.push({ op: "readdir", path: dir });
    this.check("readdir", dir);
    const names = new Set<string>();
    let found = this.dirs.has(dir);
    for (const p of [...this.files.keys(), ...this.dirs]) {
      if (path.dirname(p) === dir) {
        names.add(path.basename(p));
        found = true;
      }
    }
    if (!found) throw err("ENOENT", dir);
    return [...names];
  }

  async stat(file: string): Promise<{ mtimeMs: number }> {
    this.ops.push({ op: "stat", path: file });
    return { mtimeMs: this.mtimes.get(file) ?? Date.now() };
  }

  async writeFile(file: string, data: string): Promise<void> {
    this.ops.push({ op: "writeFile", path: file });
    this.check("writeFile", file);
    this.put(file, data);
  }

  async rename(from: string, to: string): Promise<void> {
    this.ops.push({ op: "rename", path: from, to });
    this.check("rename", from);
    const text = this.files.get(from);
    if (text === undefined) throw err("ENOENT", from);
    this.files.delete(from);
    this.files.set(to, text);
  }

  async rm(target: string): Promise<void> {
    this.ops.push({ op: "rm", path: target });
    for (const p of [...this.files.keys()]) if (p === target || p.startsWith(target + path.sep)) this.files.delete(p);
    for (const d of [...this.dirs]) if (d === target || d.startsWith(target + path.sep)) this.dirs.delete(d);
  }

  /** Every file or folder still under `root`. */
  under(root: string): string[] {
    return [...this.files.keys(), ...this.dirs].filter((p) => p !== root && p.startsWith(root + path.sep)).sort();
  }

  /** Every path a write-type call changed (writeFile and rename targets, copyFile targets, mkdir, mkdtemp). */
  writes(): string[] {
    return this.ops.flatMap((o) => (o.op === "writeFile" || o.op === "mkdir" || o.op === "mkdtemp" ? [o.path] : o.op === "copyFile" || o.op === "rename" ? [o.to as string] : []));
  }
}

/** What a scripted runner answers for one source database. A string is the `-json` output. */
export type Answer = string | SqliteOutcome | ((args: string[]) => SqliteOutcome | Promise<SqliteOutcome>);

/** The `-json` output of a value stored for the disabled key. */
export const jsonRow = (value: string): string => JSON.stringify([{ value }]);
/** The `-json` output for a list of ids in VS Code's own form. */
export const idsRow = (...ids: string[]): string => jsonRow(JSON.stringify(ids.map((id) => ({ id }))));

/**
 * A runner that finds which database a temp copy was made from (through the `MemFs`) and answers from `answers`
 * by that database's path. It records every call. A source with no answer gets empty output (the key is absent).
 */
export function scriptedRunner(mem: MemFs, answers: Record<string, Answer>) {
  const calls: Array<{ args: string[]; source: string | undefined; options: RunOptions }> = [];
  const run: SqliteRunner = async (args, options) => {
    const copy = args[2];
    const source = mem.origin.get(copy);
    calls.push({ args, source, options });
    const answer = source === undefined ? undefined : answers[source];
    if (answer === undefined) return { kind: "ok", stdout: "" };
    if (typeof answer === "string") return { kind: "ok", stdout: answer };
    if (typeof answer === "function") return answer(args);
    return answer;
  };
  return { run, calls };
}
