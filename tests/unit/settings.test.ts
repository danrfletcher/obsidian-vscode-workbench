import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { BROWSER_APP_SETTINGS, USER_DATA_MARKER_KEY, buildBrowserSeedScript, buildMachineSettings, writeMachineSettings, type UserDataCopy } from "../../src/settings";
import { excludeGlobs } from "../../src/server/user-data-seed";
import { STOP_TEXT, describeExtensionsSection, describePort, renderExtensionsSection, type PortStatus, type SpikeResult } from "../../src/settings/extensions-section";
import { SPIKE_RESULT } from "../../src/settings/spike-result";
import { FakeNode } from "../mocks/obsidian";
import { tempDir } from "../helpers";

describe("writeMachineSettings", () => {
  it("writes the dark theme and chrome-hiding settings into the plugin's own server data dir", () => {
    const dir = tempDir();
    const file = writeMachineSettings(dir, { dark: true });
    expect(file).toBe(path.join(dir, "data", "Machine", "settings.json"));
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(s["workbench.colorTheme"]).toBe("Dark Modern");
    expect(s["workbench.activityBar.location"]).toBe("hidden");
    expect(s["workbench.statusBar.visible"]).toBe(false);
    expect(s["telemetry.telemetryLevel"]).toBe("off");
  });

  it("leaves Workspace Trust on (the Machine file cannot switch it off, and a silent trust-off would trust the whole vault)", () => {
    const s = JSON.parse(fs.readFileSync(writeMachineSettings(tempDir(), { dark: true }), "utf8")) as Record<string, unknown>;
    expect(s).not.toHaveProperty("security.workspace.trust.enabled");
  });

  it("switches to the light theme and rewrites the same file", () => {
    const dir = tempDir();
    writeMachineSettings(dir, { dark: true });
    const file = writeMachineSettings(dir, { dark: false });
    expect((JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>)["workbench.colorTheme"]).toBe("Light Modern");
  });
});

describe("workspace excludes in the Machine file (G16)", () => {
  it("carries the five excludes under files.watcherExclude and search.exclude, light or dark, on every rewrite", () => {
    const dir = tempDir();
    const file = writeMachineSettings(dir, { dark: true });
    const first = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    writeMachineSettings(dir, { dark: false }); // what css-change does
    const second = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const expected = {
      "**/.git": true,
      "**/.obsidian": true,
      "**/Attachments": true,
      "**/node_modules": true,
      "**/_to_delete": true,
    };
    for (const s of [first, second]) {
      expect(s["files.watcherExclude"]).toEqual(expected);
      expect(s["search.exclude"]).toEqual(expected);
    }
    expect(excludeGlobs()).toEqual(expected);
  });
});

describe("application-scoped off switches (F5)", () => {
  it("lists the switches for extension updates, update checks, experiments, recommendations and telemetry", () => {
    expect(BROWSER_APP_SETTINGS).toEqual({
      "extensions.autoUpdate": false,
      "extensions.autoCheckUpdates": false,
      "extensions.ignoreRecommendations": true,
      "workbench.enableExperiments": false,
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
      "update.showReleaseNotes": false,
    });
  });

  it("also carries them in the Machine file (harmless, but measured to have no effect there)", () => {
    const s = buildMachineSettings({ dark: false });
    for (const [k, v] of Object.entries(BROWSER_APP_SETTINGS)) expect(s[k]).toEqual(v);
  });
});

