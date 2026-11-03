/**
 * The stylesheet's rules that make room for the open drawer (PR-3 T1, T9). The real layout is measured in Chrome by
 * tests/render/bottom-edge-check.mjs (not part of `npm test`); these pin the rules it relies on, with the rule text written out
 * literally.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const css = fs.readFileSync(path.resolve(__dirname, "../../src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declaration block of the rule with exactly this selector. */
function block(selector: string): string | null {
  const m = css.match(new RegExp(`(?:^|})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*{([^}]*)}`));
  return m ? m[1] : null;
}

describe("room for the open drawer", () => {
  const MAIN = "body.vscw-drawer-open:not(.is-popout-window) .workspace-split.mod-root";

  it("the note area is shortened by the drawer's height, in height and margin, only while the drawer is open", () => {
    const rule = block(MAIN);
    expect(rule).not.toBeNull();
    expect(rule).toContain("height: calc(100% - var(--vscw-open-height, 0px));");
    expect(rule).toContain("margin-bottom: var(--vscw-open-height, 0px);");
  });

  it("no rule on the main pane area or the status bar applies to a pop-out window's body (Obsidian copies the drawer classes there)", () => {
    expect(block("body.vscw-drawer-on:not(.is-popout-window) .status-bar")).toContain("bottom: var(--vscw-status-lift, 0px);");
    const selectors = [...css.matchAll(/([^{}]+){/g)].map((m) => m[1].trim());
    const touching = selectors.filter((s) => s.startsWith("body.vscw-drawer") && /\.(workspace-split\.mod-root|status-bar)\b/.test(s));
    expect(touching).toEqual([MAIN, "body.vscw-drawer-on:not(.is-popout-window) .status-bar"]);
  });
});
