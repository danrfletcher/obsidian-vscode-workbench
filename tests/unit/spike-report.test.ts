import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { chromeStopMessage, parseDecision } from "../decision";
import { REPO_ROOT } from "../helpers";

/**
 * The chrome spike's findings report (docs/spike-chrome.md) is read as it is on disk, no mock. The test fails when a
 * question (S1 to S5) or a measured VS Code version is missing, or when a row of a table has no result word, so a
 * half-written report cannot pass. The probe that produces the numbers is `npm run check:chrome-spike`.
 */
const REPORT = path.join(REPO_ROOT, "docs/spike-chrome.md");
const VERSIONS = ["1.143.1", "1.144.0"] as const;
const PARTS = ["side bar", "secondary side bar", "activity bar", "status bar", "title bar", "panel", "tab strip", "breadcrumb"] as const;
/** A result cell starts with one of these words. */
const RESULT_WORD = /^(HIDDEN|VISIBLE|YES|NO|PARTIAL|INTERCEPT|FALLBACK|SEEN|NOT SEEN|UNDONE|NOT UNDONE|CHOSEN|TRUE|FALSE)\b/;

type Row = { cells: string[]; line: string };

/** The `## S<n>` sections of the report, each with the data rows of its tables (header and separator rows dropped). */
function sections(text: string): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  let current: Row[] | null = null;
  for (const line of text.split("\n")) {
    const h = /^## (S[1-5])\b/.exec(line);
    if (h) {
      current = [];
      out.set(h[1], current);
      continue;
    }
    if (/^## /.test(line)) {
      current = null;
      continue;
    }
    if (current && line.startsWith("|")) {
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // the separator row
      current.push({ cells, line });
    }
  }
  // the first row of each table is its header row
  for (const [key, rows] of out) out.set(key, rows.filter((r) => !/^(Part|Question)$/.test(r.cells[0])));
  return out;
}

