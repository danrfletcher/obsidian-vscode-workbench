/**
 * The X in VS Code's terminal panel (inside the host page) must close the drawer completely, and the drawer must open again with
 * the terminal back, not a blank VS Code. Runs the real host page against the fake workbench page, whose panel the test closes the
 * way the X does (the panel part goes to zero size and the editor, with its logo, takes the window).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PANEL_NOT_BACK_TEXT, PANEL_REQUEST_FAILED_TEXT, STARTING_TEXT, TerminalHostPage } from "../../src/terminal-host/host-page";
import { LAYOUT_SCRIPT } from "../../src/terminal-host/panel-only";
import { makeWorld, type World } from "../host-fakes";

let host: TerminalHostPage | null = null;
afterEach(() => {
  host?.dispose();
  host = null;
  vi.restoreAllMocks();
});

const until = (fn: () => boolean) => vi.waitFor(() => { if (!fn()) throw new Error("not yet"); }, { timeout: 5_000, interval: 5 });

/** The Retry button the user can press. */
const retry = (world: World) => world.container().all().filter((e) => e.tag === "button" && e.textContent === "Retry")[0];

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
    await until(() => asked.mock.calls.length === 1); // the one check `show` makes finds the panel gone
    expect(asked).toHaveBeenCalledTimes(1);
    expect(h.isVisible()).toBe(true);
  });

  it("asks the page nothing while the drawer is hidden, looks once on show, and has the watch back while it shows", async () => {
    const world = makeWorld({ accepted: true });
    const asked = vi.fn(() => true);
    const closed = vi.fn();
    const h = await openHost(world, { requestPanel: asked, closedByHost: closed });
    const layoutReads = () => world.webviews()[0].executed.filter((c) => c === LAYOUT_SCRIPT).length;
    h.hide();
    await new Promise((r) => setTimeout(r, 20)); // lets a check that was in flight at the hide end
    const before = layoutReads();
    await new Promise((r) => setTimeout(r, 80)); // 16 watch periods of 5 ms
    expect(layoutReads()).toBe(before);
    h.show();
    await until(() => layoutReads() > before); // the one look on show
    await new Promise((r) => setTimeout(r, 40));
    expect(asked).not.toHaveBeenCalled(); // the panel was there: nothing to restore
    expect(h.view()).toBe("running");
    // the watch is running again while it shows: an X closes the drawer
    clickX(world);
    await until(() => closed.mock.calls.length === 1);
    expect(h.isVisible()).toBe(false);
  });

  describe("when the panel cannot be brought back", () => {
    it("a request that cannot be made shows the reason with Retry, keeps the drawer open, and Retry asks again", async () => {
      const world = makeWorld({ accepted: true });
      const closed = vi.fn();
      let ok = false;
      const asked = vi.fn(() => {
        if (ok) world.webviews()[0].page!.focusTerminal();
        return ok;
      });
      const h = await openHost(world, { closedByHost: closed, requestPanel: asked });
      clickX(world);
      await until(() => closed.mock.calls.length === 1);

      h.show();
      await until(() => world.text().includes(PANEL_REQUEST_FAILED_TEXT));
      await new Promise((r) => setTimeout(r, 60)); // many watch periods: the blank page must not close the drawer again
      expect(h.isVisible()).toBe(true);
      expect(closed).toHaveBeenCalledTimes(1);
      expect(world.text()).toContain(PANEL_REQUEST_FAILED_TEXT);
      expect(world.text()).not.toContain(STARTING_TEXT);

      ok = true;
      retry(world).fire("click");
      await until(() => !world.text().includes(PANEL_REQUEST_FAILED_TEXT) && !world.text().includes(STARTING_TEXT));
      expect(asked).toHaveBeenCalledTimes(2);
      expect(h.view()).toBe("running");
      expect(world.webviews()[0].page!.shown()).toEqual(["panel"]);
      expect(h.isVisible()).toBe(true);
    });

    it("a page that never brings the panel back shows an error with Retry after panelMs, instead of closing itself", async () => {
      const world = makeWorld({ accepted: true });
      const closed = vi.fn();
      const asked = vi.fn(() => true); // the extension never answers
      const h = await openHost(world, { closedByHost: closed, requestPanel: asked, panelMs: 60 });
      clickX(world);
      await until(() => closed.mock.calls.length === 1);

      h.show();
      expect(world.text()).toContain(STARTING_TEXT);
      await until(() => world.text().includes(PANEL_NOT_BACK_TEXT));
      expect(world.text()).not.toContain(STARTING_TEXT);
      await new Promise((r) => setTimeout(r, 60));
      expect(h.isVisible()).toBe(true);
      expect(closed).toHaveBeenCalledTimes(1);
      expect(asked).toHaveBeenCalledTimes(1);

      // the extension answers late; Retry finds the panel there and clears the message
      world.webviews()[0].page!.focusTerminal();
      retry(world).fire("click");
      await until(() => !world.text().includes(PANEL_NOT_BACK_TEXT));
      expect(asked).toHaveBeenCalledTimes(2);
      expect(h.isVisible()).toBe(true);
    });

    it("a failure left showing is tried again at the next show", async () => {
      const world = makeWorld({ accepted: true });
      let ok = false;
      const asked = vi.fn(() => {
        if (ok) world.webviews()[0].page!.focusTerminal();
        return ok;
      });
      const closed = vi.fn();
      const h = await openHost(world, { closedByHost: closed, requestPanel: asked });
      clickX(world);
      await until(() => closed.mock.calls.length === 1);
      h.show();
      await until(() => world.text().includes(PANEL_REQUEST_FAILED_TEXT));
      h.hide();
      ok = true;
      h.show();
      await until(() => !world.text().includes(PANEL_REQUEST_FAILED_TEXT));
      expect(asked).toHaveBeenCalledTimes(2);
      expect(world.webviews()[0].page!.shown()).toEqual(["panel"]);
    });
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
