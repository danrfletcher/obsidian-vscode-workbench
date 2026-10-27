/**
 * The pidfile and the orphan sweep (E11, E5): write, read, sweep, stale and
 * reused pids, corrupt files. Process listing and signalling are mocked; the
 * real processes are exercised in tests/integration/orphan-sweep.test.ts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { PidFile, sweepOrphans, type PidEntry, type SweepDeps } from "../../src/pidfile";
import { tempDir } from "../helpers";

const VAULT = "/Users/dan/Mock Exams/ünïcode dir/文件 vault";

function entry(over: Partial<PidEntry> = {}): PidEntry {
  return { pid: 41001, label: "vscode-server", match: "serve-web", startedAt: 1, workspace: VAULT, group: true, ...over };
}

/** A fake process table. `commands` maps pid -> command line; signals are recorded and can be made to stick. */
function fakeDeps(commands: Record<number, string>, opts: { children?: Record<number, number[]>; ignoreTerm?: number[] } = {}) {
  const alive = new Set(Object.keys(commands).map(Number));
  const signals: Array<{ pid: number; sig: string; group: boolean }> = [];
  const deps: SweepDeps = {
    commandOf: (pid) => (alive.has(pid) ? commands[pid] : null),
    descendants: (pid) => opts.children?.[pid] ?? [],
    pidsMatching: (marker) => [...alive].filter((pid) => commands[pid]?.includes(marker) && pid !== 999),
    signal: (pid, sig) => {
      signals.push({ pid, sig, group: false });
      if (sig === "SIGKILL" || !opts.ignoreTerm?.includes(pid)) alive.delete(pid);
    },
    signalGroup: (pgid, sig) => {
      signals.push({ pid: pgid, sig, group: true });
    },
    isAlive: (pid) => alive.has(pid),
    sleep: async () => undefined,
    protectedPids: [999],
  };
  return { deps, signals, alive };
}

describe("PidFile", () => {
  it("round-trips an entry whose workspace has spaces and non-ASCII characters (E5)", () => {
    const file = new PidFile(path.join(tempDir(), "sub dir", "pids.json"));
    file.add(entry());
    expect(file.read()).toEqual({ entries: [entry()], corrupt: false });
    // the file itself is UTF-8 JSON, not an escaped or lossy form
    expect(fs.readFileSync(file.file, "utf8")).toContain("ünïcode dir/文件 vault");
  });

  it("is private to the user (mode 0600) and holds no token field", () => {
    const file = new PidFile(path.join(tempDir(), "pids.json"));
    file.add(entry());
    expect(fs.statSync(file.file).mode & 0o777).toBe(0o600);
    expect(Object.keys(file.read().entries[0]).sort()).toEqual(["group", "label", "match", "pid", "startedAt", "workspace"]);
  });

  it("add replaces the entry for the same pid; removePid drops one; the last removal deletes the file", () => {
    const file = new PidFile(path.join(tempDir(), "pids.json"));
    file.add(entry({ pid: 41001 }));
    file.add(entry({ pid: 41002, label: "shell", match: "pty" }));
    file.add(entry({ pid: 41001, label: "replaced" }));
    expect(file.read().entries.map((e) => [e.pid, e.label])).toEqual([[41002, "shell"], [41001, "replaced"]]);
    file.removePid(41001);
    expect(file.read().entries.map((e) => e.pid)).toEqual([41002]);
    file.removePid(41002);
    expect(fs.existsSync(file.file)).toBe(false);
  });

  it("reads a missing file as empty and not corrupt", () => {
    expect(new PidFile(path.join(tempDir(), "none.json")).read()).toEqual({ entries: [], corrupt: false });
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["an object instead of a list", '{"pid": 41001}'],
    ["an empty file", ""],
  ])("treats %s as corrupt with no entries", (_name, text) => {
    const f = path.join(tempDir(), "pids.json");
    fs.writeFileSync(f, text);
    expect(new PidFile(f).read()).toEqual({ entries: [], corrupt: true });
  });

  it("keeps the good entries of a list that also holds bad ones, and flags it corrupt", () => {
    const f = path.join(tempDir(), "pids.json");
    fs.writeFileSync(
      f,
      JSON.stringify([entry(), { pid: "7", match: "x" }, { pid: 1, match: "x" }, { pid: -5, match: "x" }, { pid: 3.5, match: "x" }, { pid: 42, match: "" }, null, 7]),
    );
    const r = new PidFile(f).read();
    expect(r.entries).toEqual([entry()]);
    expect(r.corrupt).toBe(true);
  });
});

