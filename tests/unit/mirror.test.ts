import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { globalDbPath } from "../../src/mirror/disabled-lists";
import { mirrorDisabled, mirrorTmpRoot, type MirrorRequest } from "../../src/mirror/mirror";
import { SNAPSHOT_FILE } from "../../src/mirror/snapshot";
import { MemFs, idsRow, scriptedRunner, type Answer } from "../mirror-fakes";

const ROOT = "/App/Code - Insiders";
const GLOBAL = globalDbPath(ROOT);
const DATA = "/Plugin/.server/server-data";
const TMP = mirrorTmpRoot("/Plugin/.server");
const SNAPFILE = path.join(DATA, SNAPSHOT_FILE);
const REQ: Exclude<MirrorRequest, { unavailable: string }> = {
  instanceId: "vscode-insiders:/Applications/Visual Studio Code.app",
  userDataRoot: ROOT,
  vaultPath: "/Users/x/Notes",
  profile: { location: "__default__profile__", isDefault: true, dir: path.join(ROOT, "User") },
};

function setup(answers: Record<string, Answer>, files: Record<string, string> = {}) {
  // The vault has a workspace-storage folder (with no database yet), so a good read has no notes.
  const workspace = path.join(ROOT, "User", "workspaceStorage", "abc123", "workspace.json");
  const mem = new MemFs({ [GLOBAL]: "db", [workspace]: JSON.stringify({ folder: "file:///Users/x/Notes" }), ...files });
  const runner = scriptedRunner(mem, answers);
  const opts = (extra: object = {}) => ({ dataDir: DATA, tmpRoot: TMP, deps: { fs: mem, run: runner.run, now: () => 1_800_000_000_000 }, ...extra });
  return { mem, runner, opts };
}

