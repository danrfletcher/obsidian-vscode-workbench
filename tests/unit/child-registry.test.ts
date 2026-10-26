import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ChildRegistry } from "../../src/child-registry";
import { PidFile } from "../../src/pidfile";
import { tempDir } from "../helpers";

describe("ChildRegistry", () => {
  it("mirrors registrations into the pidfile and removes them on unregister", () => {
    const pf = new PidFile(path.join(tempDir(), "pids.json"));
    const reg = new ChildRegistry(pf);
    const un = reg.register({ pid: 41010, label: "shell", match: "pty-helper", workspace: "/v/ünï dir", kill: () => undefined });
    expect(pf.read().entries.map((e) => [e.pid, e.label, e.match, e.workspace])).toEqual([[41010, "shell", "pty-helper", "/v/ünï dir"]]);
    expect(reg.list()).toEqual([{ pid: 41010, label: "shell" }]);
    un();
    expect(reg.size).toBe(0);
    expect(fs.existsSync(pf.file)).toBe(false);
  });

  it("killAll issues every kill before waiting for any, survives a throwing kill, and empties the registry and pidfile", async () => {
    const pf = new PidFile(path.join(tempDir(), "pids.json"));
    const reg = new ChildRegistry(pf);
    const order: string[] = [];
    let release!: () => void;
    reg.register({ pid: 41011, label: "a", match: "a", kill: () => new Promise<void>((r) => { order.push("a:signalled"); release = () => { order.push("a:gone"); r(); }; }) });
    reg.register({ pid: 41012, label: "b", match: "b", kill: () => { order.push("b:signalled"); throw new Error("already dead"); } });
    reg.register({ pid: 41013, label: "c", match: "c", kill: () => { order.push("c:signalled"); } });
    const done = reg.killAll();
    expect(order).toEqual(["a:signalled", "b:signalled", "c:signalled"]); // all signalled synchronously
    release();
    await done;
    expect(order[order.length - 1]).toBe("a:gone");
    expect(reg.size).toBe(0);
    expect(pf.read().entries).toEqual([]);
  });

  it("works without a pidfile", async () => {
    const reg = new ChildRegistry();
    const kill = vi.fn();
    reg.register({ pid: 41014, label: "x", match: "x", kill });
    await reg.killAll();
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