/** The smallest IndexedDB the seed script touches: one database, named stores, get/put. */
function fakeIndexedDB(initial: Record<string, unknown> = {}) {
  const stores = new Map<string, Map<string, unknown>>();
  const state = { version: 0, opened: [] as [string, number][], closed: 0 };
  if (Object.keys(initial).length) {
    stores.set("vscode-userdata-store", new Map(Object.entries(initial)));
    state.version = 3;
  }
  const request = <T>(run: () => T) => {
    const r: { result?: T; error?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
    queueMicrotask(() => {
      r.result = run();
      r.onsuccess?.();
    });
    return r;
  };
  const db = {
    objectStoreNames: { contains: (n: string) => stores.has(n) },
    createObjectStore: (n: string) => stores.set(n, new Map()),
    close: () => void state.closed++,
    transaction: (n: string) => {
      const tx: { oncomplete?: () => void; onerror?: () => void; objectStore: (x: string) => unknown } = {
        objectStore: () => ({
          get: (k: string) => request(() => stores.get(n)?.get(k)),
          put: (v: unknown, k: string) => {
            stores.get(n)?.set(k, v);
            queueMicrotask(() => tx.oncomplete?.());
          },
          delete: (k: string) => {
            stores.get(n)?.delete(k);
            queueMicrotask(() => tx.oncomplete?.());
          },
        }),
      };
      return tx;
    },
  };
  const indexedDB = {
    open: (name: string, version: number) => {
      state.opened.push([name, version]);
      const r: { result: typeof db; onupgradeneeded?: () => void; onsuccess?: () => void; error?: unknown; onerror?: () => void } = { result: db };
      queueMicrotask(() => {
        if (state.version < version) {
          state.version = version;
          r.onupgradeneeded?.();
        }
        r.onsuccess?.();
      });
      return r;
    },
  };
  return { indexedDB, stores, state };
}

/** localStorage of the server's origin: survives across seed runs when the same object is passed. */
function fakeStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), map: m };
}

async function runSeed(initial?: Record<string, unknown>, copy?: UserDataCopy | null, storage = fakeStorage()) {
  const fake = fakeIndexedDB(initial);
  const run = new Function("indexedDB", "localStorage", "TextEncoder", "TextDecoder", `return ${buildBrowserSeedScript(BROWSER_APP_SETTINGS, copy)}`) as (...a: unknown[]) => Promise<string>;
  const outcome = await run(fake.indexedDB, storage, TextEncoder, TextDecoder);
  const raw = fake.stores.get("vscode-userdata-store")?.get("/User/settings.json") as Uint8Array | string | undefined;
  const text = raw === undefined ? undefined : typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  const kb = fake.stores.get("vscode-userdata-store")?.get("/User/keybindings.json") as Uint8Array | undefined;
  return { outcome, text, keybindings: kb === undefined ? undefined : new TextDecoder().decode(kb), storage, ...fake };
}

describe("buildBrowserSeedScript (run against a fake IndexedDB)", () => {
  it("creates the workbench's database and writes the off switches into /User/settings.json", async () => {
    const r = await runSeed();
    expect(r.outcome).toBe("seeded");
    expect(r.state.opened).toEqual([["vscode-web-db", 3]]);
    expect([...r.stores.keys()].sort()).toEqual(["vscode-filehandles-store", "vscode-logs-store", "vscode-userdata-store"]);
    expect(JSON.parse(r.text as string)).toEqual(BROWSER_APP_SETTINGS);
    expect(r.state.closed).toBe(1);
  });

  it("keeps settings the user already has and overrides only the off switches", async () => {
    const existing = JSON.stringify({ "editor.fontSize": 18, "extensions.autoUpdate": true });
    const r = await runSeed({ "/User/settings.json": new TextEncoder().encode(existing) });
    expect(r.outcome).toBe("seeded");
    expect(JSON.parse(r.text as string)).toEqual({ ...BROWSER_APP_SETTINGS, "editor.fontSize": 18 });
  });

  it("leaves a settings file it cannot parse (comments) untouched", async () => {
    const commented = '{\n  // my font\n  "editor.fontSize": 18\n}';
    const r = await runSeed({ "/User/settings.json": new TextEncoder().encode(commented) });
    expect(r.outcome).toBe("kept");
    expect(r.text).toContain("// my font");
    expect(r.text).not.toContain("extensions.autoUpdate");
    expect(r.state.closed).toBe(1);
  });
});

