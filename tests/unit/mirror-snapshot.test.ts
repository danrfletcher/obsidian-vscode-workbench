import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SNAPSHOT_FILE, SNAPSHOT_VERSION, readSnapshot, writeSnapshot, type MirrorSnapshot, type SnapshotOwner } from "../../src/mirror/snapshot";
import { MemFs } from "../mirror-fakes";
import { tempDir } from "../helpers";

const DIR = "/Plugin/.server/server-data";
const FILE = path.join(DIR, SNAPSHOT_FILE);
const OWNER: SnapshotOwner = { instanceId: "vscode-insiders:/Applications/Visual Studio Code.app", profileLocation: "__default__profile__", vaultPath: "/Users/x/Notes" };
const SNAP: MirrorSnapshot = { version: SNAPSHOT_VERSION, ...OWNER, takenAt: 1_800_000_000_000, disabled: ["a.b", "c.d"] };

describe("write and read back", () => {
  it("with the real file system: what was written is read back, and the file is mode 0600", async () => {
    const dir = path.join(tempDir(), "server-data");
    await writeSnapshot(dir, SNAP);
    expect(await readSnapshot(dir, OWNER)).toEqual({ status: "found", snapshot: SNAP });
    expect(fs.readdirSync(dir)).toEqual([SNAPSHOT_FILE]); // no temp file is left
    expect(fs.statSync(path.join(dir, SNAPSHOT_FILE)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(path.join(dir, SNAPSHOT_FILE), "utf8"))).toEqual(SNAP);
  });

  it("a second write replaces the first", async () => {
    const dir = tempDir();
    await writeSnapshot(dir, SNAP);
    await writeSnapshot(dir, { ...SNAP, takenAt: SNAP.takenAt + 1, disabled: ["z.z"] });
    expect(await readSnapshot(dir, OWNER)).toMatchObject({ status: "found", snapshot: { takenAt: SNAP.takenAt + 1, disabled: ["z.z"] } });
    expect(fs.readdirSync(dir)).toEqual([SNAPSHOT_FILE]);
  });

  it("creates the data dir when it does not exist yet", async () => {
    const dir = path.join(tempDir(), "a", "b");
    await writeSnapshot(dir, SNAP);
    expect(fs.existsSync(path.join(dir, SNAPSHOT_FILE))).toBe(true);
  });

  it("the vault path compares in normalised form: a trailing slash or a file URI is the same vault", async () => {
    const mem = new MemFs();
    await writeSnapshot(DIR, SNAP, mem);
    for (const vaultPath of ["/Users/x/Notes/", "file:///Users/x/Notes"]) {
      expect(await readSnapshot(DIR, { ...OWNER, vaultPath }, mem), vaultPath).toMatchObject({ status: "found" });
    }
  });
});

describe("the write is atomic: a temp name, then a rename", () => {
  it("writes a temp file in the same folder first, then renames it onto mirror-snapshot.json; the real name is never written directly", async () => {
    const mem = new MemFs();
    await writeSnapshot(DIR, SNAP, mem);
    const writes = mem.ops.filter((o) => o.op === "writeFile");
    const renames = mem.ops.filter((o) => o.op === "rename");
    expect(writes).toHaveLength(1);
    expect(renames).toHaveLength(1);
    expect(path.dirname(writes[0].path)).toBe(DIR);
    expect(writes[0].path).not.toBe(FILE);
    expect(path.basename(writes[0].path)).toMatch(/^mirror-snapshot\.json\..+\.tmp$/);
    expect(renames[0]).toMatchObject({ path: writes[0].path, to: FILE });
    expect(mem.ops.findIndex((o) => o.op === "writeFile")).toBeLessThan(mem.ops.findIndex((o) => o.op === "rename"));
    expect([...mem.files.keys()]).toEqual([FILE]);
  });

  it("a start killed mid-write (the write fails part-way) leaves the earlier snapshot whole and no temp file", async () => {
    const mem = new MemFs();
    await writeSnapshot(DIR, SNAP, mem);
    mem.failNext.set("writeFile", "ENOSPC");
    await expect(writeSnapshot(DIR, { ...SNAP, disabled: ["new.one"] }, mem)).rejects.toThrow();
    expect(JSON.parse(mem.files.get(FILE) as string)).toEqual(SNAP);
    expect(mem.under(DIR)).toEqual([FILE]);
  });

  it("a rename that fails leaves the earlier snapshot whole and removes the temp file", async () => {
    const mem = new MemFs();
    await writeSnapshot(DIR, SNAP, mem);
    mem.failNext.set("rename", "EXDEV");
    await expect(writeSnapshot(DIR, { ...SNAP, disabled: ["new.one"] }, mem)).rejects.toThrow();
    expect(JSON.parse(mem.files.get(FILE) as string)).toEqual(SNAP);
    expect(mem.under(DIR)).toEqual([FILE]);
  });

  it("with no earlier snapshot, a failed write leaves nothing at the real name", async () => {
    const mem = new MemFs();
    mem.failNext.set("writeFile", "EIO");
    await expect(writeSnapshot(DIR, SNAP, mem)).rejects.toThrow();
    expect(mem.files.has(FILE)).toBe(false);
    expect((await readSnapshot(DIR, OWNER, mem)).status).toBe("none");
  });
});

