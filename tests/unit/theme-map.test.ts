import { describe, expect, it, vi } from "vitest";
import {
  DARK_THEME,
  LIGHT_THEME,
  SETTINGS_CHANGE_CHANNEL,
  THEME_SETTING,
  ThemeSync,
  buildThemeSwitchScript,
  isDarkBody,
  themeFor,
  themeSettings,
  themeSwitchMessage,
  type EmbedChannel,
  type ThemeSwitchMessage,
} from "../../src/theme-map";
import * as fs from "node:fs";
import * as path from "node:path";
import { WORKBENCH_DB } from "../../src/settings";

const body = (...classes: string[]) => ({ contains: (c: string) => classes.includes(c) });

describe("Obsidian light/dark to workbench.colorTheme (G6)", () => {
  it("maps the theme-dark body class to Dark Modern and anything else to Light Modern", () => {
    expect(isDarkBody(body("theme-dark"))).toBe(true);
    expect(isDarkBody(body("theme-light"))).toBe(false);
    expect(isDarkBody(body())).toBe(false);
    // a custom theme still carries theme-dark / theme-light on <body>, with extra classes
    expect(isDarkBody(body("my-custom-theme", "theme-dark", "is-translucent"))).toBe(true);
    expect(themeFor(true)).toBe("Dark Modern");
    expect(themeFor(false)).toBe("Light Modern");
    expect(DARK_THEME).toBe("Dark Modern");
    expect(LIGHT_THEME).toBe("Light Modern");
  });

  it("writes the theme under workbench.colorTheme", () => {
    expect(THEME_SETTING).toBe("workbench.colorTheme");
    expect(themeSettings(true)).toEqual({ "workbench.colorTheme": "Dark Modern" });
    expect(themeSettings(false)).toEqual({ "workbench.colorTheme": "Light Modern" });
  });
});

describe("the live switch message", () => {
  it("names the target theme and whether it is dark", () => {
    expect(themeSwitchMessage(true)).toEqual({ type: "workbench-theme", theme: "Dark Modern", dark: true });
    expect(themeSwitchMessage(false)).toEqual({ type: "workbench-theme", theme: "Light Modern", dark: false });
  });

  it("the script it becomes writes the theme into the browser profile's settings and tells the workbench, with no reload and no network", () => {
    for (const dark of [true, false]) {
      const script = buildThemeSwitchScript(themeSwitchMessage(dark));
      expect(script).toContain(JSON.stringify(themeFor(dark)));
      expect(script).toContain(JSON.stringify(WORKBENCH_DB.settingsKey));
      expect(script).toContain(JSON.stringify(SETTINGS_CHANGE_CHANNEL));
      expect(script).not.toMatch(/reload|location\./);
      // F5: nothing but the page's own IndexedDB and a same-origin broadcast
      expect(script).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|sendBeacon|https?:\/\/|importScripts|\.src\s*=/);
      expect(() => new Function(`return ${script}`)).not.toThrow();
    }
  });

  /** Run the script against stand-ins for the page: settings.json in a fake IndexedDB, a broadcast channel, a workbench that reacts to the broadcast. */
  async function runSwitch(message: ThemeSwitchMessage, o: { stored?: string | undefined; reacts?: boolean } = {}) {
    let stored: Uint8Array | string | undefined = o.stored === undefined ? undefined : o.stored;
    const posted: Array<{ channel: string; data: unknown }> = [];
    let darkNow = !message.dark; // the workbench shows the other theme to begin with
    const idb = {
      open: () => {
        const r: { onsuccess?: () => void; onerror?: () => void; result?: unknown } = {};
        r.result = {
          transaction: () => {
            const tx: { oncomplete?: () => void; objectStore: () => unknown } = {
              objectStore: () => ({
                get: () => {
                  const q: { onsuccess?: () => void; result?: unknown } = {};
                  setTimeout(() => {
                    q.result = stored;
                    q.onsuccess?.();
                  }, 0);
                  return q;
                },
                put: (value: Uint8Array) => {
                  stored = value;
                  setTimeout(() => tx.oncomplete?.(), 0);
                },
              }),
            };
            return tx;
          },
          close: () => undefined,
        };
        setTimeout(() => r.onsuccess?.(), 0);
        return r;
      },
    };
    class FakeChannel {
      constructor(public name: string) {}
      postMessage(data: unknown) {
        posted.push({ channel: this.name, data });
        if (o.reacts !== false) darkNow = message.dark;
      }
      close() {}
    }
    const document = { querySelector: () => (darkNow ? {} : null) };
    const run = new Function("indexedDB", "BroadcastChannel", "document", "TextEncoder", "TextDecoder", `return ${buildThemeSwitchScript(message)}`) as (...a: unknown[]) => Promise<string>;
    const result = await run(idb, FakeChannel, document, TextEncoder, TextDecoder);
    const text = stored === undefined ? undefined : typeof stored === "string" ? stored : new TextDecoder().decode(stored);
    return { result, text, posted };
  }

  it("changes only the theme in the stored settings, broadcasts the change and reports 'applied' once the workbench follows", async () => {
    const r = await runSwitch(themeSwitchMessage(true), { stored: JSON.stringify({ "editor.fontSize": 17, "workbench.colorTheme": "Light Modern" }) });
    expect(r.result).toBe("applied");
    expect(JSON.parse(r.text!)).toEqual({ "editor.fontSize": 17, "workbench.colorTheme": "Dark Modern" });
    expect(r.posted).toEqual([{ channel: SETTINGS_CHANGE_CHANNEL, data: [{ scheme: "vscode-userdata", path: "/User/settings.json" }] }]);
  });

  it("works from a profile that holds no settings yet", async () => {
    const r = await runSwitch(themeSwitchMessage(false));
    expect(r.result).toBe("applied");
    expect(JSON.parse(r.text!)).toEqual({ "workbench.colorTheme": "Light Modern" });
  });

  it("leaves a settings file it cannot parse alone", async () => {
    const r = await runSwitch(themeSwitchMessage(true), { stored: "{ // hand-edited" });
    expect(r.result).toBe("kept");
    expect(r.text).toBe("{ // hand-edited");
    expect(r.posted).toEqual([]);
  });

  it("reports 'unconfirmed' when the workbench never changes", async () => {
    vi.useFakeTimers();
    try {
      const pending = runSwitch(themeSwitchMessage(true), { stored: "{}", reacts: false });
      await vi.advanceTimersByTimeAsync(4000);
      expect((await pending).result).toBe("unconfirmed");
    } finally {
      vi.useRealTimers();
    }
  });
});

