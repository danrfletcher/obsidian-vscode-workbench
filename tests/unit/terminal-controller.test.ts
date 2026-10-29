import { describe, expect, it } from "vitest";
import type { PreflightResult } from "../../src/terminal/pty-preflight";
import { PtySession } from "../../src/terminal/pty-session";
import { ShellStartDir } from "../../src/terminal/shell-cwd";
import { ShellController, type ShellState } from "../../src/terminal/terminal-controller";
import { fakeWorld } from "../fake-pty";

const GOOD: PreflightResult = { ok: true, python: "/usr/bin/python3", shell: "/bin/zsh" };
const tick = () => new Promise((r) => setTimeout(r, 5));

function setup(preflight: () => Promise<PreflightResult> = async () => GOOD, opts: { install?: () => string } = {}) {
  const world = fakeWorld();
  let active: string | null = "scripts/estimate_time.py";
  // The folder rule itself is tested in shell-cwd.test.ts: here every folder "exists", so no disk is needed.
  const dir = new ShellStartDir(() => "/vault", () => active, { isDirectory: () => true });
  const states: ShellState[] = [];
  const outputs: string[] = [];
  let preflights = 0;
  const controller = new ShellController({
    shell: () => "/bin/zsh",
    preflight: async () => {
      preflights += 1;
      return preflight();
    },
    installHelper: opts.install ?? (() => "/vault/.server/pty_helper.py"),
    startDir: dir,
    size: () => ({ cols: 90, rows: 20 }),
    env: () => ({ TERM: "xterm-256color" }),
    createSession: (o) => new PtySession(o, world.deps),
  });
  controller.onState((s) => states.push(s));
  controller.onOutput((d) => outputs.push(Buffer.from(d).toString()));
  return { world, controller, states, outputs, setActive: (p: string | null) => (active = p), preflights: () => preflights };
}