describe("buildBrowserSeedScript with the copy of the instance's settings and keybindings (G17)", () => {
  const kb = '[{ "key": "ctrl+alt+n", "command": "workbench.action.toggleSidebarVisibility" }] // mine\n';
  const copy: UserDataCopy = {
    id: "start-1",
    settings: { "editor.fontSize": 23, "extensions.autoUpdate": true, "search.exclude": { "**/.obsidian": true, "**/mine": true } },
    keybindingsBase64: Buffer.from(kb).toString("base64"),
  };

  it("writes the copied keys and the keybindings into the browser profile, the off switches winning", async () => {
    const r = await runSeed(undefined, copy);
    expect(r.outcome).toBe("seeded");
    expect(JSON.parse(r.text as string)).toEqual({ ...copy.settings, ...BROWSER_APP_SETTINGS });
    expect(r.keybindings).toBe(kb); // byte for byte, comment included
    expect(r.storage.map.get(USER_DATA_MARKER_KEY)).toBe("start-1");
  });

  it("replaces a copy from an earlier start, and removes keybindings the instance no longer has", async () => {
    const r = await runSeed(
      { "/User/settings.json": new TextEncoder().encode(JSON.stringify({ "editor.fontSize": 9, "editor.tabSize": 3 })), "/User/keybindings.json": new TextEncoder().encode("[]") },
      { ...copy, id: "start-2", keybindingsBase64: null },
    );
    // the copy replaces the profile's file whole: a key set inside the tab (editor.tabSize) or removed from the instance is gone
    expect(JSON.parse(r.text as string)).toEqual({ ...copy.settings, ...BROWSER_APP_SETTINGS });
    expect(r.keybindings).toBeUndefined();
  });

  it("drops a key the instance removed since the last start, instead of keeping it in the profile (PR-3 R4)", async () => {
    const storage = fakeStorage();
    const first = await runSeed(undefined, { ...copy, settings: { "editor.fontSize": 23, "editor.rulers": [80] } }, storage);
    expect(JSON.parse(first.text as string)["editor.rulers"]).toEqual([80]);
    const second = await runSeed(
      { "/User/settings.json": new TextEncoder().encode(first.text as string) },
      { ...copy, id: "start-2", settings: { "editor.fontSize": 23 } },
      storage,
    );
    expect(JSON.parse(second.text as string)).toEqual({ "editor.fontSize": 23, ...BROWSER_APP_SETTINGS });
  });

  it("applies a copy once per server start: a tab reload keeps what the user changed in the tab", async () => {
    const storage = fakeStorage();
    const first = await runSeed(undefined, copy, storage);
    // the user changes the font size in the tab; the tab reloads and seeds again with the same copy id
    const edited = { ...JSON.parse(first.text as string), "editor.fontSize": 40 };
    const second = await runSeed({ "/User/settings.json": new TextEncoder().encode(JSON.stringify(edited)) }, copy, storage);
    expect(JSON.parse(second.text as string)["editor.fontSize"]).toBe(40);
    // a new server start has a new id: the instance's value is applied again
    const third = await runSeed({ "/User/settings.json": new TextEncoder().encode(JSON.stringify(edited)) }, { ...copy, id: "start-2" }, storage);
    expect(JSON.parse(third.text as string)["editor.fontSize"]).toBe(23);
  });

  it("replaces a profile settings file that no longer parses when a new copy is due, so the copy still reaches the editor (PR-3 R5)", async () => {
    const r = await runSeed({ "/User/settings.json": new TextEncoder().encode('{ // hand edited in the tab\n}') }, copy);
    expect(r.outcome).toBe("seeded");
    expect(JSON.parse(r.text as string)).toEqual({ ...copy.settings, ...BROWSER_APP_SETTINGS });
    expect(r.keybindings).toBe(kb);
    expect(r.storage.map.get(USER_DATA_MARKER_KEY)).toBe("start-1");
  });

  it("on a tab reload within one start, a file that no longer parses is kept and the outcome says so (PR-3 R5)", async () => {
    const storage = fakeStorage();
    storage.setItem(USER_DATA_MARKER_KEY, "start-1"); // this start's copy is already applied
    const r = await runSeed({ "/User/settings.json": new TextEncoder().encode('{ // hand edited\n}') }, copy, storage);
    expect(r.outcome).toBe("kept");
    expect(r.text).toContain("// hand edited");
  });
});

