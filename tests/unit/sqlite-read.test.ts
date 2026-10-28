import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { readDisabledLists } from "../../src/mirror/disabled-lists";
import { DISABLED_KEY, SQLITE_TIMEOUT_MS, readDisabledFromDb, type SqliteOutcome, type SqliteRunner } from "../../src/mirror/sqlite-read";
import { MemFs, idsRow, jsonRow } from "../mirror-fakes";

const DB = "/App/Code - Insiders/User/globalStorage/state.vscdb";
const TMP = "/Plugin/.server/mirror-tmp";

/** A runner that answers `outcome`, recording its calls. */
function answering(outcome: SqliteOutcome | (() => SqliteOutcome)) {
  const calls: Array<{ args: string[]; timeoutMs: number; signal?: AbortSignal }> = [];
  const run: SqliteRunner = async (args, options) => {
    calls.push({ args, timeoutMs: options.timeoutMs, signal: options.signal });
    return typeof outcome === "function" ? outcome() : outcome;
  };
  return { run, calls };
}

const read = (mem: MemFs, run: SqliteRunner, extra: Partial<Parameters<typeof readDisabledFromDb>[1]> = {}) => readDisabledFromDb(DB, { tmpRoot: TMP, fs: mem, run, ...extra });

describe("how sqlite3 is run", () => {
  it("gets -readonly, -json, the temp copy and one SELECT of the disabled key, in that order; the original path is never an argument", async () => {
    const mem = new MemFs({ [DB]: "db" });
    const a = answering({ kind: "ok", stdout: idsRow("a.b") });
    expect(await read(mem, a.run)).toEqual({ ok: true, ids: ["a.b"], missing: false });
    expect(a.calls).toHaveLength(1);
    const [flag1, flag2, target, sql, ...rest] = a.calls[0].args;
    expect([flag1, flag2]).toEqual(["-readonly", "-json"]);
    expect(rest).toEqual([]);
    expect(target.startsWith(TMP + path.sep)).toBe(true);
    expect(target).not.toBe(DB);
    expect(a.calls[0].args.some((x) => x === DB || x.startsWith(path.dirname(DB)))).toBe(false);
    expect(sql).toContain("FROM ItemTable");
    expect(sql).toContain(`key = '${DISABLED_KEY}'`);
    expect(sql.toLowerCase().startsWith("select")).toBe(true);
  });

  it("uses a 5 s timeout unless told otherwise", async () => {
    expect(SQLITE_TIMEOUT_MS).toBe(5000);
    const mem = new MemFs({ [DB]: "db" });
    const a = answering({ kind: "ok", stdout: "" });
    await read(mem, a.run);
    await read(mem, a.run, { timeoutMs: 250 });
    expect(a.calls.map((c) => c.timeoutMs)).toEqual([5000, 250]);
  });
});

