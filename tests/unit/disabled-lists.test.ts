import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { findWorkspaceDbs, globalDbPath, isDisabled, profileDbPath, readDisabledLists, type DisabledListsResult, type ReadDisabledInput } from "../../src/mirror/disabled-lists";
import { parseDisabledValue } from "../../src/mirror/sqlite-read";
import { MemFs, idsRow, jsonRow, scriptedRunner, type Answer } from "../mirror-fakes";
import { vscodeFolderUri } from "../fixtures/make-fake-user-data.mjs";

/**
 * The combination rule of the disabled lists (G1), through the real `readDisabledLists` and the real
 * `readDisabledFromDb` under it. Only the file system and `sqlite3` are replaced: an in-memory file system, and a
 * runner that answers by the database a temp copy came from.
 */

const ROOT = "/App/Code - Insiders";
const GLOBAL = globalDbPath(ROOT);
const PROFILE_DIR = path.join(ROOT, "User", "profiles", "5c6b7f1e");
const PROFILE = profileDbPath(PROFILE_DIR);
const WS_ROOT = path.join(ROOT, "User", "workspaceStorage");
const VAULT = "/Users/x/Notes";
const TMP = "/Plugin/.server/mirror-tmp";

interface World {
  /** Database files that exist. */
  dbs: string[];
  /** workspaceStorage folders: name -> the `folder` of its workspace.json (null = no workspace.json). */
  workspaces?: Record<string, string | null>;
  answers: Record<string, Answer>;
}

function run(world: World, input: Partial<ReadDisabledInput> = {}) {
  const mem = new MemFs();
  for (const db of world.dbs) mem.put(db, "db");
  for (const [name, folder] of Object.entries(world.workspaces ?? {})) {
    if (folder !== null) mem.put(path.join(WS_ROOT, name, "workspace.json"), JSON.stringify({ folder }));
    else mem.put(path.join(WS_ROOT, name, "other.txt"), "x");
  }
  const runner = scriptedRunner(mem, world.answers);
  const full: ReadDisabledInput = { userDataRoot: ROOT, vaultPath: VAULT, profile: { isDefault: true, dir: path.join(ROOT, "User") }, tmpRoot: TMP, ...input };
  return { mem, runner, result: readDisabledLists(full, { fs: mem, run: runner.run }) };
}

const ok = (r: DisabledListsResult) => {
  if (!r.ok) throw new Error(`expected a read, got a failure: ${r.reason}`);
  return r;
};

