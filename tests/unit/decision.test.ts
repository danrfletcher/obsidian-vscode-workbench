import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDecision, stopMessage } from "../decision";
import { REPO_ROOT } from "../helpers";

const ok = "---\nembed: works\nchrome: hidden\nhotkey_bridge: yes\nextensionless: intercept\n---\nbody";

describe("parseDecision", () => {
  it("reads the four fields", () => {
    expect(parseDecision(ok)).toEqual({ embed: "works", chrome: "hidden", hotkey_bridge: "yes", extensionless: "intercept" });
  });

  it.each(["embed", "chrome", "hotkey_bridge", "extensionless"])("fails when %s is missing", (field) => {
    const text = ok
      .split("\n")
      .filter((l) => !l.startsWith(`${field}:`))
      .join("\n");
    expect(() => parseDecision(text)).toThrow(`missing "${field}"`);
  });

  it("fails on a value outside the allowed set", () => {
    expect(() => parseDecision(ok.replace("embed: works", "embed: maybe"))).toThrow(/must be one of works\|partial\|fails/);
  });

  it("fails when there is no header at all", () => {
    expect(() => parseDecision("# just prose")).toThrow(/no header/);
  });
});

describe("stopMessage", () => {
  it("says 'STOP: ask Dan' when the embed fails", () => {
    expect(stopMessage({ embed: "fails", chrome: "visible", hotkey_bridge: "no", extensionless: "intercept" })).toMatch(/^STOP: ask Dan/);
  });

  it("is silent for works or partial", () => {
    expect(stopMessage({ embed: "works", chrome: "hidden", hotkey_bridge: "yes", extensionless: "intercept" })).toBeNull();
    expect(stopMessage({ embed: "partial", chrome: "visible", hotkey_bridge: "no", extensionless: "system-app" })).toBeNull();
  });
});

describe("docs/spike-decision.md", () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, "docs/spike-decision.md"), "utf8");

  it("has a complete, valid header", () => {
    expect(() => parseDecision(text)).not.toThrow();
  });

  it("is not a failed spike: a `fails` embed turns this test red with the STOP message", () => {
    const stop = stopMessage(parseDecision(text));
    expect(stop, stop ?? "").toBeNull();
  });

  it("records every unknown with a result and lists the conditional checks", () => {
    const unknowns = [
      "iframe runs in Obsidian",
      "Token-file auth",
      "Extension sharing",
      "Chrome hiding",
      "Theme follows",
      "IntelliSense",
      "Hotkey bridge",
      "Extensionless-file",
      "node / Python versions",
    ];
    for (const unknown of unknowns) {
      const row = text.split("\n").find((l) => l.startsWith("|") && l.toLowerCase().includes(unknown.toLowerCase()));
      expect(row, unknown).toBeDefined();
      expect(row, unknown).toMatch(/WORKS|PARTIAL|FAILS|NO|NOT PROBED|RECORDED/);
    }
    expect(text).toContain("Which later checks apply");
    expect(text).toContain("STOP: ask Dan");
  });
});