describe("buildBrowserSeedScript when VS Code's database is not what the plugin expects (PR-1 R9)", () => {
  const script = () => new Function("indexedDB", "localStorage", "TextEncoder", "TextDecoder", `return ${buildBrowserSeedScript(BROWSER_APP_SETTINGS, null)}`) as (...a: unknown[]) => Promise<string>;

  it("answers version-mismatch when the database is already at a newer version", async () => {
    const indexedDB = {
      open: () => {
        const r: { error: unknown; onerror?: () => void } = { error: { name: "VersionError" } };
        queueMicrotask(() => r.onerror?.());
        return r;
      },
    };
    expect(await script()(indexedDB, fakeStorage(), TextEncoder, TextDecoder)).toBe("version-mismatch");
  });

  it("answers no-store when the database has no user-data store", async () => {
    let closed = 0;
    const indexedDB = {
      open: () => {
        const r: { result: unknown; onsuccess?: () => void } = { result: { objectStoreNames: { contains: () => false }, close: () => void closed++ } };
        queueMicrotask(() => r.onsuccess?.());
        return r;
      },
    };
    expect(await script()(indexedDB, fakeStorage(), TextEncoder, TextDecoder)).toBe("no-store");
    expect(closed).toBe(1);
  });

  it("answers error:<name> for anything else the page refuses, and still closes the database", async () => {
    const real = fakeIndexedDB({ "/User/settings.json": "{}" });
    const db = (real.indexedDB.open("x", 3) as { result: { transaction: unknown } }).result;
    db.transaction = () => {
      throw Object.assign(new Error("denied"), { name: "SecurityError" });
    };
    const indexedDB = { open: () => { const r: { result: unknown; onsuccess?: () => void } = { result: db }; queueMicrotask(() => r.onsuccess?.()); return r; } };
    expect(await script()(indexedDB, fakeStorage(), TextEncoder, TextDecoder)).toBe("error:SecurityError");
    expect(real.state.closed).toBe(1);
  });
});