describe("a snapshot that must be ignored counts as none", () => {
  const put = (value: unknown) => new MemFs({ [FILE]: typeof value === "string" ? value : JSON.stringify(value) });

  it("no file", async () => {
    expect(await readSnapshot(DIR, OWNER, new MemFs())).toEqual({ status: "none", why: "there is no earlier snapshot" });
  });

  it("a file that cannot be read", async () => {
    const mem = put(SNAP);
    mem.failures.set(FILE, "EACCES");
    expect(await readSnapshot(DIR, OWNER, mem)).toEqual({ status: "none", why: "the earlier snapshot could not be read" });
  });

  it.each([
    ["another instance", { instanceId: "vscode:/Applications/Visual Studio Code.app" }, "another VS Code instance"],
    ["another profile", { profileLocation: "5c6b7f1e" }, "another profile"],
    ["another vault", { vaultPath: "/Users/x/Other" }, "another vault"],
  ])("a snapshot for %s", async (_label, change, why) => {
    const r = await readSnapshot(DIR, OWNER, put({ ...SNAP, ...change }));
    expect(r.status).toBe("none");
    expect(r.status === "none" && r.why).toContain(why);
  });

  it("the same profile and vault under another instance is still ignored", async () => {
    expect((await readSnapshot(DIR, { ...OWNER, instanceId: "custom" }, put(SNAP))).status).toBe("none");
  });

  it("a corrupt file (not JSON, truncated, empty)", async () => {
    for (const text of ["not json", JSON.stringify(SNAP).slice(0, 40), ""]) {
      expect(await readSnapshot(DIR, OWNER, put(text)), text).toEqual({ status: "none", why: "the earlier snapshot is corrupt" });
    }
  });

  it("JSON that is not a snapshot", async () => {
    for (const value of [[], null, 5, { version: SNAPSHOT_VERSION }]) {
      expect((await readSnapshot(DIR, OWNER, put(value))).status, JSON.stringify(value)).toBe("none");
    }
    for (const bad of [{ disabled: "a.b" }, { disabled: [1] }, { takenAt: "yesterday" }, { instanceId: 4 }]) {
      expect((await readSnapshot(DIR, OWNER, put({ ...SNAP, ...bad }))).status, JSON.stringify(bad)).toBe("none");
    }
  });

  it("an unknown version, older or newer", async () => {
    for (const version of [0, 2, "1", null]) {
      const r = await readSnapshot(DIR, OWNER, put({ ...SNAP, version }));
      expect(r, String(version)).toEqual({ status: "none", why: "the earlier snapshot has a version this plugin does not know" });
    }
    expect((await readSnapshot(DIR, OWNER, put({ ...SNAP, version: SNAPSHOT_VERSION }))).status).toBe("found");
  });

  it("a snapshot file written in the version-1 form on disk is exactly this shape (a hand-written copy, not built from the constant)", async () => {
    const literal = '{"version":1,"instanceId":"i","profileLocation":"p","vaultPath":"/v","takenAt":5,"disabled":["a.b"]}';
    expect(await readSnapshot(DIR, { instanceId: "i", profileLocation: "p", vaultPath: "/v" }, put(literal))).toEqual({
      status: "found",
      snapshot: { version: 1, instanceId: "i", profileLocation: "p", vaultPath: "/v", takenAt: 5, disabled: ["a.b"] },
    });
  });
});
