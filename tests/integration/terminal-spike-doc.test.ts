/**
 * Keeps docs/terminal-spike.md well-formed (ticket warkworth-37, PR-1): every answer the later PRs read is a front
 * matter key with one of its allowed values, every question S1-S7 has a section, a failed panel-only layout comes
 * with a stop report (and only then), and the borrow-the-source assessment states no verdict.
 *
 * What the numbers are is not checked here: they come from `npm run check:terminal-spike`, which writes
 * terminal-spike-result.json; this test only stops the doc drifting into a shape the next PRs cannot read.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../helpers";

const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  panel_only: ["works", "fails"],
  reattach: ["yes", "no", "partial"],
  sweep: ["finds_shells", "misses_shells", "partial"],
  cwd_open: ["outside_page", "extension", "not_possible"],
  live_shells: ["reliable", "unreliable"],
  focus_bridge: ["yes", "no"],
  shared_terminals: ["shared", "separate"],
};

interface ParsedDoc {
  front: Record<string, string>;
  /** Section headings (`## ...`) to their text, up to the next `## ` heading. */
  sections: Map<string, string>;
}

/** Front matter (`---` fenced `key: value` lines) and the `## ` sections of a markdown document. */
function parseDoc(text: string): ParsedDoc {
  const front: Record<string, string> = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  const body = m ? text.slice(m[0].length) : text;
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_][\w-]*):\s*(.*?)\s*$/.exec(line);
      if (kv) front[kv[1]] = kv[2];
    }
  }
  const sections = new Map<string, string>();
  const parts = body.split(/^## /m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    sections.set(part.slice(0, nl < 0 ? undefined : nl).trim(), nl < 0 ? "" : part.slice(nl + 1));
  }
  return { front, sections };
}

/** The section for question `n` (`## S1 ...`), or undefined. */
function sectionFor(doc: ParsedDoc, n: number): string | undefined {
  for (const [title, body] of doc.sections) if (new RegExp(`^S${n}\\b`).test(title)) return body;
  return undefined;
}

/** What is wrong with a spike document; empty when it is well-formed. */
function problems(text: string): string[] {
  const out: string[] = [];
  const doc = parseDoc(text);
  for (const [key, allowed] of Object.entries(ALLOWED)) {
    const v = doc.front[key];
    if (v === undefined) out.push(`front matter key ${key} is missing`);
    else if (!allowed.includes(v)) out.push(`front matter key ${key} is "${v}", expected one of ${allowed.join(" | ")}`);
  }
  for (let n = 1; n <= 7; n++) if (sectionFor(doc, n) === undefined) out.push(`there is no section for S${n}`);
  const hasStop = [...doc.sections.keys()].some((t) => /^Stop report\b/i.test(t));
  if (doc.front.panel_only === "fails" && !hasStop) out.push('panel_only is "fails" but there is no "Stop report" section');
  if (doc.front.panel_only !== "fails" && hasStop) out.push(`panel_only is "${doc.front.panel_only}" but the doc has a "Stop report" section`);
  const s5 = sectionFor(doc, 5);
  if (s5 !== undefined) {
    for (const [what, re] of [["licence", /licen[cs]e/i], ["service layer", /service layer/i], ["node-pty", /node-pty/i], ["size", /\bsize\b/i], ["memory", /\bmemory\b/i]] as const) {
      if (!re.test(s5)) out.push(`the S5 section does not mention ${what}`);
    }
    for (const verdict of ["preferred", "rejected"]) if (new RegExp(`\\b${verdict}\\b`, "i").test(s5)) out.push(`the S5 section states "${verdict}"`);
  }
  return out;
}

const GOOD = `---
panel_only: works
reattach: partial
sweep: finds_shells
cwd_open: extension
live_shells: reliable
focus_bridge: yes
shared_terminals: shared
---
# Terminal spike

## S1 Panel-only
text
## S2 Folder
text
## S3 Reattach
text
## S4 Live shells
text
## S5 Borrow the source
Licence, the workbench service layer, node-pty, size and memory are each discussed. Dan decides.
## S6 Sweep
text
## S7 Focus
text
`;

