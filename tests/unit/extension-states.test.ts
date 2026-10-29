import { describe, expect, it } from "vitest";
import { STATE_LABEL, STATE_PRECEDENCE, STATE_TONE, cleanText, resolveState, type ExtensionState, type LogFacts, type StateFacts } from "../../src/settings/extension-states";

const NO_LOG: LogFacts = { found: false };
const QUIET: LogFacts = { found: true, failed: null, activated: false };
const ACTIVE: LogFacts = { found: true, failed: null, activated: true };
const FAILED: LogFacts = { found: true, failed: { reason: "Cannot find module 'x'" }, activated: true };

const facts = (over: Partial<StateFacts>): StateFacts => ({ disabled: false, untrusted: false, log: QUIET, ...over });

describe("resolveState: precedence disabled > untrusted > failed > active > inactive (G11)", () => {
  // Hand-written: each case names the facts that apply and the one state expected.
  it.each<[string, StateFacts, ExtensionState]>([
    // each state alone
    ["disabled alone", facts({ disabled: true }), "disabled"],
    ["untrusted alone", facts({ untrusted: true }), "untrusted"],
    ["failed alone", facts({ log: FAILED }), "failed"],
    ["active alone", facts({ log: ACTIVE }), "active"],
    ["inactive: the log has nothing on it", facts({}), "inactive"],
    ["inactive: there is no log", facts({ log: NO_LOG }), "inactive"],
    // every pair where two apply: the higher one wins
    ["disabled + untrusted", facts({ disabled: true, untrusted: true }), "disabled"],
    ["disabled + failed", facts({ disabled: true, log: FAILED }), "disabled"],
    ["disabled + active", facts({ disabled: true, log: ACTIVE }), "disabled"],
    ["disabled + inactive", facts({ disabled: true, log: QUIET }), "disabled"],
    ["untrusted + failed", facts({ untrusted: true, log: FAILED }), "untrusted"],
    ["untrusted + active", facts({ untrusted: true, log: ACTIVE }), "untrusted"],
    ["untrusted + inactive", facts({ untrusted: true, log: QUIET }), "untrusted"],
    ["failed + active (activation logged, then the error)", facts({ log: FAILED }), "failed"],
    ["failed + inactive is just failed", facts({ log: { found: true, failed: { reason: null }, activated: false } }), "failed"],
    ["active + inactive is just active", facts({ log: ACTIVE }), "active"],
    // everything at once
    ["all of them", facts({ disabled: true, untrusted: true, log: FAILED }), "disabled"],
  ])("%s -> %s", (_name, f, expected) => {
    expect(resolveState(f).state).toBe(expected);
  });

  it("an exhaustive sweep of the 20 combinations agrees with the precedence list", () => {
    const logs: Array<[LogFacts, ExtensionState[]]> = [
      [NO_LOG, ["inactive"]],
      [QUIET, ["inactive"]],
      [ACTIVE, ["active", "inactive"]],
      [FAILED, ["failed", "active", "inactive"]],
      [{ found: true, failed: { reason: null }, activated: false }, ["failed", "inactive"]],
    ];
    let n = 0;
    for (const disabled of [false, true]) {
      for (const untrusted of [false, true]) {
        for (const [log, fromLog] of logs) {
          const applies = new Set<ExtensionState>(fromLog);
          if (disabled) applies.add("disabled");
          if (untrusted) applies.add("untrusted");
          const first = STATE_PRECEDENCE.find((s) => applies.has(s));
          expect(resolveState({ disabled, untrusted, log }).state, JSON.stringify({ disabled, untrusted, log })).toBe(first);
          n++;
        }
      }
    }
    expect(n).toBe(20);
  });

  it("the precedence list is exactly disabled, untrusted, failed, active, inactive", () => {
    expect([...STATE_PRECEDENCE]).toEqual(["disabled", "untrusted", "failed", "active", "inactive"]);
  });

  it("an extension that is both disabled in VS Code and failed reads \"disabled in VS Code\"", () => {
    const r = resolveState(facts({ disabled: true, log: FAILED }));
    expect(r.label).toBe("disabled in VS Code");
    expect(r.reason).not.toContain("Cannot find module");
  });
});

describe("resolveState: label and reason wording per state", () => {
  it("disabled", () => {
    expect(resolveState(facts({ disabled: true }))).toEqual({
      state: "disabled",
      label: "disabled in VS Code",
      reason: "switched off in desktop VS Code, so the tab does not run it; changes made there show here after Restart server",
    });
  });

  it("untrusted", () => {
    expect(resolveState(facts({ untrusted: true }))).toEqual({
      state: "untrusted",
      label: "untrusted",
      reason: "the vault folder is not trusted, so the tab keeps it from running (see the trust setting above)",
    });
  });

  it("failed: the reason is the log's message", () => {
    expect(resolveState(facts({ log: FAILED }))).toEqual({ state: "failed", label: "failed", reason: "Cannot find module 'x'" });
  });

  it("failed with no message in the log: \"no reason in the log\"", () => {
    for (const reason of [null, "", "   \n\t "]) {
      expect(resolveState(facts({ log: { found: true, failed: { reason }, activated: false } })).reason).toBe("no reason in the log");
    }
  });

  it("failed: a long or multi-line message is plain, one line and capped with an ellipsis", () => {
    const r = resolveState(facts({ log: { found: true, failed: { reason: `${"boom ".repeat(100)}\n<b>bold</b>\u202e` }, activated: false } })).reason;
    expect(r.endsWith("…")).toBe(true);
    expect(Array.from(r).length).toBe(200);
    expect(r).not.toMatch(/[\n\u202e]/);
  });

  it("active", () => {
    expect(resolveState(facts({ log: ACTIVE }))).toEqual({ state: "active", label: "active", reason: "activated by the extension host" });
  });

  it("inactive with a log: not activated yet", () => {
    expect(resolveState(facts({}))).toEqual({
      state: "inactive",
      label: "inactive",
      reason: "not activated yet; most extensions start when a file they handle is opened in the tab",
    });
  });

  it("inactive with no log: the note \"no extension host log found\"", () => {
    expect(resolveState(facts({ log: NO_LOG }))).toEqual({ state: "inactive", label: "inactive", reason: "no extension host log found" });
  });

  it("labels and tones", () => {
    expect(STATE_LABEL).toEqual({ disabled: "disabled in VS Code", untrusted: "untrusted", failed: "failed", active: "active", inactive: "inactive" });
    expect(STATE_TONE).toEqual({ disabled: "info", untrusted: "warning", failed: "error", active: "ok", inactive: "info" });
  });
});

describe("cleanText", () => {
  it("turns control characters and line breaks into single spaces and trims", () => {
    expect(cleanText("  a\u0000b\r\nc\td \u001b[31m ")).toBe("a b c d [31m");
  });

  it("removes bidirectional overrides", () => {
    expect(cleanText("abc\u202edef\u2066g")).toBe("abc def g");
  });

  it("caps at the limit with an ellipsis, counting characters not code units, and is idempotent", () => {
    const once = cleanText("😀".repeat(50), 10);
    expect(once).toBe(`${"😀".repeat(9)}…`);
    expect(cleanText(once as string, 10)).toBe(once);
    expect(cleanText("exactly10!", 10)).toBe("exactly10!");
  });

  it("is null when nothing readable is left", () => {
    expect(cleanText("")).toBeNull();
    expect(cleanText(" \n\u0007 ")).toBeNull();
  });

  it("leaves markup as it is: it is only ever set as text", () => {
    expect(cleanText("<img src=x onerror=alert(1)>")).toBe("<img src=x onerror=alert(1)>");
  });
});