describe("mirrorDisabled: read, snapshot or none", () => {
  it("a good read: source read, the ids, the counts, and a snapshot written for the next start", async () => {
    const s = setup({ [GLOBAL]: idsRow("A.b") });
    const r = await mirrorDisabled(REQ, s.opts());
    expect(r).toEqual({ source: "read", disabled: ["a.b"], counts: { global: 1, profile: null, workspace: 0 }, notes: [], at: 1_800_000_000_000 });
    expect(JSON.parse(s.mem.files.get(SNAPFILE) as string)).toEqual({
      version: 1,
      instanceId: REQ.instanceId,
      profileLocation: "__default__profile__",
      vaultPath: "/Users/x/Notes",
      takenAt: 1_800_000_000_000,
      disabled: ["a.b"],
    });
  });

  it("a failed read with a snapshot for this instance, profile and vault: the snapshot is used, with why the read failed", async () => {
    const good = setup({ [GLOBAL]: idsRow("a.b") });
    await mirrorDisabled(REQ, good.opts());
    const files = { [SNAPFILE]: good.mem.files.get(SNAPFILE) as string };
    const s = setup({ [GLOBAL]: { kind: "missing" } }, files);
    const r = await mirrorDisabled(REQ, s.opts());
    expect(r).toEqual({ source: "snapshot", disabled: ["a.b"], takenAt: 1_800_000_000_000, why: "the disabled list could not be read (the global list: sqlite3 was not found on PATH)" });
    expect(JSON.parse(s.mem.files.get(SNAPFILE) as string).disabled).toEqual(["a.b"]); // a failed read does not touch the snapshot
  });

  it("a failed read with no snapshot: none, no extensions are shared, and why", async () => {
    const s = setup({ [GLOBAL]: { kind: "exit", code: 5, stderr: "database is locked" } });
    const r = await mirrorDisabled(REQ, s.opts());
    expect(r).toEqual({
      source: "none",
      disabled: [],
      why: "the disabled list could not be read (the global list: the database is busy or locked); there is no earlier snapshot",
    });
    expect(s.mem.files.has(SNAPFILE)).toBe(false);
  });

  it("a failed read with a snapshot for another instance, profile or vault counts as none", async () => {
    const good = setup({ [GLOBAL]: idsRow("a.b") });
    await mirrorDisabled(REQ, good.opts());
    const files = { [SNAPFILE]: good.mem.files.get(SNAPFILE) as string };
    for (const [label, req] of [
      ["instance", { ...REQ, instanceId: "vscode:/Applications/Visual Studio Code.app" }],
      ["profile", { ...REQ, profile: { ...REQ.profile, location: "5c6b7f1e", isDefault: false } }],
      ["vault", { ...REQ, vaultPath: "/Users/x/Elsewhere" }],
    ] as const) {
      const s = setup({ [GLOBAL]: { kind: "timeout" } }, files);
      const r = await mirrorDisabled(req, s.opts());
      expect(r.source, label).toBe("none");
      expect(r.source === "none" && r.why, label).toContain(`another ${label === "instance" ? "VS Code instance" : label}`);
    }
  });

  it("a failed read after a failed read still falls back to the same good snapshot", async () => {
    const good = setup({ [GLOBAL]: idsRow("a.b") });
    await mirrorDisabled(REQ, good.opts());
    const s = setup({ [GLOBAL]: { kind: "timeout" } }, { [SNAPFILE]: good.mem.files.get(SNAPFILE) as string });
    expect((await mirrorDisabled(REQ, s.opts())).source).toBe("snapshot");
    expect((await mirrorDisabled(REQ, s.opts())).source).toBe("snapshot");
  });

  it("a read that works but whose snapshot cannot be saved still reports the read, with a note", async () => {
    const s = setup({ [GLOBAL]: idsRow("a.b") });
    s.mem.failNext.set("writeFile", "ENOSPC");
    const r = await mirrorDisabled(REQ, s.opts());
    expect(r).toMatchObject({ source: "read", disabled: ["a.b"] });
    expect(r.source === "read" && r.notes).toEqual(["the snapshot for the next start could not be saved"]);
  });

  it("the instance or profile cannot be located: none, with the reason, and nothing is read", async () => {
    const s = setup({});
    const r = await mirrorDisabled({ unavailable: "the user-data folder of this custom VS Code cannot be told" }, s.opts());
    expect(r).toEqual({ source: "none", disabled: [], why: "desktop VS Code's state cannot be located (the user-data folder of this custom VS Code cannot be told)" });
    expect(s.mem.ops).toEqual([]);
    expect(s.runner.calls).toEqual([]);
  });

  it("a cancelled read is none and uses no snapshot", async () => {
    const good = setup({ [GLOBAL]: idsRow("a.b") });
    await mirrorDisabled(REQ, good.opts());
    const s = setup({}, { [SNAPFILE]: good.mem.files.get(SNAPFILE) as string });
    const abort = new AbortController();
    abort.abort();
    const r = await mirrorDisabled(REQ, s.opts({ signal: abort.signal }));
    expect(r.source).toBe("none");
    expect(r.source === "none" && r.why).toContain("cancelled");
    expect(s.mem.under(TMP)).toEqual([]);
  });

  it("never throws, even when everything under it does", async () => {
    const mem = new MemFs();
    const r = await mirrorDisabled(REQ, {
      dataDir: DATA,
      tmpRoot: TMP,
      deps: {
        fs: new Proxy(mem, { get: () => () => { throw new Error("boom"); } }) as unknown as MemFs,
        run: () => { throw new Error("boom"); },
      },
    });
    expect(r.source).toBe("none");
    expect(JSON.stringify(r)).not.toContain("boom");
  });

  it("the only paths it writes are under the temp root and the data dir", async () => {
    const s = setup({ [GLOBAL]: idsRow("a.b") });
    await mirrorDisabled(REQ, s.opts());
    for (const p of s.mem.writes()) expect(p.startsWith(TMP + path.sep) || p === TMP || p.startsWith(DATA + path.sep) || p === DATA, p).toBe(true);
  });
});