describe("what each runner outcome becomes, and that the temp copy is gone after each", () => {
  const cases: Array<{ name: string; outcome: SqliteOutcome | (() => SqliteOutcome); expected: object | "throws" }> = [
    { name: "sqlite3 missing (ENOENT on spawn)", outcome: { kind: "missing" }, expected: { ok: false, kind: "sqlite-missing", reason: "sqlite3 was not found on PATH" } },
    { name: "database busy", outcome: { kind: "exit", code: 5, stderr: "Error: database is locked" }, expected: { ok: false, kind: "locked", reason: "the database is busy or locked" } },
    { name: "database table locked", outcome: { kind: "exit", code: 6, stderr: "database table is locked" }, expected: { ok: false, kind: "locked" } },
    { name: "a hang (killed by the timeout)", outcome: { kind: "timeout" }, expected: { ok: false, kind: "timeout" } },
    { name: "a missing ItemTable", outcome: { kind: "exit", code: 1, stderr: "Error: in prepare, no such table: ItemTable (1)" }, expected: { ok: false, kind: "unreadable", reason: "the database has no ItemTable" } },
    { name: "a corrupt file", outcome: { kind: "exit", code: 26, stderr: "Error: file is not a database (26)" }, expected: { ok: false, kind: "unreadable", reason: "the database is corrupt or truncated" } },
    { name: "a truncated file", outcome: { kind: "exit", code: 11, stderr: "Error: database disk image is malformed (11)" }, expected: { ok: false, kind: "unreadable", reason: "the database is corrupt or truncated" } },
    { name: "an exit with a message nobody expects", outcome: { kind: "exit", code: 2, stderr: "something secret-looking" }, expected: { ok: false, kind: "unreadable", reason: "sqlite3 exited with code 2" } },
    { name: "a spawn that failed for another reason", outcome: { kind: "exit", code: null, stderr: "" }, expected: { ok: false, kind: "unreadable", reason: "sqlite3 could not be run" } },
    { name: "output that is not JSON", outcome: { kind: "ok", stdout: "this is not json" }, expected: { ok: false, kind: "bad-output", reason: "sqlite3 printed something that is not JSON" } },
    { name: "JSON that is not a list of rows", outcome: { kind: "ok", stdout: '{"value":"[]"}' }, expected: { ok: false, kind: "bad-output" } },
    { name: "a row with no value", outcome: { kind: "ok", stdout: '[{"other":1}]' }, expected: { ok: false, kind: "bad-output" } },
    { name: "a NULL value", outcome: { kind: "ok", stdout: '[{"value":null}]' }, expected: { ok: false, kind: "bad-output" } },
    { name: "a value that is not JSON", outcome: { kind: "ok", stdout: jsonRow("garbage") }, expected: { ok: false, kind: "bad-output" } },
    { name: "a value that is JSON but not a list", outcome: { kind: "ok", stdout: jsonRow('{"a":1}') }, expected: { ok: false, kind: "bad-output" } },
    { name: "no output (the key is not in the table)", outcome: { kind: "ok", stdout: "" }, expected: { ok: true, ids: [], missing: false } },
    { name: "an empty row list", outcome: { kind: "ok", stdout: "[]" }, expected: { ok: true, ids: [], missing: false } },
    { name: "a good list", outcome: { kind: "ok", stdout: idsRow("B.c", "a.d") }, expected: { ok: true, ids: ["a.d", "b.c"], missing: false } },
    { name: "a runner that throws", outcome: () => { throw new Error("boom"); }, expected: "throws" },
  ];

  it.each(cases)("$name", async ({ outcome, expected }) => {
    const mem = new MemFs({ [DB]: "db", [`${DB}-wal`]: "wal", [`${DB}-shm`]: "shm" });
    const a = answering(outcome);
    if (expected === "throws") {
      await expect(read(mem, a.run)).rejects.toThrow("boom");
    } else {
      expect(await read(mem, a.run)).toMatchObject(expected);
    }
    expect(mem.under(TMP).filter((p) => p !== TMP)).toEqual([]); // the temp folder and its copies are gone
    expect(mem.under(path.dirname(DB))).toEqual([DB, `${DB}-shm`, `${DB}-wal`]); // nothing was added next to the originals
    expect([mem.files.get(DB), mem.files.get(`${DB}-wal`), mem.files.get(`${DB}-shm`)]).toEqual(["db", "wal", "shm"]);
  });

  it("the stderr of an unexpected failure is never put in the reason", async () => {
    const mem = new MemFs({ [DB]: "db" });
    const r = await read(mem, answering({ kind: "exit", code: 2, stderr: "Error: password=hunter2" }).run);
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });

  it("a runner that throws makes readDisabledLists answer with a failure instead of throwing", async () => {
    const mem = new MemFs({ [DB]: "db" });
    const r = await readDisabledLists(
      { userDataRoot: "/App/Code - Insiders", vaultPath: "/v", profile: { isDefault: true, dir: "/x" }, tmpRoot: TMP },
      { fs: mem, run: answering(() => { throw new Error("boom"); }).run },
    );
    expect(r).toMatchObject({ ok: false, kind: "unreadable" });
    expect(JSON.stringify(r)).not.toContain("boom");
  });
});

