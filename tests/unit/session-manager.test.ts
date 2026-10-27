import { describe, expect, it } from "vitest";
import { GOOD, managerRig, tick } from "../helpers-sessions";
import type { PreflightResult } from "../../src/terminal/pty-preflight";

describe("SessionManager", () => {
  describe("create", () => {
    it("adds a session, makes it active, starts its shell and reports the order of events", async () => {
      const { manager, world, events } = managerRig();
      const s = manager.create();
      expect(s).not.toBeNull();
      expect(manager.sessions.map((x) => x.id)).toEqual([s!.id]);
      expect(manager.activeId).toBe(s!.id);
      expect(events.slice(0, 2).map((e) => e.type)).toEqual(["created", "activated"]);
      await tick();
      expect(world.spawned).toHaveLength(1);
      expect(s!.controller.state).toEqual({ kind: "running" });
      expect(manager.count).toBe(1);
      expect(events.some((e) => e.type === "count" && e.count === 1)).toBe(true);
    });

    it("labels tabs with the shell name and the session's number", () => {
      const { manager } = managerRig();
      manager.create();
      manager.create();
      expect(manager.sessions.map((s) => s.title)).toEqual(["zsh 1", "zsh 2"]);
    });

    it("ten rapid creates make ten sessions with ten unique ids and ten shells", async () => {
      const { manager, world } = managerRig();
      for (let i = 0; i < 10; i++) manager.create();
      await tick();
      await tick();
      const ids = manager.sessions.map((s) => s.id);
      expect(ids).toHaveLength(10);
      expect(new Set(ids).size).toBe(10);
      expect(world.spawned).toHaveLength(10);
      expect(manager.count).toBe(10);
      expect(manager.activeId).toBe(ids[9]);
    });

    it("never reuses an id after a kill", async () => {
      const { manager } = managerRig();
      const a = manager.create()!;
      await manager.remove(a.id);
      const b = manager.create()!;
      expect(b.id).not.toBe(a.id);
      expect(b.title).toBe("zsh 2");
    });

    it("creates nothing once disposed", async () => {
      const { manager, world } = managerRig();
      await manager.dispose();
      expect(manager.create()).toBeNull();
      expect(world.spawned).toHaveLength(0);
    });
  });

  describe("first reveal", () => {
    it("creates exactly one shell however many times it is asked (double click, double hotkey)", async () => {
      const { manager, world } = managerRig();
      expect(manager.ensureFirst()).not.toBeNull();
      expect(manager.ensureFirst()).toBeNull();
      expect(manager.ensureFirst()).toBeNull();
      await tick();
      expect(manager.sessions).toHaveLength(1);
      expect(world.spawned).toHaveLength(1);
    });

    it("makes nothing while a session exists, running, exited or failed", async () => {
      const { manager, world } = managerRig();
      manager.ensureFirst();
      await tick();
      world.spawned[0].child.shellExit(0);
      await tick();
      expect(manager.ensureFirst()).toBeNull();
      expect(manager.sessions).toHaveLength(1);
    });

    it("makes one fresh shell after the last session was killed", async () => {
      const { manager, world } = managerRig();
      manager.ensureFirst();
      await tick();
      await manager.remove(manager.activeId!);
      expect(manager.sessions).toHaveLength(0);
      expect(manager.ensureFirst()).not.toBeNull();
      await tick();
      expect(world.spawned).toHaveLength(2);
      expect(manager.sessions).toHaveLength(1);
    });
  });

  describe("kill", () => {
    it("remove() drops the tab at once, signals the shell before returning and reports removed", async () => {
      const { manager, world, events } = managerRig();
      const a = manager.create()!;
      manager.create();
      await tick();
      const pid = world.spawned[0].child.pid;
      const done = manager.remove(a.id);
      expect(manager.get(a.id)).toBeUndefined();
      expect(world.signals).toContainEqual([pid, "SIGTERM"]); // sent before the promise settles
      await done;
      expect(events.some((e) => e.type === "removed" && e.id === a.id)).toBe(true);
      expect(manager.count).toBe(1);
    });

    it("killing one session leaves the others running and untouched", async () => {
      const { manager, world } = managerRig();
      const a = manager.create()!;
      const b = manager.create()!;
      await tick();
      await manager.remove(a.id);
      expect(world.signals.every(([pid]) => pid === world.spawned[0].child.pid)).toBe(true);
      expect(b.controller.state).toEqual({ kind: "running" });
      expect(manager.sessions.map((s) => s.id)).toEqual([b.id]);
    });

    it("killing the active session activates its neighbour: the next one, else the previous", async () => {
      const { manager } = managerRig();
      const [a, b, c] = [manager.create()!, manager.create()!, manager.create()!];
      manager.activate(b.id);
      await manager.remove(b.id);
      expect(manager.activeId).toBe(c.id);
      await manager.remove(c.id);
      expect(manager.activeId).toBe(a.id);
    });

    it("killing a session that is not active keeps the active one", async () => {
      const { manager } = managerRig();
      const a = manager.create()!;
      const b = manager.create()!;
      await manager.remove(a.id);
      expect(manager.activeId).toBe(b.id);
    });

    it("signals 'empty' when the last session is killed, and not before", async () => {
      const { manager, of } = managerRig();
      const a = manager.create()!;
      const b = manager.create()!;
      await manager.remove(a.id);
      expect(of("empty")).toHaveLength(0);
      await manager.remove(b.id);
      expect(of("empty")).toHaveLength(1);
      expect(manager.activeId).toBeNull();
    });

    it("a shell that exits by itself, even the last, does not signal 'empty' and keeps its tab", async () => {
      const { manager, world, of } = managerRig();
      manager.create();
      await tick();
      world.spawned[0].child.shellExit(0);
      await tick();
      expect(of("empty")).toHaveLength(0);
      expect(manager.sessions).toHaveLength(1);
    });

    it("removing an id that is not there does nothing and signals nothing", async () => {
      const { manager, events } = managerRig();
      const a = manager.create()!;
      await manager.remove(a.id);
      const before = events.length;
      await manager.remove(a.id);
      await manager.remove("shell-99");
      expect(events.length).toBe(before);
    });

    it("kill racing a natural exit removes the tab once and the count never goes below zero", async () => {
      const { manager, world, events } = managerRig();
      const a = manager.create()!;
      await tick();
      const child = world.spawned[0].child;
      const removal = manager.remove(a.id);
      child.shellExit(0); // the shell ends by itself in the same moment
      await Promise.all([removal, manager.remove(a.id)]);
      await tick();
      expect(events.filter((e) => e.type === "removed")).toHaveLength(1);
      expect(events.filter((e) => e.type === "empty")).toHaveLength(1);
      expect(events.filter((e) => e.type === "state" && e.id === a.id && e.state.kind === "exited")).toHaveLength(0); // the removed session reports nothing
      expect(manager.count).toBe(0);
      expect(events.every((e) => e.type !== "count" || e.count >= 0)).toBe(true);
    });

    it("a natural exit first, then a kill, is also one removal", async () => {
      const { manager, world, events } = managerRig();
      const a = manager.create()!;
      await tick();
      world.spawned[0].child.shellExit(3);
      await tick();
      expect(manager.count).toBe(0);
      await manager.remove(a.id);
      await manager.remove(a.id);
      expect(events.filter((e) => e.type === "removed")).toHaveLength(1);
      expect(manager.count).toBe(0);
    });

    it("late output of a removed session is dropped", async () => {
      const { manager, world, of } = managerRig();
      const a = manager.create()!;
      await tick();
      const child = world.spawned[0].child;
      await manager.remove(a.id);
      child.output("too late");
      await tick();
      expect(of("output")).toHaveLength(0);
    });
  });

  describe("exit events and the count", () => {
    it("reports a state change per session and the count on exit", async () => {
      const { manager, world, events, of } = managerRig();
      const a = manager.create()!;
      const b = manager.create()!;
      await tick();
      expect(manager.count).toBe(2);
      world.spawned[1].child.shellExit(0);
      await tick();
      expect(manager.count).toBe(1);
      expect(events.some((e) => e.type === "state" && e.id === b.id && e.state.kind === "exited")).toBe(true);
      expect(a.controller.state).toEqual({ kind: "running" });
      expect(of("count").map((e) => (e as { count: number }).count)).toEqual([1, 2, 1]);
    });

    it("does not count a session that failed to start, and keeps its tab with the message", async () => {
      const result: PreflightResult = { ok: false, kind: "shell-missing", message: "The shell /nope does not exist" };
      const { manager, world, of } = managerRig(async () => result);
      const a = manager.create()!;
      await tick();
      expect(a.controller.state).toEqual({ kind: "failed", message: "The shell /nope does not exist" });
      expect(manager.count).toBe(0);
      expect(world.spawned).toHaveLength(0);
      expect(manager.sessions).toHaveLength(1);
      // counted while it was starting, and not once it failed
      expect(of("count").map((e) => (e as { count: number }).count)).toEqual([1, 0]);
      await manager.remove(a.id); // closing it asks nothing of the manager
      expect(manager.sessions).toHaveLength(0);
      expect(manager.count).toBe(0);
    });

    it("counts a shell that is still starting (preflight not answered yet), then keeps counting it once it runs (PR-7 R2)", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const { manager, of } = managerRig(async () => {
        await gate;
        return GOOD;
      });
      const a = manager.create()!;
      await tick();
      expect(a.controller.state).toEqual({ kind: "starting" });
      expect(manager.count).toBe(1);
      expect(of("count").map((e) => (e as { count: number }).count)).toEqual([1]);
      release();
      await tick();
      expect(a.controller.state).toEqual({ kind: "running" });
      expect(manager.count).toBe(1);
      expect(of("count").map((e) => (e as { count: number }).count)).toEqual([1]); // no flicker
    });

    it("a good shell and a missing one side by side: the count is the good one", async () => {
      const { manager } = managerRig(async (n) => (n === 1 ? GOOD : { ok: false, kind: "shell-missing", message: "no shell" }));
      manager.create();
      manager.create();
      await tick();
      expect(manager.sessions).toHaveLength(2);
      expect(manager.count).toBe(1);
    });
  });

  describe("restart and activate", () => {
    it("restart starts a new shell in the same session after an exit", async () => {
      const { manager, world } = managerRig();
      const a = manager.create()!;
      await tick();
      world.spawned[0].child.shellExit(0);
      await tick();
      await manager.restart(a.id);
      expect(world.spawned).toHaveLength(2);
      expect(manager.count).toBe(1);
      expect(manager.sessions).toHaveLength(1);
    });

    it("activate switches the active id and ignores unknown ids and the current one", () => {
      const { manager, of } = managerRig();
      const a = manager.create()!;
      const b = manager.create()!;
      const before = of("activated").length;
      manager.activate(b.id);
      manager.activate("nope");
      expect(of("activated")).toHaveLength(before);
      manager.activate(a.id);
      expect(manager.activeId).toBe(a.id);
    });

    it("switching tabs does not signal or restart any shell", async () => {
      const { manager, world } = managerRig();
      const a = manager.create()!;
      manager.create();
      await tick();
      manager.activate(a.id);
      manager.activate(manager.sessions[1].id);
      expect(world.signals).toEqual([]);
      expect(world.spawned).toHaveLength(2);
    });
  });

  describe("dispose", () => {
    it("signals every shell before returning and empties the list", async () => {
      const { manager, world } = managerRig();
      manager.create();
      manager.create();
      await tick();
      const done = manager.dispose();
      expect(world.signals.filter(([, sig]) => sig === "SIGTERM")).toHaveLength(2);
      await done;
      expect(manager.sessions).toHaveLength(0);
    });
  });
});
