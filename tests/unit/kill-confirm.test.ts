import { beforeEach, describe, expect, it } from "vitest";
import { KillConfirm } from "../../src/terminal/kill-confirm";
import { promptKillShell } from "../../src/modals";
import { Modal } from "../mocks/obsidian";
import { managerRig, tick } from "../helpers-sessions";
import type { PreflightResult } from "../../src/terminal/pty-preflight";

function setup(preflight?: () => Promise<PreflightResult>) {
  const rig = managerRig(preflight);
  const asked: string[] = [];
  let answer: (title: string) => Promise<boolean> = async () => true;
  const kills = new KillConfirm(rig.manager, (title) => {
    asked.push(title);
    return answer(title);
  });
  return { ...rig, kills, asked, answerWith: (fn: (title: string) => Promise<boolean>) => (answer = fn) };
}

describe("KillConfirm", () => {
  it("asks before killing a running shell, naming the tab", async () => {
    const { manager, kills, asked } = setup();
    const a = manager.create()!;
    await tick();
    expect(await kills.request(a.id)).toBe("killed");
    expect(asked).toEqual(["zsh 1"]);
    expect(manager.sessions).toHaveLength(0);
  });

  it("Cancel keeps the session running, with its tab", async () => {
    const { manager, world, kills, answerWith } = setup();
    answerWith(async () => false);
    const a = manager.create()!;
    await tick();
    expect(await kills.request(a.id)).toBe("kept");
    expect(manager.get(a.id)).toBeDefined();
    expect(a.controller.state).toEqual({ kind: "running" });
    expect(world.signals).toEqual([]);
  });

  it("skips the question for a shell that has already exited", async () => {
    const { manager, world, kills, asked } = setup();
    const a = manager.create()!;
    await tick();
    world.spawned[0].child.shellExit(0);
    await tick();
    expect(await kills.request(a.id)).toBe("killed");
    expect(asked).toEqual([]);
    expect(manager.sessions).toHaveLength(0);
  });

  it("skips the question for a session whose shell could not start, and the count excludes it", async () => {
    const { manager, kills, asked } = setup(async () => ({ ok: false, kind: "shell-missing", message: "no shell" }));
    const a = manager.create()!;
    await tick();
    expect(manager.count).toBe(0);
    expect(await kills.request(a.id)).toBe("killed");
    expect(asked).toEqual([]);
    expect(manager.sessions).toHaveLength(0);
  });

  it("a shell that exits while the question is open is removed once, without a second question", async () => {
    const { manager, world, kills, asked, answerWith, events } = setup();
    const a = manager.create()!;
    await tick();
    answerWith(async () => {
      world.spawned[0].child.shellExit(0);
      await tick();
      return true;
    });
    expect(await kills.request(a.id)).toBe("killed");
    expect(asked).toHaveLength(1);
    expect(events.filter((e) => e.type === "removed")).toHaveLength(1);
    expect(manager.count).toBe(0);
  });

  it("a tab removed while the question is open is 'gone' and nothing is removed twice", async () => {
    const { manager, kills, answerWith, events } = setup();
    const a = manager.create()!;
    await tick();
    answerWith(async () => {
      await manager.remove(a.id);
      return true;
    });
    expect(await kills.request(a.id)).toBe("gone");
    expect(events.filter((e) => e.type === "removed")).toHaveLength(1);
  });

  it("an unknown session is 'gone' and asks nothing", async () => {
    const { kills, asked } = setup();
    expect(await kills.request("shell-9")).toBe("gone");
    expect(asked).toEqual([]);
  });

  it("a second request for the same shell while its question is open does not stack another", async () => {
    const { manager, kills, asked, answerWith } = setup();
    const a = manager.create()!;
    await tick();
    let release!: (v: boolean) => void;
    answerWith(() => new Promise<boolean>((r) => (release = r)));
    const first = kills.request(a.id);
    expect(await kills.request(a.id)).toBe("kept");
    release(true);
    expect(await first).toBe("killed");
    expect(asked).toHaveLength(1);
  });

  it("asks again after a Cancel", async () => {
    const { manager, kills, asked, answerWith } = setup();
    const a = manager.create()!;
    await tick();
    answerWith(async () => false);
    await kills.request(a.id);
    answerWith(async () => true);
    expect(await kills.request(a.id)).toBe("killed");
    expect(asked).toHaveLength(2);
  });
});

describe("the kill modal", () => {
  beforeEach(() => Modal.reset());

  it("Kill shell confirms", async () => {
    const answer = promptKillShell({} as never, "zsh 2");
    const modal = Modal.opened[0];
    expect(modal.contentEl.textContent()).toContain("zsh 2");
    const buttons = modal.contentEl.buttons();
    expect(buttons.map((b) => b.text)).toEqual(["Cancel", "Kill shell"]);
    buttons[1].click();
    expect(await answer).toBe(true);
  });

  it("Cancel keeps the shell", async () => {
    const answer = promptKillShell({} as never, "zsh 1");
    Modal.opened[0].contentEl.buttons()[0].click();
    expect(await answer).toBe(false);
  });

  it("Escape (the modal closing with no button pressed) keeps the shell", async () => {
    const answer = promptKillShell({} as never, "zsh 1");
    Modal.opened[0].close();
    expect(await answer).toBe(false);
  });
});