describe("the temp copy", () => {
  it("is made inside the temp root, in a folder of its own, with the -wal and -shm sidecars beside it", async () => {
    const mem = new MemFs({ [DB]: "db", [`${DB}-wal`]: "wal", [`${DB}-shm`]: "shm" });
    const seen: string[] = [];
    await read(mem, async (args) => {
      seen.push(...mem.under(TMP));
      expect(path.dirname(args[2]).startsWith(path.join(TMP, "read-"))).toBe(true);
      return { kind: "ok", stdout: "" };
    });
    const copy = seen.filter((p) => p.endsWith("state.vscdb") || p.endsWith("-wal") || p.endsWith("-shm")).map((p) => path.basename(p)).sort();
    expect(copy).toEqual(["state.vscdb", "state.vscdb-shm", "state.vscdb-wal"]);
    const copies = mem.ops.filter((o) => o.op === "copyFile");
    expect(copies.map((o) => o.path)).toEqual([DB, `${DB}-wal`, `${DB}-shm`]);
  });

  it("a database with no sidecar is copied alone", async () => {
    const mem = new MemFs({ [DB]: "db" });
    await read(mem, answering({ kind: "ok", stdout: "" }).run);
    expect(mem.ops.filter((o) => o.op === "copyFile").map((o) => o.path)).toEqual([DB, `${DB}-wal`, `${DB}-shm`]); // tried, absent, skipped
    expect(mem.writes().every((p) => p.startsWith(TMP))).toBe(true);
  });

  it("a sidecar that cannot be copied (permission denied) fails the read, and the copy is removed", async () => {
    const mem = new MemFs({ [DB]: "db", [`${DB}-wal`]: "wal" });
    mem.failures.set(`${DB}-wal`, "EACCES");
    const a = answering({ kind: "ok", stdout: "" });
    expect(await read(mem, a.run)).toMatchObject({ ok: false, kind: "unreadable" });
    expect(a.calls).toHaveLength(0);
    expect(mem.under(TMP)).toEqual([]);
  });

  it("a database file that is not there is a missing database (not a failure), and sqlite3 is not started", async () => {
    const mem = new MemFs();
    const a = answering({ kind: "ok", stdout: "" });
    expect(await read(mem, a.run)).toEqual({ ok: true, ids: [], missing: true });
    expect(a.calls).toHaveLength(0);
    expect(mem.under(TMP)).toEqual([]);
  });

  it("a temp folder that cannot be made is a failed read", async () => {
    const mem = new MemFs({ [DB]: "db" });
    mem.failNext.set("mkdtemp", "ENOSPC");
    expect(await read(mem, answering({ kind: "ok", stdout: "" }).run)).toMatchObject({ ok: false, kind: "unreadable", reason: expect.stringContaining("ENOSPC") });
  });

  it("two reads at once use two temp folders and do not collide", async () => {
    const mem = new MemFs({ [DB]: "db", "/other/state.vscdb": "db2" });
    const dirs: string[] = [];
    const slow: SqliteRunner = async (args) => {
      dirs.push(path.dirname(args[2]));
      await new Promise((r) => setTimeout(r, 20));
      return { kind: "ok", stdout: idsRow(args[2].includes("000001") ? "first.one" : "second.one") };
    };
    const [a, b] = await Promise.all([readDisabledFromDb(DB, { tmpRoot: TMP, fs: mem, run: slow }), readDisabledFromDb("/other/state.vscdb", { tmpRoot: TMP, fs: mem, run: slow })]);
    expect(new Set(dirs).size).toBe(2);
    expect(a).toMatchObject({ ok: true, ids: ["first.one"] });
    expect(b).toMatchObject({ ok: true, ids: ["second.one"] });
    expect(mem.under(TMP)).toEqual([]);
  });

  it("a cancelled read leaves no temp copy: cancelled before it starts, and cancelled while sqlite3 runs", async () => {
    const mem = new MemFs({ [DB]: "db" });
    const before = new AbortController();
    before.abort();
    const a = answering({ kind: "ok", stdout: "" });
    expect(await read(mem, a.run, { signal: before.signal })).toMatchObject({ ok: false, kind: "cancelled" });
    expect(a.calls).toHaveLength(0);
    expect(mem.ops).toEqual([]);

    const during = new AbortController();
    const running: SqliteRunner = (_args, o) =>
      new Promise((resolve) => {
        expect(o.signal).toBe(during.signal);
        o.signal?.addEventListener("abort", () => resolve({ kind: "aborted" }));
      });
    const pending = read(mem, running, { signal: during.signal });
    await new Promise((r) => setTimeout(r, 10));
    expect(mem.under(TMP).length).toBeGreaterThan(0); // the copy exists while sqlite3 runs
    during.abort();
    expect(await pending).toMatchObject({ ok: false, kind: "cancelled" });
    expect(mem.under(TMP)).toEqual([]);
  });

  it("a cancel that lands while the copy is being made stops before sqlite3 starts", async () => {
    const mem = new MemFs({ [DB]: "db" });
    const abort = new AbortController();
    const original = mem.copyFile.bind(mem);
    mem.copyFile = async (src, dst) => {
      await original(src, dst);
      abort.abort();
    };
    const a = answering({ kind: "ok", stdout: "" });
    expect(await read(mem, a.run, { signal: abort.signal })).toMatchObject({ ok: false, kind: "cancelled" });
    expect(a.calls).toHaveLength(0);
    expect(mem.under(TMP)).toEqual([]);
  });

  it("removes temp folders an earlier killed run left behind when they are old, and keeps recent ones", async () => {
    const mem = new MemFs({ [DB]: "db" });
    const old = path.join(TMP, "read-old");
    const recent = path.join(TMP, "read-recent");
    const other = path.join(TMP, "unrelated");
    for (const d of [old, recent, other]) mem.put(path.join(d, "state.vscdb"), "left over");
    mem.mtimes.set(old, Date.now() - 60 * 60 * 1000);
    mem.mtimes.set(recent, Date.now() - 1000);
    mem.mtimes.set(other, Date.now() - 60 * 60 * 1000);
    await read(mem, answering({ kind: "ok", stdout: "" }).run);
    expect(mem.under(TMP)).toEqual([recent, path.join(recent, "state.vscdb"), other, path.join(other, "state.vscdb")].sort());
  });
});
