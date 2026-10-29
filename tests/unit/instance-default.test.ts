import { describe, expect, it } from "vitest";
import { chooseInstance, compareInstances, defaultInstance, parseVersionNumbers } from "../../src/instances/choose";
import { InstanceService } from "../../src/instances/service";
import type { Instance, ScanResult } from "../../src/instances/scan";

function inst(kind: Instance["kind"], version: string, extra: Partial<Instance> = {}): Instance {
  return {
    id: `${kind}:/Applications/${kind}-${version}.app`,
    kind,
    label: `${kind} ${version}`,
    version,
    userDataName: null,
    cli: `/Applications/${kind}-${version}.app/Contents/Resources/app/bin/code`,
    appPath: `/Applications/${kind}-${version}.app`,
    microsoft: kind === "vscode" || kind === "vscode-insiders",
    ...extra,
  };
}

const scan = (instances: Instance[], rest: Partial<ScanResult> = {}) => ({ instances, rejected: [], customFailure: null, ...rest });

describe("version comparison", () => {
  it("reads the numbers and ignores the -insider suffix", () => {
    expect(parseVersionNumbers("1.144.0-insider")).toEqual([1, 144, 0]);
    expect(parseVersionNumbers("1.143.1")).toEqual([1, 143, 1]);
    expect(parseVersionNumbers("2")).toEqual([2, 0, 0]);
    expect(parseVersionNumbers("")).toEqual([0, 0, 0]);
    expect(parseVersionNumbers("garbage")).toEqual([0, 0, 0]);
  });

  it("compares numerically, not as text (1.100 is newer than 1.99)", () => {
    expect(compareInstances(inst("vscode", "1.100.0"), inst("vscode", "1.99.9"))).toBeGreaterThan(0);
    expect(compareInstances(inst("vscode", "1.2.3"), inst("vscode", "1.2.10"))).toBeLessThan(0);
  });

  it("compares an Insiders build with a stable one by number, whichever kind is newer", () => {
    expect(compareInstances(inst("vscode-insiders", "1.144.0-insider"), inst("vscode", "1.143.1"))).toBeGreaterThan(0);
    expect(compareInstances(inst("vscode-insiders", "1.143.0-insider"), inst("vscode", "1.143.1"))).toBeLessThan(0);
  });

  it("on the same numbers stable wins over Insiders", () => {
    expect(compareInstances(inst("vscode", "1.144.0"), inst("vscode-insiders", "1.144.0-insider"))).toBeGreaterThan(0);
  });
});

describe("defaultInstance: the newest VS Code build", () => {
  it("is the newest of stable and Insiders", () => {
    const stable = inst("vscode", "1.143.1");
    const insiders = inst("vscode-insiders", "1.144.0-insider");
    expect(defaultInstance([stable, insiders])?.id).toBe(insiders.id);
    expect(defaultInstance([insiders, stable])?.id).toBe(insiders.id);
    expect(defaultInstance([stable, inst("vscode-insiders", "1.142.0-insider")])?.id).toBe(stable.id);
  });

  it("with only Insiders present, Insiders is the default", () => {
    const insiders = inst("vscode-insiders", "1.144.0-insider");
    expect(defaultInstance([inst("vscodium", "1.200.0"), insiders])?.id).toBe(insiders.id);
  });

  it("never prefers VSCodium or Antigravity to a VS Code build, however new", () => {
    const stable = inst("vscode", "1.1.0");
    expect(defaultInstance([inst("vscodium", "9.0.0"), inst("antigravity", "9.0.0"), stable])?.id).toBe(stable.id);
  });

  it("with no VS Code build, falls back to the newest of the others, a custom CLI last; null for none", () => {
    expect(defaultInstance([inst("vscodium", "1.140.0"), inst("antigravity", "1.2.0")])?.kind).toBe("vscodium");
    const custom = inst("custom", "", { id: "custom" });
    expect(defaultInstance([custom, inst("antigravity", "1.2.0")])?.kind).toBe("antigravity");
    expect(defaultInstance([custom])?.id).toBe("custom");
    expect(defaultInstance([])).toBeNull();
  });
});

