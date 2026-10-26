import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { BROWSER_APP_SETTINGS, buildBrowserSeedScript, buildMachineSettings, writeMachineSettings } from "../../src/settings";
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

async function runSeed(initial?: Record<string, unknown>) {
  const fake = fakeIndexedDB(initial);
  const run = new Function("indexedDB", "TextEncoder", "TextDecoder", `return ${buildBrowserSeedScript()}`) as (...a: unknown[]) => Promise<string>;
  const outcome = await run(fake.indexedDB, TextEncoder, TextDecoder);
  const raw = fake.stores.get("vscode-userdata-store")?.get("/User/settings.json") as Uint8Array | string | undefined;
  const text = raw === undefined ? undefined : typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  return { outcome, text, ...fake };
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