const swap = (text: string, from: string, to: string) => {
  expect(text).toContain(from);
  return text.replace(from, to);
};

describe("docs/terminal-spike.md", () => {
  const real = fs.readFileSync(path.join(REPO_ROOT, "docs", "terminal-spike.md"), "utf8");

  it("is well-formed: every key has an allowed value, S1 to S7 each have a section, the S5 assessment states no verdict", () => {
    expect(problems(real)).toEqual([]);
  });

  it("has a stop report exactly when the panel-only layout failed", () => {
    const doc = parseDoc(real);
    const hasStop = [...doc.sections.keys()].some((t) => /^Stop report\b/i.test(t));
    expect(hasStop).toBe(doc.front.panel_only === "fails");
  });

  it("names every answer with the evidence that produced it: the doc cites the probe script", () => {
    expect(real).toContain("npm run check:terminal-spike");
  });

  describe("the checker", () => {
    it("accepts a good document", () => {
      expect(problems(GOOD)).toEqual([]);
    });

    it.each(Object.keys(ALLOWED))("rejects a document without %s", (key) => {
      const bad = GOOD.replace(new RegExp(`^${key}: .*\\n`, "m"), "");
      expect(problems(bad)).toEqual([`front matter key ${key} is missing`]);
    });

    it.each(Object.keys(ALLOWED))("rejects a value for %s that is not one of the allowed ones", (key) => {
      const bad = GOOD.replace(new RegExp(`^${key}: .*$`, "m"), `${key}: maybe`);
      expect(problems(bad)).toHaveLength(1);
      expect(problems(bad)[0]).toContain(`front matter key ${key} is "maybe"`);
    });

    it("rejects a document with no front matter at all", () => {
      expect(problems(GOOD.replace(/^---[\s\S]*?---\n/, "")).filter((p) => p.endsWith("is missing"))).toHaveLength(Object.keys(ALLOWED).length);
    });

    it.each([1, 2, 3, 4, 5, 6, 7])("rejects a document without the S%i section", (n) => {
      const bad = GOOD.replace(new RegExp(`^## S${n} .*$`, "m"), `## Other ${n}`);
      expect(problems(bad)).toContain(`there is no section for S${n}`);
    });

    it("requires a stop report when panel_only is fails", () => {
      const failing = swap(GOOD, "panel_only: works", "panel_only: fails");
      expect(problems(failing)).toEqual(['panel_only is "fails" but there is no "Stop report" section']);
      expect(problems(`${failing}\n## Stop report\nTried A and B. Question for Dan: is an Open as Code tab acceptable?\n`)).toEqual([]);
    });

    it("refuses a stop report when panel_only is works", () => {
      expect(problems(`${GOOD}\n## Stop report\nnot needed\n`)).toEqual(['panel_only is "works" but the doc has a "Stop report" section']);
    });

    it.each(["licence", "service layer", "node-pty", "size", "memory"])("rejects an S5 section that does not mention %s", (word) => {
      const s5 = "Licence, the workbench service layer, node-pty, size and memory are each discussed. Dan decides.";
      const bad = GOOD.replace(s5, s5.replace(new RegExp(word, "i"), "(left out)"));
      expect(problems(bad)).toEqual([`the S5 section does not mention ${word}`]);
    });

    it.each(["preferred", "rejected"])('rejects an S5 section that states "%s"', (verdict) => {
      const bad = GOOD.replace("Dan decides.", `This option is ${verdict}.`);
      expect(problems(bad)).toEqual([`the S5 section states "${verdict}"`]);
    });

    it("accepts the word as part of another word (the ticket text says neither)", () => {
      expect(problems(GOOD.replace("Dan decides.", "Nothing is unrejected here and Dan decides."))).toEqual([]);
    });
  });
});