describe("combining the three lists (G1)", () => {
  const WS_DB = path.join(WS_ROOT, "abc123", "state.vscdb");
  const nonDefault = { profile: { isDefault: false, dir: PROFILE_DIR } };

  const cases: Array<{ name: string; world: World; input?: Partial<ReadDisabledInput>; disabled: string[]; lists?: { global: string[]; profile: string[] | null; workspace: string[] } }> = [
    {
      name: "the union of global, profile and workspace",
      world: { dbs: [GLOBAL, PROFILE, WS_DB], workspaces: { abc123: vscodeFolderUri(VAULT) }, answers: { [GLOBAL]: idsRow("g.one"), [PROFILE]: idsRow("p.one"), [WS_DB]: idsRow("w.one") } },
      input: nonDefault,
      disabled: ["g.one", "p.one", "w.one"],
      lists: { global: ["g.one"], profile: ["p.one"], workspace: ["w.one"] },
    },
    {
      name: "an extension named in one list only is disabled (workspace only: the Turbo Console Log case)",
      world: { dbs: [GLOBAL, WS_DB], workspaces: { abc123: vscodeFolderUri(VAULT) }, answers: { [GLOBAL]: idsRow(), [WS_DB]: idsRow("chakrounanas.turbo-console-log") } },
      disabled: ["chakrounanas.turbo-console-log"],
      lists: { global: [], profile: null, workspace: ["chakrounanas.turbo-console-log"] },
    },
    {
      name: "an extension named in two lists appears once",
      world: { dbs: [GLOBAL, PROFILE], answers: { [GLOBAL]: idsRow("a.b", "c.d"), [PROFILE]: idsRow("c.d", "e.f") } },
      input: nonDefault,
      disabled: ["a.b", "c.d", "e.f"],
    },
    {
      name: "ids compare case-insensitively",
      world: { dbs: [GLOBAL, PROFILE], answers: { [GLOBAL]: idsRow("ChakrounAnas.Turbo-Console-Log"), [PROFILE]: idsRow("chakrounanas.turbo-console-log") } },
      input: nonDefault,
      disabled: ["chakrounanas.turbo-console-log"],
    },
    {
      name: "nothing disabled anywhere",
      world: { dbs: [GLOBAL], answers: { [GLOBAL]: idsRow() } },
      disabled: [],
    },
    {
      name: "a key that is not in the global database is an empty list",
      world: { dbs: [GLOBAL], answers: {} },
      disabled: [],
    },
    {
      name: "a missing profile database is an empty list, not a failure",
      world: { dbs: [GLOBAL], answers: { [GLOBAL]: idsRow("g.one") } },
      input: nonDefault,
      disabled: ["g.one"],
      lists: { global: ["g.one"], profile: [], workspace: [] },
    },
    {
      name: "a missing workspace database (the folder is there, the database is not) is an empty list",
      world: { dbs: [GLOBAL], workspaces: { abc123: vscodeFolderUri(VAULT) }, answers: { [GLOBAL]: idsRow("g.one") } },
      disabled: ["g.one"],
    },
    {
      name: "workspace folders that name other folders, or have no workspace.json, are not read",
      world: {
        dbs: [GLOBAL, WS_DB, path.join(WS_ROOT, "other", "state.vscdb"), path.join(WS_ROOT, "bare", "state.vscdb")],
        workspaces: { abc123: vscodeFolderUri(VAULT), other: vscodeFolderUri("/Users/x/Other"), bare: null },
        answers: { [GLOBAL]: idsRow(), [WS_DB]: idsRow("w.one"), [path.join(WS_ROOT, "other", "state.vscdb")]: idsRow("not.mine"), [path.join(WS_ROOT, "bare", "state.vscdb")]: idsRow("not.mine.either") },
      },
      disabled: ["w.one"],
    },
    {
      name: "two workspace folders naming the vault are both read",
      world: {
        dbs: [GLOBAL, WS_DB, path.join(WS_ROOT, "old999", "state.vscdb")],
        workspaces: { abc123: vscodeFolderUri(VAULT), old999: vscodeFolderUri(VAULT) },
        answers: { [GLOBAL]: idsRow(), [WS_DB]: idsRow("w.one"), [path.join(WS_ROOT, "old999", "state.vscdb")]: idsRow("w.two") },
      },
      disabled: ["w.one", "w.two"],
    },
  ];

  it.each(cases)("$name", async ({ world, input, disabled, lists }) => {
    const r = ok(await run(world, input).result);
    expect(r.disabled).toEqual(disabled);
    if (lists) expect(r.lists).toEqual(lists);
  });

  it("a Default profile reads the global database once, not twice; a non-Default profile reads its own as well", async () => {
    const world: World = { dbs: [GLOBAL, PROFILE], answers: { [GLOBAL]: idsRow("g.one"), [PROFILE]: idsRow("p.one") } };
    const def = run(world);
    await def.result;
    expect(def.runner.calls.map((c) => c.source)).toEqual([GLOBAL]);

    const non = run(world, nonDefault);
    await non.result;
    expect(non.runner.calls.map((c) => c.source)).toEqual([GLOBAL, PROFILE]);
  });

  it("isDisabled compares case-insensitively", async () => {
    const r = ok(await run({ dbs: [GLOBAL], answers: { [GLOBAL]: idsRow("Pub.Name") } }).result);
    expect(isDisabled(r, "pub.name")).toBe(true);
    expect(isDisabled(r, "PUB.NAME")).toBe(true);
    expect(isDisabled(r, " pub.name ")).toBe(true);
    expect(isDisabled(r, "pub.other")).toBe(false);
  });
});

