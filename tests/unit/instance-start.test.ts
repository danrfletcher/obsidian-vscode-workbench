/**
 * Which instance a server start runs on (PR-3 R2): `resolveInstanceForStart` probes only the build the
 * choice needs, and still gives what a full scan followed by chooseInstance would.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { chooseInstance } from "../../src/instances/choose";
import { resolveInstanceForStart, scanInstances } from "../../src/instances/scan";
import type { ProbeResult } from "../../src/instances/probe";
import { makeAllKnown, PASS_SCRIPT } from "../instance-helpers";
import { tempDir } from "../helpers";
import * as fs from "node:fs";

function recordingProbe(answers: Record<string, ProbeResult> = {}, asked: string[] = []) {
  return async (cli: string): Promise<ProbeResult> => {
    asked.push(cli);
    const app = cli.split(path.sep).find((s) => s.endsWith(".app")) ?? cli;
    return answers[app] ?? { ok: true };
  };
}

const appOf = (cli: string | undefined) => cli?.split(path.sep).find((s) => s.endsWith(".app"));

describe("resolveInstanceForStart", () => {
  it("probes only the default (the newest VS Code build) and leaves the other four alone", async () => {
    const root = tempDir();
    makeAllKnown(root);
    const asked: string[] = [];
    const chosen = await resolveInstanceForStart({ roots: [root], savedId: null, probe: recordingProbe({}, asked) });
    expect(chosen?.kind).toBe("vscode-insiders");
    expect(asked).toEqual([chosen?.cli]);
  });

  it("probes only the saved build when there is one", async () => {
    const root = tempDir();
    makeAllKnown(root);
    const all = await scanInstances({ roots: [root], probe: recordingProbe() });
    const saved = all.instances.find((i) => i.kind === "vscodium")!;
    const asked: string[] = [];
    const chosen = await resolveInstanceForStart({ roots: [root], savedId: saved.id, probe: recordingProbe({}, asked) });
    expect(chosen?.id).toBe(saved.id);
    expect(asked).toEqual([saved.cli]);
  });

  it("a build that hangs but is not the one chosen costs the start nothing", async () => {
    const root = tempDir();
    makeAllKnown(root);
    const probe = (cli: string): Promise<ProbeResult> => (cli.includes("VSCodium") ? new Promise(() => undefined) : Promise.resolve({ ok: true }));
    const started = Date.now();
    const chosen = await resolveInstanceForStart({ roots: [root], savedId: null, probe, scanTimeoutMs: 5000 });
    expect(chosen?.kind).toBe("vscode-insiders");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("gives what a full scan plus chooseInstance gives, when the saved or default build fails its probe", async () => {
    const root = tempDir();
    makeAllKnown(root);
    const answers: Record<string, ProbeResult> = {};
    const full = () => scanInstances({ roots: [root], probe: recordingProbe(answers) });
    for (const failing of [[], ["Visual Studio Code - Insiders.app"], ["Visual Studio Code - Insiders.app", "Visual Studio Code.app"]]) {
      for (const k of Object.keys(answers)) delete answers[k];
      for (const f of failing) answers[f] = { ok: false, reason: "no serve-web" };
      const scan = await full();
      for (const savedId of [null, scan.instances[0]?.id ?? null, "vscode:/gone.app", ...failing.map((f) => `vscode-insiders:${path.join(root, f)}`)]) {
        const asked: string[] = [];
        const got = await resolveInstanceForStart({ roots: [root], savedId, probe: recordingProbe(answers, asked) });
        expect(got?.id ?? null).toBe(chooseInstance(scan, savedId).selected?.id ?? null);
        expect(new Set(asked).size).toBe(asked.length); // nothing is probed twice
        expect(appOf(asked.at(-1))).toBe(appOf(got?.cli));
      }
    }
  });

  it("gives null when nothing passes, and when there is nothing installed", async () => {
    const root = tempDir();
    makeAllKnown(root);
    const no = async (): Promise<ProbeResult> => ({ ok: false, reason: "nope" });
    expect(await resolveInstanceForStart({ roots: [root], savedId: null, probe: no })).toBeNull();
    expect(await resolveInstanceForStart({ roots: [tempDir()], savedId: null, probe: recordingProbe() })).toBeNull();
  });

  it("the saved custom CLI is a candidate: chosen when saved, and not probed otherwise", async () => {
    const root = tempDir();
    makeAllKnown(root);
    const custom = path.join(tempDir(), "mycode");
    fs.writeFileSync(custom, PASS_SCRIPT, { mode: 0o755 });
    const asked: string[] = [];
    const picked = await resolveInstanceForStart({ roots: [root], customCliPath: custom, savedId: "custom", probe: recordingProbe({}, asked) });
    expect(picked?.id).toBe("custom");
    expect(asked).toEqual([custom]);
    const other: string[] = [];
    const dflt = await resolveInstanceForStart({ roots: [root], customCliPath: custom, savedId: null, probe: recordingProbe({}, other) });
    expect(dflt?.kind).toBe("vscode-insiders");
    expect(other).not.toContain(custom);
  });

  it("a custom CLI that is not there is skipped without a probe", async () => {
    const asked: string[] = [];
    const got = await resolveInstanceForStart({ roots: [], customCliPath: "/no/such/cli", savedId: "custom", probe: recordingProbe({}, asked) });
    expect(got).toBeNull();
    expect(asked).toEqual([]);
  });
});