describe("the Extensions section of the settings tab", () => {
  const OK: SpikeResult = {
    measuredOn: "2026-10-27",
    vscodeVersion: "1.145.0-insider",
    stablePort: { stable: true, result: "Same origin after a restart.", decision: "Store one port per vault." },
    trustRecord: { found: true, location: "db-x / ItemTable / content.trust.model.key", result: "Written by the Trust click.", decision: "Seed it in PR-2." },
    settingsRoute: { arrives: true, route: "the IndexedDB write", result: "fontSize 12px to 23px.", decision: "PR-6 builds on the IndexedDB write." },
    turboConsoleLog: { state: "active", cause: "Restricted Mode kept it from activating", result: "Activation logged after trust.", decision: "Trust is the fix." },
  };
  const PORT: PortStatus = { stored: 51789, current: 51789, note: null };
  const draw = (result: SpikeResult | null, port: PortStatus = PORT) => {
    const el = new FakeNode("div");
    renderExtensionsSection(el as unknown as HTMLElement, describeExtensionsSection(result, port));
    const rows = el.all().filter((n) => n.cls?.includes("workbench-extensions-row"));
    return {
      el,
      text: el.all().map((n) => n.text).join("\n"),
      row: (name: string) => rows.find((r) => r.children[0]?.text === name),
      tone: (name: string) => rows.find((r) => r.children[0]?.text === name)?.children[1],
    };
  };

  it("measured OK: the decision for each of the four questions, the date and the port in use", () => {
    const d = draw(OK);
    expect(d.text).toContain("Extensions");
    expect(d.row("Measured")?.children[1].text).toBe("2026-10-27, on VS Code 1.145.0-insider.");
    expect(d.row("Stable port")?.children[1].text).toBe("Same origin after a restart. Decision: Store one port per vault.");
    expect(d.row("Stable port in use")?.children[1].text).toBe("Port 51789 (stored), in use by the running server.");
    expect(d.row("Trust record")?.children[1].text).toBe("Found at db-x / ItemTable / content.trust.model.key. Written by the Trust click. Decision: Seed it in PR-2.");
    expect(d.row("Settings and keybindings")?.children[1].text).toBe("Route: the IndexedDB write. fontSize 12px to 23px. Decision: PR-6 builds on the IndexedDB write.");
    expect(d.row("Turbo Console Log")?.children[1].text).toBe("active. Cause: Restricted Mode kept it from activating. Activation logged after trust. Decision: Trust is the fix.");
    expect(d.text).not.toContain("STOP");
    expect(d.text).not.toContain("not found");
  });

  it("STOP: the settings route row shows the stop text, in the error colour, and the others are unaffected", () => {
    const stop: SpikeResult = { ...OK, settingsRoute: { arrives: false, route: null, result: "No route moved editor.fontSize.", decision: "STOP: ask Dan." } };
    const d = draw(stop);
    const row = d.tone("Settings and keybindings")!;
    expect(row.text).toBe(`${STOP_TEXT} No route moved editor.fontSize.`);
    expect(row.text.startsWith("STOP:")).toBe(true);
    expect(d.row("Settings and keybindings")?.cls).toContain("workbench-error");
    expect(row.style.color).toBeFalsy();
    expect(d.row("Trust record")?.children[1].text).toContain("Found at");
  });

  it("trust record not found: the row says \"not found\" and claims no location or format", () => {
    const d = draw({ ...OK, trustRecord: { found: false, location: null, result: "No key with trust in its name changed.", decision: "Build nothing on it." } });
    const row = d.tone("Trust record")!;
    expect(row.text).toBe("not found. No key with trust in its name changed. Decision: Build nothing on it.");
    expect(row.text).not.toContain("Found at");
    expect(d.row("Trust record")?.cls).toContain("workbench-warning");
    expect(row.style.color).toBeFalsy();
  });

  it("no record yet: one line saying so, and the port still shown", () => {
    const d = draw(null, { stored: null, current: null, note: null });
    expect(d.row("Extension spike")?.children[1].text).toBe("No spike result recorded yet.");
    expect(d.row("Stable port in use")?.children[1].text).toContain("None stored yet");
    expect(d.row("Trust record")).toBeUndefined();
  });

  it("a failing Turbo Console Log shows the separate finding with its real cause", () => {
    const d = draw({ ...OK, turboConsoleLog: { state: "failed", cause: "Cannot find module 'x' (extension host log)", result: "Activated, then threw.", decision: "Fix that first." } });
    expect(d.tone("Turbo Console Log")?.text).toBe("failed. Cause: Cannot find module 'x' (extension host log). Activated, then threw. Decision: Fix that first.");
  });

  it("no text is drawn in a tone colour: --text-success is 2.6:1 on white, so the tone is a row class (a bar) and the text keeps the theme's own colour", () => {
    const stop: SpikeResult = { ...OK, settingsRoute: { ...OK.settingsRoute, arrives: false }, trustRecord: { ...OK.trustRecord, found: false } };
    for (const result of [OK, stop]) {
      const d = draw(result);
      expect(d.el.all().map((n) => n.style.color).filter(Boolean)).toEqual([]);
    }
    const d = draw(OK);
    for (const name of ["Stable port", "Trust record", "Settings and keybindings", "Turbo Console Log"]) expect(d.row(name)?.cls).toContain("workbench-ok");
    expect(d.row("Measured")?.cls).toContain("workbench-info");
  });

  it("styles.css gives each tone its bar colour from a theme variable", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "src/styles.css"), "utf8");
    for (const [tone, v] of [["ok", "--text-success"], ["warning", "--text-warning"], ["error", "--text-error"]]) {
      expect(css).toMatch(new RegExp(`\\.workbench-extensions-row\\.workbench-${tone}\\s*\\{[^}]*border-left-color:\\s*var\\(${v}\\)`));
    }
    expect(css).not.toMatch(/\.workbench-message[^{]*\{[^}]*color:/);
  });

  it.each<[string, PortStatus, string]>([
    ["nothing stored, no server", { stored: null, current: null, note: null }, "None stored yet: the first server start picks a free port and stores it."],
    ["nothing stored, server running", { stored: null, current: 52000, note: null }, "Server running on port 52000; it will be stored as this vault's stable port."],
    ["stored, no server", { stored: 51789, current: null, note: null }, "Stored port 51789. No server is running; the next start tries this port first."],
    ["stored and in use", { stored: 51789, current: 51789, note: null }, "Port 51789 (stored), in use by the running server."],
    ["stored but another port in use, with the reason", { stored: 51789, current: 52000, note: "Another program has it." }, "Stored port 51789; the running server is on 52000 this time. Another program has it."],
  ])("the port line: %s", (_n, port, text) => {
    const row = describePort(port);
    expect(row.text).toBe(text);
    expect(row.tone).toBe(port.note ? "warning" : "info");
  });

  it("the recorded result shipped in SPIKE_RESULT has all four questions answered, a date, and no STOP", () => {
    expect(SPIKE_RESULT).not.toBeNull();
    const r = SPIKE_RESULT!;
    expect(r.measuredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const q of [r.stablePort, r.trustRecord, r.settingsRoute, r.turboConsoleLog]) {
      expect(q.result.length).toBeGreaterThan(0);
      expect(q.decision.length).toBeGreaterThan(0);
    }
    expect(r.settingsRoute.arrives).toBe(true);
    expect(r.settingsRoute.decision).not.toContain("STOP");
  });
});
