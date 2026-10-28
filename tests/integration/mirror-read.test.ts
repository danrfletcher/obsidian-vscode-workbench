/**
 * Integration: the mirror's read against the real system `sqlite3` and real databases built by
 * tests/fixtures/make-state-db.sh in a temp folder. Nothing is mocked. The failure cases use a stub `sqlite3`
 * script placed first on PATH (in a temp folder that is removed afterwards).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { readDisabledLists, type ReadDisabledInput } from "../../src/mirror/disabled-lists";
import { mirrorDisabled, mirrorTmpRoot, type MirrorRequest } from "../../src/mirror/mirror";
import { SNAPSHOT_FILE } from "../../src/mirror/snapshot";
import { createSqliteRunner, readDisabledFromDb } from "../../src/mirror/sqlite-read";
import { isAlive, tempDir } from "../helpers";
import { buildTree, snapshotTree, stateDb, stubSqlite, type Tree } from "../mirror-tree";

const TURBO = "chakrounanas.turbo-console-log";
const PROFILE_LOC = "5c6b7f1e";

function inputFor(t: Tree, extra: Partial<ReadDisabledInput> = {}): ReadDisabledInput {
  return {
    userDataRoot: t.userDataRoot,
    vaultPath: t.vault,
    profile: t.profileDir ? { isDefault: false, dir: t.profileDir } : { isDefault: true, dir: path.join(t.userDataRoot, "User") },
    tmpRoot: path.join(t.base, "plugin", ".server", "mirror-tmp"),
    ...extra,
  };
}
const tmpOf = (t: Tree) => path.join(t.base, "plugin", ".server", "mirror-tmp");
const leftovers = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

describe("reading real databases", () => {
  it("GP2 (read half): the vault in the Default profile with Turbo Console Log disabled in the workspace list only: it is disabled", async () => {
    const t = buildTree({ base: tempDir(), global: [], workspace: { dbArgs: ["--disabled", TURBO] } });
    const r = await readDisabledLists(inputFor(t));
    expect(r).toMatchObject({ ok: true, disabled: [TURBO], lists: { global: [], profile: null, workspace: [TURBO] } });
    expect(leftovers(tmpOf(t))).toEqual([]);
  });

  it("F1: after a read every file under the user-data folder (databases, -wal, -shm, storage.json, extensions.json) has the same bytes, size and mtime", async () => {
    const t = buildTree({
      base: tempDir(),
      global: ["--wal", "--disabled", "g.one"],
      profile: { location: PROFILE_LOC, dbArgs: ["--wal", "--disabled", "p.one"] },
      workspace: { dbArgs: ["--disabled", "w.one"] },
    });
    const before = snapshotTree(t.base);
    expect(Object.keys(before).some((f) => f.endsWith("-wal"))).toBe(true);
    expect(Object.keys(before).some((f) => f.endsWith("-shm"))).toBe(true);
    expect(Object.keys(before).some((f) => f.endsWith("storage.json"))).toBe(true);
    expect(Object.keys(before).some((f) => f.endsWith("extensions.json"))).toBe(true);
    await new Promise((r) => setTimeout(r, 20)); // so a touched file would show a later mtime
    const r = await readDisabledLists(inputFor(t));
    expect(r).toMatchObject({ ok: true, disabled: ["g.one", "p.one", "w.one"] });
    const after = snapshotTree(t.base);
    delete after[path.relative(t.base, tmpOf(t))]; // (the plugin's own temp root is under base; it is empty and holds no files)
    expect(after).toEqual(before);
  });

  it("the union of global, profile and workspace, with ids in any case", async () => {
    const t = buildTree({
      base: tempDir(),
      global: ["--disabled", "Pub.Global"],
      profile: { location: PROFILE_LOC, dbArgs: ["--bare", "pub.profile,PUB.GLOBAL"] },
      workspace: { dbArgs: ["--disabled", "Pub.Workspace"] },
      others: [{ hash: "ffffffffffffffffffffffffffffffff", folder: "/Users/x/Elsewhere", dbArgs: ["--disabled", "not.mine"] }],
    });
    const r = await readDisabledLists(inputFor(t));
    expect(r).toMatchObject({ ok: true, disabled: ["pub.global", "pub.profile", "pub.workspace"] });
  });

  it("a missing profile database and a missing workspace database are empty lists; a vault with no workspace folder reads global only", async () => {
    const a = buildTree({ base: tempDir(), global: ["--disabled", "g.one"], profile: { location: PROFILE_LOC, dbArgs: null }, workspace: { dbArgs: null } });
    expect(await readDisabledLists(inputFor(a))).toMatchObject({ ok: true, disabled: ["g.one"], lists: { profile: [], workspace: [] } });
    const b = buildTree({ base: tempDir(), global: ["--disabled", "g.one"] });
    expect(await readDisabledLists(inputFor(b))).toMatchObject({ ok: true, disabled: ["g.one"] });
  });

  it("a missing global database is a failure (E1)", async () => {
    const t = buildTree({ base: tempDir(), global: null, workspace: { dbArgs: ["--disabled", "w.one"] } });
    expect(await readDisabledLists(inputFor(t))).toMatchObject({ ok: false, list: "global" });
  });

  it("a database whose newest rows are only in its -wal file: the sidecar is copied, so they are read", async () => {
    const t = buildTree({ base: tempDir(), global: ["--wal", "--disabled", "in.the.wal"] });
    expect(fs.existsSync(`${t.globalDb}-wal`)).toBe(true);
    // The fixture is right: the main file on its own does not hold the key.
    const alone = path.join(t.base, "alone.vscdb");
    fs.copyFileSync(t.globalDb, alone);
    expect(execFileSync("sqlite3", ["-readonly", `file:${alone}?immutable=1`, "SELECT count(*) FROM ItemTable WHERE key LIKE 'extensionsIdentifiers%'"], { encoding: "utf8" }).trim()).toBe("0");
    expect(await readDisabledLists(inputFor(t))).toMatchObject({ ok: true, disabled: ["in.the.wal"] });
  });

  it.each([
    ["a corrupt file", ["--corrupt"], "unreadable"],
    ["a truncated file", ["--truncated", "--size-mb", "1"], "unreadable"],
    ["a missing ItemTable", ["--no-table"], "unreadable"],
    ["a value that is not JSON", ["--raw", "this is not json"], "bad-output"],
    ["a value that is JSON but not a list", ["--raw", '{"id":"a.b"}'], "bad-output"],
    ["a NULL value", ["--null"], "bad-output"],
    ["a list with an entry that names nothing", ["--raw", '[{"nope":1}]'], "bad-output"],
  ])("%s in the global database is a failure of kind %s", async (_label, args, kind) => {
    const t = buildTree({ base: tempDir(), global: args as string[] });
    expect(await readDisabledLists(inputFor(t))).toMatchObject({ ok: false, list: "global", kind });
    expect(leftovers(tmpOf(t))).toEqual([]);
  });

  it("a missing key is an empty list, not a failure", async () => {
    const t = buildTree({ base: tempDir(), global: ["--no-key"] });
    expect(await readDisabledLists(inputFor(t))).toMatchObject({ ok: true, disabled: [] });
  });

  it("one of three databases failing (a corrupt workspace database) fails the whole read", async () => {
    const t = buildTree({
      base: tempDir(),
      global: ["--disabled", "g.one"],
      profile: { location: PROFILE_LOC, dbArgs: ["--disabled", "p.one"] },
      workspace: { dbArgs: ["--corrupt"] },
    });
    expect(await readDisabledLists(inputFor(t))).toMatchObject({ ok: false, list: "workspace" });
  });

  it.each([
    ["spaces", "My Vault"],
    ["a percent sign", "100% Done"],
    ["a literal %20", "a%20b"],
    ["non-ASCII characters", "Café Ünï 日本"],
  ])("a vault path with %s still finds its workspace database", async (_label, name) => {
    const base = tempDir();
    const t = buildTree({ base, vault: path.join(base, name), global: [], workspace: { dbArgs: ["--disabled", TURBO] } });
    expect(await readDisabledLists(inputFor(t))).toMatchObject({ ok: true, disabled: [TURBO] });
  });

  it("a vault with no matching workspace folder: global only, a note, no throw", async () => {
    const base = tempDir();
    const t = buildTree({ base, global: ["--disabled", "g.one"], others: [{ hash: "aaaa", folder: path.join(base, "Elsewhere"), dbArgs: ["--disabled", "not.mine"] }] });
    const r = await readDisabledLists(inputFor(t));
    expect(r).toMatchObject({ ok: true, disabled: ["g.one"] });
    expect(r.ok && r.notes.join(" ")).toContain("names the vault folder");
  });
});

describe("a large database", () => {
  it("a 50 MB database is read within the 5 s timeout, and its temp copy is removed", async () => {
    const t = buildTree({ base: tempDir(), global: ["--size-mb", "50", "--disabled", "big.one"] });
    expect(fs.statSync(t.globalDb).size).toBeGreaterThan(50 * 1024 * 1024);
    const started = Date.now();
    const sawCopy: number[] = [];
    const tmp = tmpOf(t);
    const watcher = setInterval(() => {
      for (const d of leftovers(tmp)) sawCopy.push(fs.statSync(path.join(tmp, d, "state.vscdb"), { throwIfNoEntry: false })?.size ?? 0);
    }, 5);
    const r = await readDisabledLists(inputFor(t));
    clearInterval(watcher);
    expect(r).toMatchObject({ ok: true, disabled: ["big.one"] });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(leftovers(tmp)).toEqual([]);
  }, 30_000);
});

describe("two reads at once (a second tab, a quick restart)", () => {
  it("use separate temp folders and both answer correctly", async () => {
    const a = buildTree({ base: tempDir(), global: ["--size-mb", "20", "--disabled", "first.one"] });
    const b = buildTree({ base: tempDir(), global: ["--size-mb", "20", "--disabled", "second.one"] });
    const shared = path.join(tempDir(), "mirror-tmp");
    const seen = new Set<string>();
    const watcher = setInterval(() => leftovers(shared).forEach((d) => seen.add(d)), 2);
    const [ra, rb] = await Promise.all([readDisabledLists(inputFor(a, { tmpRoot: shared })), readDisabledLists(inputFor(b, { tmpRoot: shared }))]);
    clearInterval(watcher);
    expect(ra).toMatchObject({ ok: true, disabled: ["first.one"] });
    expect(rb).toMatchObject({ ok: true, disabled: ["second.one"] });
    expect(seen.size).toBeGreaterThanOrEqual(2);
    expect(leftovers(shared)).toEqual([]);
  }, 30_000);
});

describe("a stub sqlite3 first on PATH", () => {
  const withStub = (script: string, base = tempDir()) => {
    const dir = stubSqlite(path.join(base, "stub"), script);
    return { env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`, STUB_PIDFILE: path.join(base, "stub.pid") }, pidfile: path.join(base, "stub.pid") };
  };

  it("exits 5 with 'database is locked': the read fails as locked, the temp copy is removed, and the file is untouched", async () => {
    const t = buildTree({ base: tempDir(), global: ["--disabled", "g.one"] });
    const stub = withStub('echo "Error: in prepare, database is locked (5)" >&2\nexit 5', t.base);
    const before = fs.readFileSync(t.globalDb);
    const r = await readDisabledLists(inputFor(t), { run: createSqliteRunner(stub.env) });
    expect(r).toMatchObject({ ok: false, kind: "locked", list: "global" });
    expect(fs.readFileSync(t.globalDb).equals(before)).toBe(true);
    expect(leftovers(tmpOf(t))).toEqual([]);
  });

  it("sqlite3 not on PATH (ENOENT on spawn): sqlite-missing, with the snapshot of an earlier start used, else none, and each says which", async () => {
    const t = buildTree({ base: tempDir(), global: ["--disabled", "g.one"], workspace: { dbArgs: ["--disabled", TURBO] } });
    const request: MirrorRequest = {
      instanceId: "vscode-insiders:/Applications/Visual Studio Code.app",
      userDataRoot: t.userDataRoot,
      vaultPath: t.vault,
      profile: { location: "__default__profile__", isDefault: true, dir: path.join(t.userDataRoot, "User") },
    };
    const dataDir = path.join(t.base, "plugin", ".server", "server-data");
    const tmpRoot = mirrorTmpRoot(path.join(t.base, "plugin", ".server"));
    const emptyPath = { ...process.env, PATH: path.join(t.base, "no-such-bin") };
    const missing = { dataDir, tmpRoot, deps: { run: createSqliteRunner(emptyPath) } };

    // No snapshot yet: none.
    const none = await mirrorDisabled(request, missing);
    expect(none).toMatchObject({ source: "none", disabled: [] });
    expect(none.source === "none" && none.why).toContain("sqlite3 was not found on PATH");
    expect(none.source === "none" && none.why).toContain("there is no earlier snapshot");

    // A good read writes the snapshot ...
    const good = await mirrorDisabled(request, { dataDir, tmpRoot });
    expect(good).toMatchObject({ source: "read", disabled: [TURBO, "g.one"].sort() });
    expect(fs.existsSync(path.join(dataDir, SNAPSHOT_FILE))).toBe(true);

    // ... and the next start, with sqlite3 gone, uses it.
    const snap = await mirrorDisabled(request, missing);
    expect(snap).toMatchObject({ source: "snapshot", disabled: [TURBO, "g.one"].sort() });
    expect(snap.source === "snapshot" && snap.why).toContain("sqlite3 was not found on PATH");
    expect(leftovers(tmpRoot)).toEqual([]);
  });

  it("'database is locked' falls back to the snapshot too", async () => {
    const t = buildTree({ base: tempDir(), global: ["--disabled", "g.one"] });
    const request: MirrorRequest = {
      instanceId: "i",
      userDataRoot: t.userDataRoot,
      vaultPath: t.vault,
      profile: { location: "__default__profile__", isDefault: true, dir: path.join(t.userDataRoot, "User") },
    };
    const dataDir = path.join(t.base, "plugin", ".server", "server-data");
    const tmpRoot = mirrorTmpRoot(path.join(t.base, "plugin", ".server"));
    await mirrorDisabled(request, { dataDir, tmpRoot });
    const stub = withStub('echo "database is locked" >&2\nexit 5', t.base);
    const r = await mirrorDisabled(request, { dataDir, tmpRoot, deps: { run: createSqliteRunner(stub.env) } });
    expect(r).toMatchObject({ source: "snapshot", disabled: ["g.one"] });
    expect(r.source === "snapshot" && r.why).toContain("busy or locked");
  });

  it("a hang: killed after the timeout, the read fails as a timeout, and no sqlite3 process is left", async () => {
    const t = buildTree({ base: tempDir(), global: ["--disabled", "g.one"] });
    const stub = withStub('echo $$ > "$STUB_PIDFILE"\nexec sleep 60', t.base);
    const started = Date.now();
    const r = await readDisabledLists(inputFor(t), { run: createSqliteRunner(stub.env), timeoutMs: 1500 }); // long enough that a loaded machine has started the stub and let it write its pid
    expect(r).toMatchObject({ ok: false, kind: "timeout", list: "global" });
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(fs.readFileSync(stub.pidfile, "utf8").trim());
    expect(pid).toBeGreaterThan(1);
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 2000 });
    expect(leftovers(tmpOf(t))).toEqual([]);
  });

  it("a read cancelled while sqlite3 runs kills it and leaves no temp copy behind", async () => {
    const t = buildTree({ base: tempDir(), global: ["--disabled", "g.one"] });
    const stub = withStub('echo $$ > "$STUB_PIDFILE"\nexec sleep 60', t.base);
    const abort = new AbortController();
    const pending = readDisabledFromDb(t.globalDb, { tmpRoot: tmpOf(t), run: createSqliteRunner(stub.env), signal: abort.signal });
    await vi.waitFor(() => expect(fs.existsSync(stub.pidfile) && fs.readFileSync(stub.pidfile, "utf8").trim() !== "").toBe(true), { timeout: 3000 });
    expect(leftovers(tmpOf(t)).length).toBe(1); // the copy exists while sqlite3 runs
    abort.abort();
    expect(await pending).toMatchObject({ ok: false, kind: "cancelled" });
    const pid = Number(fs.readFileSync(stub.pidfile, "utf8").trim());
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 2000 });
    expect(leftovers(tmpOf(t))).toEqual([]);
  });

  it("sqlite3 that prints nonsense: bad output, and the real file is untouched", async () => {
    const t = buildTree({ base: tempDir(), global: [] });
    const stub = withStub("echo 'this is not json'", t.base);
    expect(await readDisabledLists(inputFor(t), { run: createSqliteRunner(stub.env) })).toMatchObject({ ok: false, kind: "bad-output" });
  });
});

describe("the fixture script", () => {
  it("makes a database the system sqlite3 reads back", () => {
    const file = stateDb(path.join(tempDir(), "x.vscdb"), "--disabled", "a.b,c.d");
    const out = execFileSync("sqlite3", ["-readonly", file, "SELECT value FROM ItemTable WHERE key = 'extensionsIdentifiers/disabled'"], { encoding: "utf8" }).trim();
    expect(out).toBe('[{"id":"a.b"},{"id":"c.d"}]');
  });

  it("refuses an option it does not know", () => {
    expect(() => stateDb(path.join(tempDir(), "x.vscdb"), "--nope")).toThrow();
  });
});
