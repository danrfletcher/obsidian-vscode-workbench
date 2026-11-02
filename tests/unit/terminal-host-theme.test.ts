import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalHostPage } from "../../src/terminal-host/host-page";
import { buildThemeSwitchScript, themeSwitchMessage } from "../../src/theme-map";
import { deferred, makeWorld, type World } from "../host-fakes";

let host: TerminalHostPage | null = null;
async function running(world: World): Promise<TerminalHostPage> {
  host = new TerminalHostPage(world.deps);
  host.show();
  await host.settled();
  expect(host.view()).toBe("running");
  return host;
}
afterEach(() => {
  host?.dispose();
  host = null;
});

describe("G5: the host page follows light and dark through the Code tabs' mapping", () => {
  it("seeds the theme Obsidian has when the page is built", async () => {
    const dark = makeWorld({ accepted: true });
    dark.dark.value = true;
    await running(dark);
    expect(dark.webviews()[0].executed[0]).toContain('"workbench.colorTheme":"Dark Modern"');
    host?.dispose();

    const light = makeWorld({ accepted: true });
    light.dark.value = false;
    await running(light);
    expect(light.webviews()[0].executed[0]).toContain('"workbench.colorTheme":"Light Modern"');
  });

  it("a flip sends the page the exact script `buildThemeSwitchScript` makes for that theme, and loads nothing", async () => {
    const world = makeWorld({ accepted: true });
    world.dark.value = true;
    const h = await running(world);
    const wv = world.webviews()[0];
    const loads = wv.srcs.length;

    world.dark.value = false;
    await h.themeChanged(false);
    expect(wv.page!.themeScripts).toEqual([buildThemeSwitchScript(themeSwitchMessage(false))]);
    expect(wv.page!.themeScripts[0]).toContain("Light Modern");

    await h.themeChanged(true);
    expect(wv.page!.themeScripts).toEqual([buildThemeSwitchScript(themeSwitchMessage(false)), buildThemeSwitchScript(themeSwitchMessage(true))]);
    expect(wv.srcs).toHaveLength(loads); // the page was never navigated: its terminals are still there
    expect(world.webviews()).toEqual([wv]);
    expect(wv.removed).toBe(false);
    expect(h.view()).toBe("running"); // and no "terminals lost"
  });

  it("asking for the theme the page already has sends nothing", async () => {
    const world = makeWorld({ accepted: true });
    world.dark.value = true;
    const h = await running(world);
    await h.themeChanged(true);
    await h.themeChanged(true);
    expect(world.webviews()[0].page!.themeScripts).toEqual([]);
  });

  it("rapid toggles coalesce: the page ends on the last wish, and a switch in flight is not overlapped", async () => {
    const world = makeWorld({ accepted: true });
    world.dark.value = true;
    const h = await running(world);
    const page = world.webviews()[0].page!;
    const gate = deferred();
    page.themeGate = gate.promise;

    const first = h.themeChanged(false); // starts a switch that waits on the gate
    await new Promise((r) => setTimeout(r, 5));
    const rest = [h.themeChanged(true), h.themeChanged(false), h.themeChanged(true), h.themeChanged(false)];
    expect(page.themeScripts).toHaveLength(1); // one in flight, none started beside it
    page.themeGate = null;
    gate.release();
    await Promise.all([first, ...rest]);

    expect(page.themeScripts).toHaveLength(1); // the wishes in between are dropped: the last one is light, already applied
    expect(page.themeScripts[0]).toContain("Light Modern");
  });

  it("a toggle back to the starting theme while a switch is in flight ends with two switches, the last one the starting theme", async () => {
    const world = makeWorld({ accepted: true });
    world.dark.value = true;
    const h = await running(world);
    const page = world.webviews()[0].page!;
    const gate = deferred();
    page.themeGate = gate.promise;
    const first = h.themeChanged(false);
    await new Promise((r) => setTimeout(r, 5));
    const second = h.themeChanged(true);
    page.themeGate = null;
    gate.release();
    await Promise.all([first, second]);
    expect(page.themeScripts).toHaveLength(2);
    expect(page.themeScripts[0]).toContain("Light Modern");
    expect(page.themeScripts[1]).toContain("Dark Modern");
  });

  it("a flip while the page is still loading is not sent to a page that cannot take it; the page is switched once it is ready", async () => {
    const world = makeWorld({ accepted: true });
    world.dark.value = true;
    // The seed is built dark; Obsidian flips to light right after, while the page is still loading.
    let flipped: Promise<void> | null = null;
    const overlay = world.deps.workbenchOverlay;
    world.deps.workbenchOverlay = () => {
      const o = overlay();
      world.dark.value = false;
      flipped = host!.themeChanged(false);
      return o;
    };
    host = new TerminalHostPage(world.deps);
    host.show();
    await host.settled();
    await flipped;
    const wv = world.webviews()[0];
    expect(wv.executed[0]).toContain('"workbench.colorTheme":"Dark Modern"');
    await vi.waitFor(() => expect(wv.page!.themeScripts).toHaveLength(1));
    expect(wv.page!.themeScripts[0]).toContain("Light Modern");
    expect(host.view()).toBe("running");
  });

  it("a theme change after unload does nothing", async () => {
    const world = makeWorld({ accepted: true });
    const h = await running(world);
    const page = world.webviews()[0].page!;
    h.dispose();
    await h.themeChanged(false);
    expect(page.themeScripts).toEqual([]);
  });
});