describe("failures (E1): the whole read fails when any one database does", () => {
  const WS_DB = path.join(WS_ROOT, "abc123", "state.vscdb");
  const nonDefault = { profile: { isDefault: false, dir: PROFILE_DIR } };
  const base = { dbs: [GLOBAL, PROFILE, WS_DB], workspaces: { abc123: vscodeFolderUri(VAULT) } };
  const fine = { [GLOBAL]: idsRow("g.one"), [PROFILE]: idsRow("p.one"), [WS_DB]: idsRow("w.one") };

  it.each([
    ["global", GLOBAL],
    ["profile", PROFILE],
    ["workspace", WS_DB],
  ] as const)("only the %s database fails while the other two succeed: failed, naming that list", async (list, db) => {
    const r = await run({ ...base, answers: { ...fine, [db]: { kind: "exit", code: 5, stderr: "Error: database is locked" } } }, nonDefault).result;
    expect(r).toMatchObject({ ok: false, list, kind: "locked" });
    expect(r.ok === false && r.reason).toContain(`the ${list} list`);
  });

  it("a missing global database is a failure", async () => {
    const r = await run({ dbs: [], answers: {} }).result;
    expect(r).toMatchObject({ ok: false, list: "global", kind: "unreadable" });
    expect(r.ok === false && r.reason).toContain("missing");
  });

  it("a global database that cannot be copied (permission denied) is a failure", async () => {
    const mem = new MemFs({ [GLOBAL]: "db" });
    mem.failures.set(GLOBAL, "EACCES");
    const r = await readDisabledLists({ userDataRoot: ROOT, vaultPath: VAULT, profile: { isDefault: true, dir: ROOT }, tmpRoot: TMP }, { fs: mem, run: scriptedRunner(mem, {}).run });
    expect(r).toMatchObject({ ok: false, list: "global", kind: "unreadable" });
  });

  it("a value that is not JSON, or JSON but not a list, fails the read", async () => {
    for (const value of ["not json at all", '{"id":"a.b"}', "42", "null"]) {
      const r = await run({ dbs: [GLOBAL], answers: { [GLOBAL]: jsonRow(value) } }).result;
      expect(r, value).toMatchObject({ ok: false, list: "global", kind: "bad-output" });
    }
  });

  it("the workspace storage folder cannot be listed (permission denied): failed, not an empty list", async () => {
    const mem = new MemFs({ [GLOBAL]: "db" });
    mem.failures.set(WS_ROOT, "EACCES");
    const r = await readDisabledLists({ userDataRoot: ROOT, vaultPath: VAULT, profile: { isDefault: true, dir: ROOT }, tmpRoot: TMP }, { fs: mem, run: scriptedRunner(mem, {}).run });
    expect(r).toMatchObject({ ok: false, list: "workspace" });
  });

  it("stops at the first failure: the databases after it are not opened", async () => {
    const w = run({ ...base, answers: { ...fine, [GLOBAL]: { kind: "missing" } } }, nonDefault);
    expect(await w.result).toMatchObject({ ok: false, kind: "sqlite-missing", list: "global" });
    expect(w.runner.calls).toHaveLength(1);
  });

  it("never throws: a file system that fails in an unexpected way is a failed read", async () => {
    class Broken extends MemFs {
      override copyFile(): Promise<void> {
        throw new Error("sync boom"); // thrown, not rejected
      }
    }
    const mem = new Broken({ [GLOBAL]: "db" });
    const r = await readDisabledLists({ userDataRoot: ROOT, vaultPath: VAULT, profile: { isDefault: true, dir: ROOT }, tmpRoot: TMP }, { fs: mem, run: scriptedRunner(mem, {}).run });
    expect(r).toMatchObject({ ok: false, kind: "unreadable" });
    expect(mem.under(TMP)).toEqual([]);
  });
});

