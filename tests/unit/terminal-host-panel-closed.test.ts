/**
 * The X in VS Code's terminal panel (inside the host page) must close the drawer completely, and the drawer must open again with
 * the terminal back, not a blank VS Code. Runs the real host page against the fake workbench page, whose panel the test closes the
 * way the X does (the panel part goes to zero size and the editor, with its logo, takes the window).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { STARTING_TEXT, TerminalHostPage } from "../../src/terminal-host/host-page";
import { makeWorld, type World } from "../host-fakes";

let host: TerminalHostPage | null = null;
afterEach(() => {
  host?.dispose();
  host = null;
  vi.restoreAllMocks();
});

const until = (fn: () => boolean) => vi.waitFor(() => { if (!fn()) throw new Error("not yet"); }, { timeout: 5_000, interval: 5 });

/** The X: the panel closes and the editor area (VS Code's logo) fills the window. */
function clickX(world: World): void {
  const page = world.webviews()[0].page!;
  page.parts.panel = [0, 0];
  page.parts.editor = [page.win[0], page.win[1]];
}

async function openHost(world: World, extra: Partial<World["deps"]> = {}): Promise<TerminalHostPage> {
  host = new TerminalHostPage({ ...world.deps, panelWatchMs: 5, ...extra });
  host.show();
  await host.settled();
  return host;
}

describe("the X in the page's terminal panel", () => {
  it("closes the drawer: the host hides itself and tells the drawer once", async () => {
    const world = makeWorld({ accepted: true });
    const closed = vi.fn();
    const h = await openHost(world, { closedByHost: closed });
    expect(h.view()).toBe("running");
    expect(closed).not.toHaveBeenCalled();
    clickX(world);
    await until(() => closed.mock.calls.length === 1);
    expect(h.isVisible()).toBe(false);
    expect(h.view()).toBe("hidden");
    expect(world.container().style.visibility).toBe("hidden");
    await new Promise((r) => setTimeout(r, 40));
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("does nothing while the panel is there, and does not mistake a page that has not painted for a closed panel", async () => {
    const world = makeWorld({ accepted: true });
    const closed = vi.fn();
    const h = await openHost(world, { closedByHost: closed });
    await new Promise((r) => setTimeout(r, 40));
    expect(closed).not.toHaveBeenCalled();
    const page = world.webviews()[0].page!;
    for (const n of Object.keys(page.parts) as Array<keyof typeof page.parts>) page.parts[n] = null; // reloading: nothing drawn yet
    await new Promise((r) => setTimeout(r, 40));
    expect(closed).not.toHaveBeenCalled();
    expect(h.isVisible()).toBe(true);
  });

  it("opening again asks for the panel back, says it is starting until the panel is back, then shows the live page", async () => {
    const world = makeWorld({ accepted: true });
    const closed = vi.fn();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const asked = vi.fn(() => {
      const page = world.webviews()[0].page!;
      void held.then(() => page.focusTerminal()); // the extension answers a moment later
      return true;
    });
    const h = await openHost(world, { closedByHost: closed, requestPanel: asked });
    clickX(world);
    await until(() => closed.mock.calls.length === 1);

    h.show();
    expect(asked).toHaveBeenCalledTimes(1);
    expect(h.isVisible()).toBe(true);
    expect(world.text()).toContain(STARTING_TEXT);
    release();
    await until(() => !world.text().includes(STARTING_TEXT));
    expect(world.webviews()).toHaveLength(1); // the same page: its shells were not reloaded away
    expect(world.webviews()[0].page!.shown()).toEqual(["panel"]);
    expect(h.view()).toBe("running");
    // and the panel is not asked for again while it is there
    await new Promise((r) => setTimeout(r, 40));
    expect(asked).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("can be closed and opened again more than once", async () => {
    const world = makeWorld({ accepted: true });
    const closed = vi.fn();
    const asked = vi.fn(() => {
      world.webviews()[0].page!.focusTerminal();
      return true;
    });
    const h = await openHost(world, { closedByHost: closed, requestPanel: asked });
    for (let i = 1; i <= 3; i++) {
      clickX(world);
      await until(() => closed.mock.calls.length === i);
      h.show();
      await until(() => !world.text().includes(STARTING_TEXT));
    }
    expect(asked).toHaveBeenCalledTimes(3);
    expect(h.view()).toBe("running");
  });

  it("a panel closed while the drawer is hidden is brought back at the next show too", async () => {
    const world = makeWorld({ accepted: true });
    const asked = vi.fn(() => {
      world.webviews()[0].page!.focusTerminal();
      return true;
    });
    const h = await openHost(world, { requestPanel: asked });
    h.hide();
    clickX(world);
    await new Promise((r) => setTimeout(r, 40));
    h.show();
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("an ordinary hide and show never asks for the panel", async () => {
    const world = makeWorld({ accepted: true });
    const asked = vi.fn(() => true);
    const h = await openHost(world, { requestPanel: asked });
    h.hide();
    h.show();
    await new Promise((r) => setTimeout(r, 40));
    expect(asked).not.toHaveBeenCalled();
  });
});