describe("ShellController", () => {
  it("creates one shell on the first reveal, in the active file's folder, with the terminal's size", async () => {
    const { world, controller } = setup();
    await controller.ensure();
    expect(controller.state).toEqual({ kind: "running" });
    expect(world.spawned).toHaveLength(1);
    const args = world.spawned[0].args;
    expect(args.slice(args.indexOf("--cwd"), args.indexOf("--cwd") + 2)).toEqual(["--cwd", "/vault/scripts"]);
    expect(args).toEqual(expect.arrayContaining(["--rows", "20", "--cols", "90", "--login"]));
  });

  it("creates exactly one shell for a rapid double reveal", async () => {
    const { world, controller, preflights } = setup();
    await Promise.all([controller.ensure(), controller.ensure(), controller.ensure()]);
    expect(world.spawned).toHaveLength(1);
    expect(controller.created).toBe(1);
    expect(preflights()).toBe(1);
  });

  it("keeps the same live shell, in the same folder, across hide and reveal and when the active file changes", async () => {
    const { world, controller, setActive } = setup();
    await controller.ensure();
    setActive("Other folder/other.py");
    await controller.ensure();
    await controller.ensure();
    expect(world.spawned).toHaveLength(1);
    expect(world.signals).toEqual([]);
    expect(controller.liveCount).toBe(1);
  });

  it("falls back to the vault root with no active file", async () => {
    const { world, controller, setActive } = setup();
    setActive(null);
    await controller.ensure();
    const args = world.spawned[0].args;
    expect(args[args.indexOf("--cwd") + 1]).toBe("/vault");
  });

  it("passes the shell's output on, and input and resizes to the shell", async () => {
    const { world, controller, outputs } = setup();
    await controller.ensure();
    const child = world.spawned[0].child;
    child.output("zsh% ");
    await tick();
    expect(outputs).toEqual(["zsh% "]);
    controller.write("pwd\n");
    controller.resize(120, 40);
    expect(child.sent().length).toBeGreaterThan(0);
  });

  describe("a shell that exits by itself", () => {
    it("moves to exited with the code, and the next reveal starts a new shell in the folder of the then-active file", async () => {
      const { world, controller, setActive } = setup();
      await controller.ensure();
      world.spawned[0].child.shellExit(0);
      await tick();
      expect(controller.state).toEqual({ kind: "exited", code: 0 });
      expect(controller.liveCount).toBe(0);

      setActive("Areas/Café Notes/Mock Exams/x.py");
      await controller.ensure();
      expect(controller.state).toEqual({ kind: "running" });
      expect(world.spawned).toHaveLength(2);
      const args = world.spawned[1].args;
      expect(args[args.indexOf("--cwd") + 1]).toBe("/vault/Areas/Café Notes/Mock Exams");
    });

    it("does not show the old shell's late output after a new one has started", async () => {
      const { world, controller, outputs } = setup();
      await controller.ensure();
      world.spawned[0].child.shellExit(0);
      await tick();
      await controller.ensure();
      world.spawned[0].child.output("stale");
      world.spawned[1].child.output("fresh");
      await tick();
      expect(outputs).toEqual(["fresh"]);
    });

    it("a helper that dies without a word is a failed state with a message, not a dead terminal", async () => {
      const { world, controller } = setup();
      await controller.ensure();
      world.spawned[0].child.stderr.write("boom");
      world.spawned[0].child.end();
      await tick();
      expect(controller.state).toMatchObject({ kind: "failed" });
      expect((controller.state as { message: string }).message).toContain("boom");
    });
  });

  describe("failed preflight (E9, E10)", () => {
    it("spawns nothing and holds the red message, and a later reveal retries", async () => {
      let result: PreflightResult = { ok: false, kind: "shell-missing", message: "The shell /nope does not exist" };
      const { world, controller, preflights } = setup(async () => result);
      await controller.ensure();
      expect(controller.state).toEqual({ kind: "failed", message: "The shell /nope does not exist" });
      expect(world.spawned).toHaveLength(0);

      result = GOOD;
      await controller.ensure();
      expect(preflights()).toBe(2);
      expect(controller.state).toEqual({ kind: "running" });
      expect(world.spawned).toHaveLength(1);
    });

    it("the folder is taken again for the retry, not kept from the failed attempt", async () => {
      let ok = false;
      const { world, controller, setActive } = setup(async () => (ok ? GOOD : { ok: false, kind: "python-missing", message: "no python" }));
      await controller.ensure();
      setActive("Areas/Café Notes/Mock Exams/x.py");
      ok = true;
      await controller.ensure();
      const args = world.spawned[0].args;
      expect(args[args.indexOf("--cwd") + 1]).toBe("/vault/Areas/Café Notes/Mock Exams");
    });

    it("a helper script that cannot be written is a red message too", async () => {
      const { world, controller } = setup(undefined, { install: () => { throw new Error("EACCES: permission denied"); } });
      await controller.ensure();
      expect(world.spawned).toHaveLength(0);
      expect(controller.state).toMatchObject({ kind: "failed" });
      expect((controller.state as { message: string }).message).toContain("EACCES");
    });
  });

  describe("restart and dispose", () => {
    it("restart kills the old shell and starts one new shell", async () => {
      const { world, controller } = setup();
      await controller.ensure();
      await controller.restart();
      expect(world.spawned).toHaveLength(2);
      expect(world.signals.some(([pid, sig]) => pid === world.spawned[0].child.pid && sig === "SIGTERM")).toBe(true);
      expect(controller.state).toEqual({ kind: "running" });
      expect(controller.liveCount).toBe(1);
    });

    it("restart while a start is in flight kills the shell that start makes: one shell is left, none untracked (PR-6 R2)", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let first = true;
      const { world, controller } = setup(async () => {
        if (first) {
          first = false;
          await gate; // the first start's checks are still running
        }
        return GOOD;
      });
      const starting = controller.ensure();
      await tick();
      expect(controller.state).toEqual({ kind: "starting" });
      const restarting = controller.restart();
      await tick();
      release();
      await Promise.all([starting, restarting]);
      expect(world.spawned).toHaveLength(2); // the in-flight start's shell, and the restart's
      const [orphanCandidate, current] = world.spawned.map((x) => x.child.pid);
      expect(world.signals.some(([pid, sig]) => pid === orphanCandidate && sig === "SIGTERM")).toBe(true);
      expect(controller.state).toEqual({ kind: "running" });
      expect(controller.liveCount).toBe(1);
      await controller.dispose();
      expect(world.signals.some(([pid, sig]) => pid === current && sig === "SIGTERM")).toBe(true);
    });

    it("restart after an exit starts a new shell", async () => {
      const { world, controller } = setup();
      await controller.ensure();
      world.spawned[0].child.shellExit(1);
      await tick();
      await controller.restart();
      expect(world.spawned).toHaveLength(2);
    });

    it("dispose kills the shell, and nothing starts afterwards", async () => {
      const { world, controller } = setup();
      await controller.ensure();
      await controller.dispose();
      expect(world.signals.some(([pid, sig]) => pid === world.spawned[0].child.pid && sig === "SIGTERM")).toBe(true);
      await controller.ensure();
      expect(world.spawned).toHaveLength(1);
    });

    it("dispose while the checks are still running means no shell is ever spawned (no orphan)", async () => {
      let release!: (r: PreflightResult) => void;
      const { world, controller } = setup(() => new Promise((r) => (release = r)));
      const starting = controller.ensure();
      await controller.dispose();
      release(GOOD);
      await starting;
      expect(world.spawned).toHaveLength(0);
    });

    it("the registry's killAll (quit) takes the shell down and registers nothing afterwards", async () => {
      const { world, controller } = setup();
      await controller.ensure();
      expect(world.registry.size).toBe(1);
      await world.registry.killAll();
      expect(world.signals.some(([, sig]) => sig === "SIGTERM")).toBe(true);
      expect(world.registry.size).toBe(0);
    });
  });
});