describe("finding the workspace database by matching workspace.json to the vault URI (G15, E10)", () => {
  const find = (vault: string, workspaces: Record<string, string>) => {
    const mem = new MemFs();
    for (const [name, folder] of Object.entries(workspaces)) mem.put(path.join(WS_ROOT, name, "workspace.json"), JSON.stringify({ folder }));
    return findWorkspaceDbs(ROOT, vault, mem);
  };
  const names = (r: Awaited<ReturnType<typeof find>>) => (r.ok ? r.dbs.map((d) => path.basename(path.dirname(d))) : r.reason);

  it.each([
    ["spaces", "/Users/x/My Vault"],
    ["a percent sign", "/Users/x/100% Done"],
    ["a literal %20 in a folder name", "/Users/x/a%20b"],
    ["non-ASCII characters", "/Users/x/Café Ünï 日本"],
    ["a trailing slash on the vault", "/Users/x/My Vault/"],
  ])("a vault path with %s still finds its database", async (_label, vault) => {
    const r = await find(vault, { other: vscodeFolderUri("/Users/x/Other"), hash1: vscodeFolderUri(vault.replace(/\/$/, "")) });
    expect(names(r)).toEqual(["hash1"]);
    expect(r.ok && r.note).toBeNull();
  });

  it("matches a folder URI written with lower-case escapes or decomposed accents", async () => {
    const decomposed = "file:///Users/x/Cafe\u0301";
    expect(names(await find("/Users/x/Caf\u00e9", { h: decomposed }))).toEqual(["h"]);
    expect(names(await find("/Users/x/My Vault", { h: "file:///Users/x/My%20Vault" }))).toEqual(["h"]);
    expect(names(await find("/Users/x/Caf\u00e9", { h: "file:///Users/x/Caf%c3%a9" }))).toEqual(["h"]);
  });

  it("does not recompute VS Code's folder hash: the folder's name is irrelevant", async () => {
    expect(names(await find(VAULT, { "not-a-hash-at-all": vscodeFolderUri(VAULT) }))).toEqual(["not-a-hash-at-all"]);
  });

  it("no match: an empty list, a note naming the URI that was tried, and no throw", async () => {
    const r = await find("/Users/x/My Vault", { h: vscodeFolderUri("/Users/x/Elsewhere") });
    expect(r).toMatchObject({ ok: true, dbs: [] });
    expect(r.ok && r.note).toContain("file:///Users/x/My Vault");
  });

  it("a folder that only shares a prefix with the vault is not a match", async () => {
    expect(names(await find("/Users/x/Notes", { h: vscodeFolderUri("/Users/x/Notes 2"), i: vscodeFolderUri("/Users/x/Notes/sub") }))).toEqual([]);
  });

  it("no workspaceStorage folder at all: an empty list with a note", async () => {
    const r = await findWorkspaceDbs(ROOT, VAULT, new MemFs());
    expect(r).toMatchObject({ ok: true, dbs: [] });
    expect(r.ok && r.note).toContain("no workspace storage yet");
  });

  it("a workspace.json that is not JSON, or has no folder, is passed over", async () => {
    const mem = new MemFs({ [path.join(WS_ROOT, "bad", "workspace.json")]: "{ nope", [path.join(WS_ROOT, "nofolder", "workspace.json")]: "{}", [path.join(WS_ROOT, "num", "workspace.json")]: '{"folder": 3}' });
    mem.put(path.join(WS_ROOT, "good", "workspace.json"), JSON.stringify({ folder: vscodeFolderUri(VAULT) }));
    const r = await findWorkspaceDbs(ROOT, VAULT, mem);
    expect(names(r)).toEqual(["good"]);
  });

  it("through readDisabledLists: a vault with no workspace match reads global only and says so in the notes", async () => {
    const w = run({ dbs: [GLOBAL], workspaces: { h: vscodeFolderUri("/Users/x/Elsewhere") }, answers: { [GLOBAL]: idsRow("g.one") } });
    const r = ok(await w.result);
    expect(r.disabled).toEqual(["g.one"]);
    expect(r.notes.join(" ")).toContain("names the vault folder");
  });
});

describe("parsing the stored value", () => {
  it.each([
    ["an array of {id} objects (the form VS Code writes)", '[{"id":"A.b"},{"id":"c.D"}]', ["a.b", "c.d"]],
    ["objects that also carry a uuid", '[{"id":"a.b","uuid":"1234"}]', ["a.b"]],
    ["bare strings", '["a.b","C.d"]', ["a.b", "c.d"]],
    ["a mix of both", '["a.b",{"id":"c.d"}]', ["a.b", "c.d"]],
    ["an empty array", "[]", []],
    ["duplicates, spaces and case", '[{"id":" A.B "},"a.b"]', ["a.b"]],
  ])("%s", (_label, text, ids) => {
    expect(parseDisabledValue(text)).toEqual({ ok: true, ids });
  });

  it.each([
    ["not JSON", "garbage", "not JSON"],
    ["an empty string", "", "not JSON"],
    ["a JSON object", '{"id":"a.b"}', "not a list"],
    ["a JSON number", "7", "not a list"],
    ["JSON null", "null", "not a list"],
    ["an entry without an id", '[{"name":"a.b"}]', "names no extension"],
    ["an entry that is a number", "[3]", "names no extension"],
    ["an entry with an empty id", '[{"id":" "}]', "names no extension"],
    ["null inside the list", "[null]", "names no extension"],
  ])("%s is a failure, and the text is never quoted", (_label, text, reason) => {
    const r = parseDisabledValue(text);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain(reason);
    if (text.length > 3 && !r.ok) expect(r.reason).not.toContain(text);
  });
});