/** An embed that records what it is told, optionally slowly. */
function fakeEmbed(delayMs = 0) {
  const seen: ThemeSwitchMessage[] = [];
  const channel: EmbedChannel = {
    switchTheme: async (m) => {
      seen.push(m);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return "applied";
    },
  };
  return { channel, seen };
}

describe("ThemeSync: follows Obsidian without piling up work", () => {
  it("applies a change once and does nothing when the theme did not change", async () => {
    const applied: boolean[] = [];
    const sync = new ThemeSync((d) => void applied.push(d), false);
    await sync.set(false);
    expect(applied).toEqual([]);
    await sync.set(true);
    expect(applied).toEqual([true]);
    expect(sync.current).toBe(true);
  });

  it("ten toggles in a second end on the final theme, with each embed told only what changed", async () => {
    const embed = fakeEmbed(5);
    const sync = new ThemeSync(async (dark) => void (await embed.channel.switchTheme(themeSwitchMessage(dark))), false);
    const calls: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) calls.push(sync.set(i % 2 === 0)); // true, false, true, ... false
    await Promise.all(calls);
    expect(sync.current).toBe(false);
    expect(embed.seen.length).toBeLessThanOrEqual(3);
    expect(embed.seen.at(-1)).toEqual(themeSwitchMessage(false));
    // never two switches in flight at once: each message is a distinct, strictly alternating state
    for (let i = 1; i < embed.seen.length; i++) expect(embed.seen[i].dark).not.toBe(embed.seen[i - 1].dark);
  });

  it("ten toggles ending dark end dark", async () => {
    const embed = fakeEmbed(5);
    const sync = new ThemeSync(async (dark) => void (await embed.channel.switchTheme(themeSwitchMessage(dark))), false);
    const calls: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) calls.push(sync.set(i % 2 === 1)); // false, true, ..., true
    await Promise.all(calls);
    expect(sync.current).toBe(true);
    expect(embed.seen.at(-1)?.dark).toBe(true);
  });

  it("leaves no timer behind", async () => {
    vi.useFakeTimers();
    try {
      const sync = new ThemeSync(() => undefined, false);
      for (let i = 0; i < 10; i++) void sync.set(i % 2 === 0);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failing apply is logged and the next change still goes through", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let fail = true;
    const applied: boolean[] = [];
    const sync = new ThemeSync((d) => {
      applied.push(d);
      if (fail) throw new Error("boom");
    }, false);
    await sync.set(true);
    fail = false;
    await sync.set(false);
    expect(applied).toEqual([true, false]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("markApplied (a server start wrote the theme already) means the same theme is not applied again", async () => {
    const applied: boolean[] = [];
    const sync = new ThemeSync((d) => void applied.push(d), false);
    sync.markApplied(true);
    await sync.set(true);
    expect(applied).toEqual([]);
  });
});

describe("F5: the sync and theme code makes no network request", () => {
  it.each(["theme-map", "vault-sync", "tab-registry", "chrome-settings", "dirty-guard"])("src/%s.ts has no network API and no outside address", (name) => {
    const code = fs.readFileSync(path.join(__dirname, "..", "..", "src", `${name}.ts`), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|node:https?|node:net|require\(["']https?["']\)/);
    expect(code).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
  });
});