describe("chooseInstance", () => {
  const stable = inst("vscode", "1.143.1");
  const insiders = inst("vscode-insiders", "1.144.0-insider");
  const codium = inst("vscodium", "1.140.0");

  it("uses the default when nothing is saved", () => {
    const s = chooseInstance(scan([stable, insiders, codium]), null);
    expect(s).toMatchObject({ usingSaved: false, problem: null });
    expect(s.selected?.id).toBe(insiders.id);
    expect(s.default?.id).toBe(insiders.id);
  });

  it("a saved choice always beats the default, even an older or non-VS-Code build", () => {
    expect(chooseInstance(scan([stable, insiders, codium]), codium.id)).toMatchObject({ usingSaved: true, problem: null, selected: { id: codium.id }, default: { id: insiders.id } });
    expect(chooseInstance(scan([stable, insiders]), stable.id).selected?.id).toBe(stable.id);
  });

  it("a saved id that vanished falls back to the default and says why; nothing is rewritten", () => {
    const gone = "vscode:/Applications/Gone.app";
    const s = chooseInstance(scan([stable, insiders]), gone);
    expect(s.selected?.id).toBe(insiders.id);
    expect(s.usingSaved).toBe(false);
    expect(s.problem).toEqual({ id: gone, reason: "it is no longer installed." });
  });

  it("a saved id that is installed but failed its check names the failure", () => {
    const failing = "antigravity-ide:/Applications/Antigravity IDE.app";
    const s = chooseInstance(
      scan([stable], { rejected: [{ label: "Antigravity IDE 1.3.0", appPath: "/Applications/Antigravity IDE.app", reason: "its serve-web check failed: ENOENT" }] }),
      failing,
    );
    expect(s.selected?.id).toBe(stable.id);
    expect(s.problem?.reason).toBe("Antigravity IDE 1.3.0 is installed but its serve-web check failed: ENOENT");
  });

  it("a saved custom CLI that stopped working reports the custom failure", () => {
    const s = chooseInstance(scan([stable], { customFailure: "the file no longer exists." }), "custom");
    expect(s.selected?.id).toBe(stable.id);
    expect(s.problem).toEqual({ id: "custom", reason: "the custom CLI failed its check: the file no longer exists." });
    expect(chooseInstance(scan([stable]), "custom").problem?.reason).toBe("the custom CLI path is not set.");
  });

  it("selects nothing, with the problem, when no instance exists at all", () => {
    const s = chooseInstance(scan([]), "vscode:/Applications/Visual Studio Code.app");
    expect(s.selected).toBeNull();
    expect(s.problem?.reason).toBe("it is no longer installed.");
    expect(chooseInstance(scan([]), null)).toMatchObject({ selected: null, problem: null });
  });
});

describe("InstanceService: at most one scan in flight", () => {
  function controlled() {
    const calls: Array<{ custom: string | null; done: (r: ScanResult) => void }> = [];
    let running = 0;
    let peak = 0;
    const service = new InstanceService(
      (o) =>
        new Promise<ScanResult>((resolve) => {
          running++;
          peak = Math.max(peak, running);
          calls.push({
            custom: o.customCliPath ?? null,
            done: (r) => {
              running--;
              resolve(r);
            },
          });
        }),
    );
    return { service, calls, peak: () => peak };
  }
  const result = (n: number): ScanResult => ({ instances: [inst("vscode", `1.${n}.0`)], rejected: [], customFailure: null });

  it("shares the running scan when the tab is opened again and again", async () => {
    const { service, calls } = controlled();
    const a = service.scan(null);
    const b = service.scan(null);
    const c = service.scan(null);
    expect(calls).toHaveLength(1);
    expect(service.started).toBe(1);
    calls[0].done(result(1));
    expect(await Promise.all([a, b, c])).toEqual([result(1), result(1), result(1)]);
  });

  it("scans again for the next open once the scan has finished", async () => {
    const { service, calls } = controlled();
    const a = service.scan(null);
    calls[0].done(result(1));
    await a;
    const b = service.scan(null);
    expect(calls).toHaveLength(2);
    calls[1].done(result(2));
    expect(await b).toEqual(result(2));
  });

  it("a request with a new custom path waits for the running scan, then scans with it: never two at once", async () => {
    const { service, calls, peak } = controlled();
    const first = service.scan(null);
    const second = service.scan("/my/code");
    expect(calls).toHaveLength(1);
    calls[0].done(result(1));
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(2);
    expect(calls[1].custom).toBe("/my/code");
    calls[1].done(result(2));
    expect(await second).toEqual(result(2));
    expect(peak()).toBe(1);
  });

  it("a failed scan does not block the next one", async () => {
    let n = 0;
    const service = new InstanceService(async () => {
      if (n++ === 0) throw new Error("boom");
      return result(3);
    });
    await expect(service.scan(null)).rejects.toThrow("boom");
    expect(await service.scan(null)).toEqual(result(3));
  });
});