describe("sweepOrphans", () => {
  const cmd = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code serve-web --host 127.0.0.1 --port 5000";

  function setup(entries: PidEntry[]) {
    const f = path.join(tempDir(), "pids.json");
    const pf = new PidFile(f);
    for (const e of entries) pf.add(e);
    return f;
  }

  it("kills a leftover server whose command line still matches serve-web, with its descendants and group, then removes the pidfile", async () => {
    const f = setup([entry()]);
    const { deps, signals, alive } = fakeDeps({ 41001: cmd, 41002: "node server-main.js", 41003: "code-tunnel serve-web" }, { children: { 41001: [41002, 41003] } });
    const r = await sweepOrphans(f, deps, 0);
    expect(r.killed.map((e) => e.pid)).toEqual([41001]);
    expect([...alive]).toEqual([]);
    expect(signals.filter((s) => s.group)).toEqual([
      { pid: 41001, sig: "SIGTERM", group: true },
      { pid: 41001, sig: "SIGKILL", group: true },
    ]);
    expect(signals.filter((s) => !s.group && s.sig === "SIGTERM").map((s) => s.pid)).toEqual([41001, 41002, 41003]);
    expect(fs.existsSync(f)).toBe(false);
  });

  it("escalates to SIGKILL for a process that ignores SIGTERM", async () => {
    const f = setup([entry()]);
    const { deps, signals, alive } = fakeDeps({ 41001: cmd }, { ignoreTerm: [41001] });
    await sweepOrphans(f, deps, 0);
    expect(signals.some((s) => s.pid === 41001 && s.sig === "SIGKILL" && !s.group)).toBe(true);
    expect(alive.has(41001)).toBe(false);
  });

  it("does not signal a pid that now belongs to another program, and drops its entry (E11)", async () => {
    const f = setup([entry({ pid: 41001 })]);
    const { deps, signals, alive } = fakeDeps({ 41001: "/usr/bin/vim notes.md" });
    const r = await sweepOrphans(f, deps, 0);
    expect(r.reused.map((e) => e.pid)).toEqual([41001]);
    expect(r.killed).toEqual([]);
    expect(signals).toEqual([]);
    expect(alive.has(41001)).toBe(true);
    expect(fs.existsSync(f)).toBe(false);
  });

  it("drops a stale entry whose process is gone without signalling anything", async () => {
    const f = setup([entry()]);
    const { deps, signals } = fakeDeps({});
    const r = await sweepOrphans(f, deps, 0);
    expect(r.gone.map((e) => e.pid)).toEqual([41001]);
    expect(signals).toEqual([]);
    expect(fs.existsSync(f)).toBe(false);
  });

  it("handles a mix: kills the match, spares the reused pid, drops the stale one", async () => {
    const f = setup([entry({ pid: 41001 }), entry({ pid: 41002 }), entry({ pid: 41003 })]);
    const { deps, alive } = fakeDeps({ 41001: cmd, 41002: "/bin/zsh -l" });
    const r = await sweepOrphans(f, deps, 0);
    expect([r.killed.length, r.reused.length, r.gone.length]).toEqual([1, 1, 1]);
    expect([...alive]).toEqual([41002]);
  });

  it("never signals this process or its parent, even if the pidfile names them", async () => {
    const f = setup([entry({ pid: 999 })]);
    const { deps, signals } = fakeDeps({ 999: cmd });
    const r = await sweepOrphans(f, deps, 0);
    expect(signals).toEqual([]);
    expect(r.reused.map((e) => e.pid)).toEqual([999]);
  });

  it("removes a corrupt pidfile, kills nothing and does not look at any process", async () => {
    const f = path.join(tempDir(), "pids.json");
    fs.writeFileSync(f, "}{");
    const { deps, signals } = fakeDeps({ 41001: cmd });
    deps.commandOf = () => {
      throw new Error("must not list processes for a corrupt file");
    };
    const r = await sweepOrphans(f, deps, 0);
    expect(r).toEqual({ killed: [], gone: [], reused: [], stragglers: [], corrupt: true });
    expect(signals).toEqual([]);
    expect(fs.existsSync(f)).toBe(false);
  });

  it("does nothing, and lists no process, when there is no pidfile", async () => {
    const { deps } = fakeDeps({});
    deps.commandOf = () => {
      throw new Error("must not list processes");
    };
    await expect(sweepOrphans(path.join(tempDir(), "none.json"), deps, 0)).resolves.toEqual({ killed: [], gone: [], reused: [], stragglers: [], corrupt: false });
  });

  it("an entry without the group flag is not killed by process group", async () => {
    const f = setup([entry({ group: false })]);
    const { deps, signals } = fakeDeps({ 41001: cmd });
    await sweepOrphans(f, deps, 0);
    expect(signals.filter((s) => s.group)).toEqual([]);
  });

  describe("an entry matched by this vault's own marker (findByMatch)", () => {
    const TOKEN = "/Users/dan/vault A/.obsidian/plugins/vscode-workbench/.server/connection-token";
    const own = `code serve-web --connection-token-file ${TOKEN}`;
    const mine = (over: Partial<PidEntry> = {}) => entry({ match: TOKEN, findByMatch: true, ...over });

    it("kills the re-parented server after its wrapper has died, and nothing else that says serve-web", async () => {
      const f = setup([mine()]);
      const other = "code serve-web --connection-token-file /Users/dan/vault B/.server/connection-token";
      // 41001 (the wrapper) is gone; 41002 is its re-parented child; 41003 is another vault's server
      const { deps, signals, alive } = fakeDeps({ 41002: `${own} --port 5000`, 41003: other, 41004: "code serve-web" });
      const r = await sweepOrphans(f, deps, 0);
      expect(r.gone.map((e) => e.pid)).toEqual([41001]);
      expect(r.stragglers).toEqual([41002]);
      expect([...alive].sort()).toEqual([41003, 41004]);
      expect(signals.filter((s) => s.group)).toEqual([]); // the dead wrapper's group id is never signalled
      expect(signals.map((s) => s.pid)).not.toContain(41001);
      expect(fs.existsSync(f)).toBe(false);
    });

    it("does not kill a reused wrapper pid that is another serve-web, but still finds this vault's children", async () => {
      const f = setup([mine()]);
      const { deps, alive } = fakeDeps({ 41001: "code serve-web --connection-token-file /elsewhere/token", 41002: own });
      const r = await sweepOrphans(f, deps, 0);
      expect(r.reused.map((e) => e.pid)).toEqual([41001]);
      expect(r.killed).toEqual([]);
      expect(r.stragglers).toEqual([41002]);
      expect([...alive]).toEqual([41001]);
    });

    it("a live wrapper is killed with its tree once, and the marker search adds only processes outside the tree", async () => {
      const f = setup([mine()]);
      const { deps, signals, alive } = fakeDeps({ 41001: own, 41002: own, 41005: own }, { children: { 41001: [41002] } });
      const r = await sweepOrphans(f, deps, 0);
      expect(r.killed.map((e) => e.pid)).toEqual([41001]);
      expect(r.stragglers).toEqual([41005]);
      expect([...alive]).toEqual([]);
      expect(signals.filter((s) => !s.group && s.sig === "SIGTERM").map((s) => s.pid)).toEqual([41001, 41002, 41005]);
    });

    it("never signals this process or its parent, even when they carry the marker", async () => {
      const f = setup([mine()]);
      const { deps, signals } = fakeDeps({ 999: own });
      deps.pidsMatching = () => [999];
      await sweepOrphans(f, deps, 0);
      expect(signals).toEqual([]);
    });

    it("an entry without findByMatch is not searched for by marker", async () => {
      const f = setup([entry({ match: TOKEN })]);
      const { deps, alive } = fakeDeps({ 41002: own });
      const r = await sweepOrphans(f, deps, 0);
      expect(r.stragglers).toEqual([]);
      expect([...alive]).toEqual([41002]);
    });

    it("the flag survives the pidfile round trip, and an entry without it does not gain the key", () => {
      const file = new PidFile(path.join(tempDir(), "pids.json"));
      file.add(mine());
      file.add(entry({ pid: 41009 }));
      const [a, b] = file.read().entries;
      expect(a.findByMatch).toBe(true);
      expect("findByMatch" in b).toBe(false);
    });
  });
});
