import { describe, expect, it } from "vitest";
import { FRAME_INPUT, FRAME_RESIZE, FrameDecoder } from "../../src/terminal/pty-protocol";
import { HELPER_MATCH, PtySession, type SessionExit, type SessionOptions } from "../../src/terminal/pty-session";
import { fakeWorld } from "../fake-pty";

const options: SessionOptions = {
  python: "/usr/bin/python3",
  helperPath: "/vault/.obsidian/plugins/x/.server/pty_helper.py",
  shell: "/bin/zsh",
  cwd: "/vault/Areas/Café Notes/Mock Exams",
  cols: 100,
  rows: 30,
  env: { TERM: "xterm-256color" },
  login: true,
};

const tick = () => new Promise((r) => setTimeout(r, 5));

function setup(over: Parameters<typeof fakeWorld>[0] = {}) {
  const world = fakeWorld(over);
  const session = new PtySession(options, world.deps);
  const outputs: string[] = [];
  const exits: SessionExit[] = [];
  session.onOutput((d) => outputs.push(d.toString("utf8")));
  session.onExit((e) => exits.push(e));
  session.start();
  return { world, session, child: world.spawned[0].child, outputs, exits };
}

describe("PtySession with a fake helper process", () => {
  it("runs python3 on the helper with the folder, shell and size as plain arguments (no shell, no socket)", () => {
    const { world } = setup();
    const [spawned] = world.spawned;
    expect(spawned.command).toBe("/usr/bin/python3");
    expect(spawned.args).toEqual([options.helperPath, "--cwd", options.cwd, "--shell", "/bin/zsh", "--rows", "30", "--cols", "100", "--login"]);
  });

  it("registers the helper in the child registry for quit and the orphan sweep, and unregisters it at exit", async () => {
    const { world, child } = setup();
    expect(world.registry.list()).toEqual([{ pid: child.pid, label: "terminal-shell" }]);
    expect(HELPER_MATCH).toBe("pty_helper.py");
    child.shellExit(0);
    await tick();
    expect(world.registry.size).toBe(0);
  });

  it("frames what is typed as input frames on the helper's stdin", () => {
    const { session, child } = setup();
    session.write("echo hi\n");
    const frames = new FrameDecoder().push(child.sent());
    expect(frames.map((f) => [f.type, f.payload.toString()])).toEqual([[FRAME_INPUT, "echo hi\n"]]);
  });

  it("frames a resize so the helper sets the window size", () => {
    const { session, child } = setup();
    session.resize(132, 43);
    const [frame] = new FrameDecoder().push(child.sent());
    expect(frame.type).toBe(FRAME_RESIZE);
    expect([frame.payload.readUInt16BE(0), frame.payload.readUInt16BE(2)]).toEqual([43, 132]);
  });

  it("passes the shell's output to its listeners, whole frames only, however the pipe splits them", async () => {
    const { child, outputs } = setup();
    child.output("héllo ");
    child.output("日本");
    await tick();
    expect(outputs.join("")).toBe("héllo 日本");
  });

  it("reports the shell's exit code once the helper has ended", async () => {
    const { child, exits, session } = setup();
    child.output("bye\r\n");
    child.shellExit(3);
    await tick();
    expect(exits).toEqual([{ code: 3, helperFailed: false, detail: "" }]);
    expect(session.running).toBe(false);
  });

  it("reports a helper that ended without an exit frame as failed, with what it printed on stderr", async () => {
    const { child, exits } = setup();
    child.stderr.write("Traceback: no module named pty\n");
    child.end();
    await tick();
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ code: null, helperFailed: true });
    expect(exits[0].detail).toContain("no module named pty");
  });

  it("reports a spawn error as a failed helper", async () => {
    const { child, exits } = setup();
    child.emit("error", new Error("spawn python3 ENOENT"));
    await tick();
    expect(exits[0]).toMatchObject({ helperFailed: true });
    expect(exits[0].detail).toContain("ENOENT");
  });

  it("exits once even if both an error and a close arrive", async () => {
    const { child, exits } = setup();
    child.emit("error", new Error("boom"));
    child.end();
    await tick();
    await tick();
    expect(exits).toHaveLength(1);
  });

  it("ignores input and resize after the shell has gone", async () => {
    const { session, child } = setup();
    child.shellExit(0);
    await tick();
    const before = child.sent().length;
    session.write("late");
    session.resize(10, 10);
    expect(child.sent().length).toBe(before);
  });

  it("treats a malformed stream from the helper as a failure and stops it", async () => {
    const { world, child, exits } = setup();
    child.stdout.write(Buffer.from([0x4f, 0xff, 0xff, 0xff, 0xff])); // a frame claiming 4 GB
    await tick();
    await tick();
    expect(world.signals.some(([pid, sig]) => pid === child.pid && sig === "SIGTERM")).toBe(true);
    expect(exits[0].detail).toContain("bad data");
  });

  describe("kill", () => {
    it("sends SIGTERM to the helper and every descendant before it returns, and closes the helper's stdin", async () => {
      const { world, session, child } = setup({ descendants: (pid) => [pid + 1, pid + 2] });
      const done = session.kill();
      expect(world.signals).toEqual([
        [child.pid, "SIGTERM"],
        [child.pid + 1, "SIGTERM"],
        [child.pid + 2, "SIGTERM"],
      ]);
      expect(child.stdin.writableEnded).toBe(true);
      await done;
      expect(session.running).toBe(false);
      expect(world.registry.size).toBe(0);
    });

    it("escalates to SIGKILL for what is still alive after the grace period", async () => {
      const { world, session, child } = setup({ descendants: (pid) => [pid + 1], diesOn: "SIGKILL" });
      world.alive.add(child.pid + 1);
      await session.kill();
      const killed = world.signals.filter(([, sig]) => sig === "SIGKILL").map(([pid]) => pid);
      expect(killed).toEqual([child.pid, child.pid + 1]);
    }, 10000);

    it("is safe to call twice and after the shell has exited", async () => {
      const { world, session, child } = setup();
      const a = session.kill();
      const b = session.kill();
      expect(b).toBe(a);
      await a;
      await session.kill();
      expect(world.signals.filter(([, s]) => s === "SIGTERM")).toHaveLength(1);
      expect(child.pid).toBeGreaterThan(0);
    });
  });
});