describe("docs/spike-chrome.md", () => {
  const text = fs.readFileSync(REPORT, "utf8");
  const table = sections(text);

  it("exists and names the probe that produced it", () => {
    expect(text).toContain("npm run check:chrome-spike");
  });

  it.each(["S1", "S2", "S3", "S4", "S5"])("has a section for %s with at least one result row", (q) => {
    expect(table.has(q), `no "## ${q}" section`).toBe(true);
    expect(table.get(q)!.length, `${q} has no rows`).toBeGreaterThan(0);
  });

  it.each(VERSIONS)("records VS Code %s", (version) => {
    expect(text).toContain(version);
    // Not a mention anywhere in the section: a table must claim the build in its own header (a column, or "Result on A and B"),
    // so a table whose result was measured on one build cannot pass by naming the other in a sentence below it.
    // S1 and S4 put each build in its own column of their first table; their other tables (the three-state S1 tables) are
    // introduced in prose and the Code tab table is one build by design. S2, S3 and S5 have one result column for both builds.
    for (const q of ["S1", "S2", "S3", "S4", "S5"]) {
      const headers = headerRows(text, q);
      expect(headers.length, `${q} has no table`).toBeGreaterThan(0);
      for (const h of q === "S1" || q === "S4" ? headers.slice(0, 1) : headers) expect(h.some((c) => c.includes(version)), `${q}: the table headed "${h.join(" | ")}" does not claim ${version}`).toBe(true);
    }
  });

  it("does not let a result row name one build only (a row measured on one build is not a result for both)", () => {
    // In a table whose header says "Result on 1.143.1 and 1.144.0" the result is for both builds. A data row of such a table that
    // names exactly one of the two versions in its text says it was measured on that build alone, and must say so on the other too.
    for (const q of ["S2", "S3", "S5"]) {
      for (const r of table.get(q)!) {
        const named = VERSIONS.filter((v) => r.line.includes(v));
        expect(named.length === 0 || named.length === VERSIONS.length, `${q}: "${r.cells[0]}" names only ${named.join(", ")}`).toBe(true);
      }
    }
  });

  it("gives every row of every table a result word in its last cell", () => {
    for (const [q, rows] of table) {
      for (const r of rows) expect(r.cells[r.cells.length - 1], `${q}: "${r.cells[0]}" has no result word`).toMatch(RESULT_WORD);
    }
  });

  it("has one S1 row per part, each with a result for both builds", () => {
    const rows = table.get("S1")!;
    for (const part of PARTS) {
      const row = rows.find((r) => r.cells[0].toLowerCase() === part);
      expect(row, `no S1 row for the ${part}`).toBeDefined();
      // Part | Routes tried, in order | Exact setting or script | 1.143.1 | 1.144.0 | Result
      expect(row!.cells, `${part} row`).toHaveLength(6);
      expect(row!.cells[3], `${part} on ${VERSIONS[0]}`).toMatch(/^(HIDDEN|VISIBLE)\b/);
      expect(row!.cells[4], `${part} on ${VERSIONS[1]}`).toMatch(/^(HIDDEN|VISIBLE)\b/);
      // The routes column names the route and the measured size in px (computed layout), not a screenshot alone
      expect(row!.cells[1], `${part} routes`).toMatch(/\d+ ?x ?\d+|\d+ ?px/);
    }
  });

  it("records every S1 route fresh, after a reload and on a saved-layout profile, for every part, in the host and the Code tab tables", () => {
    // Review item T1 / checklist C20. A three-state cell reads "R2 166x628 / 166x628 / 166x628 (0px, focusable)": the route name, then
    // the size on a fresh profile, after a reload, and on a profile that already holds saved layout state.
    const SIZE = String.raw`\d+x\d+(?: \(0px, focusable\))?`;
    const ROUTES = ["R0", "R1", "R2", "R3", "R4", "R2+R3+R4", "R5", "R5b", "R6a", "R6b", "best"];
    const rows = table.get("S1")!.filter((r) => r.cells.length === 3 && /\/ /.test(r.cells[1]));
    for (const part of PARTS) {
      const forPart = rows.filter((r) => r.cells[0].toLowerCase() === part);
      expect(forPart, `${part}: one three-state row for the host and one for the Code tab`).toHaveLength(2);
      for (const r of forPart) {
        const cells = r.cells[1].split("; ");
        for (const route of ROUTES) {
          const cell = cells.find((c) => c.startsWith(`${route} `));
          expect(cell, `${part}: no three-state cell for ${route}`).toBeDefined();
          expect(cell!.slice(route.length + 1), `${part} ${route}`).toMatch(new RegExp(`^${SIZE} / ${SIZE} / ${SIZE}$`));
        }
      }
    }
  });

  it("applies the stop rule to the S1 side bar row: a STOP only when neither build can hide it", () => {
    const row = table.get("S1")!.find((r) => r.cells[0].toLowerCase() === "side bar")!;
    const hideable = { "1.143.1": row.cells[3].startsWith("HIDDEN"), "1.144.0": row.cells[4].startsWith("HIDDEN") };
    const stop = chromeStopMessage(hideable);
    if (stop) expect(text, "the report must carry the STOP message").toContain("STOP: ask Dan");
    else expect(text).not.toContain("STOP: ask Dan. The side bar cannot be hidden");
  });

  it("keeps the `chrome` header of spike-decision.md in step with the measured side bar", () => {
    const row = table.get("S1")!.find((r) => r.cells[0].toLowerCase() === "side bar")!;
    const anyHidden = row.cells[3].startsWith("HIDDEN") || row.cells[4].startsWith("HIDDEN");
    const decision = parseDecision(fs.readFileSync(path.join(REPO_ROOT, "docs/spike-decision.md"), "utf8"));
    expect(decision.chrome).toBe(anyHidden ? "hidden" : "visible");
  });

  it("ends S2 with a plain verdict and names the S3, S4 and S5 choices", () => {
    expect(text).toMatch(/S2 verdict: (INTERCEPT|FALLBACK)\b/);
    expect(text).toMatch(/S3 re-apply route: \S/);
    expect(text).toMatch(/S4 cheapest fix: \S/);
    expect(text).toMatch(/S5 chosen signal for PR-5: \S/);
  });

  it("cites a screenshot per question per build, each named PR-1-S<n>-<build>.png", () => {
    for (const q of ["S1", "S2", "S3", "S4", "S5"]) {
      for (const build of VERSIONS) expect(text, `${q} ${build}`).toContain(`PR-1-${q}-${build}.png`);
    }
  });

  it("records a look at every picture it cites (checklist C31): each file named on a \"Looked at:\" line, in its own question's section", () => {
    // Spec, Container verification: "Each is looked at and the report cites the file." A picture counts as looked at when a
    // "Looked at:" paragraph names the file and says what is on screen; the report must not say nobody looked.
    const pictures: Record<string, string[]> = {
      S1: [...VERSIONS.map((v) => `PR-1-S1-${v}.png`), "PR-1-S1-container-r0.png", "PR-1-S1-container-best.png"],
      S2: VERSIONS.map((v) => `PR-1-S2-${v}.png`),
      S3: VERSIONS.map((v) => `PR-1-S3-${v}.png`),
      S4: VERSIONS.flatMap((v) => [`PR-1-S4-${v}.png`, `PR-1-S4-${v}-settled.png`]),
      S5: VERSIONS.flatMap((v) => [`PR-1-S5-${v}.png`, `PR-1-S5-${v}-saved.png`]),
    };
    for (const [q, files] of Object.entries(pictures)) {
      const looked = sectionText(text, q).split("\n").filter((l) => /^(- )?Looked at: /.test(l));
      expect(looked.length, `${q} has no "Looked at:" paragraph`).toBeGreaterThan(0);
      for (const file of files) {
        const line = looked.find((l) => l.includes(`\`${file}\``));
        expect(line, `${q}: no "Looked at:" paragraph names ${file}`).toBeDefined();
        expect(line!.length, `${q}: the paragraph for ${file} says nothing about what is on screen`).toBeGreaterThan(200);
      }
    }
    expect(text).not.toMatch(/Nobody has (yet )?looked/i);
    expect(text).not.toMatch(/cannot view images/i);
  });
});

/** The header row (cells) of every table in one `## S<n>` section: the row just before a separator row. */
function headerRows(text: string, q: string): string[][] {
  const lines = sectionText(text, q).split("\n");
  const out: string[][] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split("|").slice(1, -1).map((c) => c.trim());
    if (lines[i].startsWith("|") && cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c)) && lines[i - 1].startsWith("|")) {
      out.push(lines[i - 1].split("|").slice(1, -1).map((c) => c.trim()));
    }
  }
  return out;
}

/** The text of one `## S<n>` section. */
function sectionText(text: string, q: string): string {
  const start = text.indexOf(`## ${q}`);
  if (start < 0) return "";
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}
