import { describe, expect, it } from "vitest";
import { REVEALING_COMMANDS, overlayKeybindings, unbindCommands } from "../../src/chrome-settings";
import { OVERLAY_BEGIN, OVERLAY_END } from "../../src/keybinding-overlay";
import { applyOverlay, removeOverlay, rulesOf, type Rule } from "../overlay-runner";

// The keybinding overlay laid over keybindings.json text (GP4, E9). Fixtures are strings; nothing here touches the filesystem.

/** What the overlay must add, written out literally: a change to the chord table must be a change to this list too. */
const CLOSE_CHORDS: Rule[] = [
  { key: "ctrl+alt+shift+7", command: "workbench.action.toggleActivityBarVisibility" },
  { key: "ctrl+alt+shift+6", command: "workbench.action.toggleStatusbarVisibility" },
  { key: "ctrl+alt+shift+2", command: "workbench.action.closeAuxiliaryBar" },
  { key: "ctrl+alt+shift+1", command: "workbench.action.closeSidebar" },
  { key: "ctrl+alt+shift+3", command: "workbench.action.closePanel" },
  { key: "ctrl+alt+shift+4", command: "workbench.action.closeOtherEditors" },
];
const REMOVALS: Rule[] = [
  { key: "cmd+b", command: "-workbench.action.toggleSidebarVisibility" },
  { key: "ctrl+b", command: "-workbench.action.toggleSidebarVisibility" },
  { key: "cmd+j", command: "-workbench.action.togglePanel" },
  { key: "ctrl+j", command: "-workbench.action.togglePanel" },
  { key: "cmd+k z", command: "-workbench.action.toggleZenMode" },
  { key: "ctrl+k z", command: "-workbench.action.toggleZenMode" },
  { key: "cmd+w", command: "-workbench.action.closeActiveEditor" },
  { key: "ctrl+w", command: "-workbench.action.closeActiveEditor" },
  { key: "ctrl+f4", command: "-workbench.action.closeActiveEditor" },
  { key: "cmd+alt+b", command: "-workbench.action.toggleAuxiliaryBar" },
  { key: "ctrl+alt+b", command: "-workbench.action.toggleAuxiliaryBar" },
];
const OURS: Rule[] = [...CLOSE_CHORDS, ...REMOVALS];

const MINE: Rule = { key: "ctrl+alt+m", command: "editor.action.formatDocument" };
const SLASH: Rule = { key: "ctrl+/", command: "editor.action.commentLine", when: "editorTextFocus // not a comment" };

/** The command the LAST rule for `key` gives (VS Code lets the last rule win); "" is an unbound chord, undefined no rule. */
const effective = (rules: Rule[], key: string) => rules.filter((r) => r && r.key === key).at(-1)?.command;

/** The files E9 names, as strings: each is a keybindings.json the user could have. */
const PARSEABLE: Array<[string, string | null]> = [
  ["missing", null],
  ["empty", ""],
  ["blank", "  \n\t\n"],
  ["an empty array", "[]"],
  ["an empty array with comments", "// nothing yet\n[\n  // still nothing\n]\n"],
  ["rules", JSON.stringify([MINE, SLASH], null, 2)],
  ["rules with a trailing comma and comments", `// mine\n[\n  ${JSON.stringify(MINE)}, // format\n  /* block */ ${JSON.stringify(SLASH)},\n]\n`],
  ["rules with a comment after the last rule", `[\n  ${JSON.stringify(MINE)}\n  // that was the last\n]`],
  ["a byte-order mark", "\ufeff" + JSON.stringify([MINE])],
  ["a byte-order mark and an empty array", "\ufeff[]"],
  ["Windows line ends", `[\r\n  ${JSON.stringify(MINE)}\r\n]\r\n`],
];
const BROKEN: Array<[string, string]> = [
  ["not JSON at all", "not json at all"],
  ["an object", '{ "key": "cmd+b" }'],
  ["an array that is never closed", `[\n  ${JSON.stringify(MINE)},\n  { "key": "cmd+b"`],
  ["a comment that is never closed", "[ /* oops "],
  ["a lone bracket", "["],
  ["a number", "42"],
];
const AFTER_ARRAY = `[${JSON.stringify(MINE)}]\nleft over`;
const ALL = [...PARSEABLE, ...BROKEN.map(([n, t]): [string, string | null] => [n, t]), ["text after the array", AFTER_ARRAY] as [string, string | null]];

describe("what the overlay adds (GP4)", () => {
  it("adds the close chords and then the removals of the layout chords, as plugin entries", () => {
    expect(overlayKeybindings()).toEqual(OURS);
  });

  it("writes them into a missing file, an empty one and `[]`", () => {
    for (const text of [null, "", "[]"]) expect(rulesOf(applyOverlay(text)), String(text)).toEqual(OURS);
  });

  it("disables Cmd/Ctrl+B, Cmd/Ctrl+J, Cmd+K Z and Cmd+W by `-command` entries in both spellings, and not the chords the bridge or the overlays use", () => {
    const keys = new Set(rulesOf(applyOverlay(null)).map((r) => r.key));
    for (const k of ["cmd+b", "ctrl+b", "cmd+j", "ctrl+j", "cmd+k z", "ctrl+k z", "cmd+w", "ctrl+w"]) expect(keys.has(k), k).toBe(true);
    // Ctrl+` (the terminal drawer), Cmd/Ctrl+P and Cmd/Ctrl+Shift+P (overlays), Cmd/Ctrl+F (find), Cmd+S and Cmd+Z are not touched.
    for (const k of ["ctrl+`", "cmd+p", "ctrl+p", "cmd+shift+p", "ctrl+shift+p", "cmd+f", "ctrl+f", "cmd+s", "ctrl+s", "cmd+z", "ctrl+z", "escape escape"]) expect(keys.has(k), k).toBe(false);
  });
});

describe("the user's text and the overlay (E9)", () => {
  it.each(ALL)("%s: cutting the overlay out gives the user's bytes back, and applying twice changes nothing", (_name, text) => {
    const once = applyOverlay(text);
    expect(removeOverlay(once)).toBe(text ?? "");
    expect(applyOverlay(once)).toBe(once);
    expect(once.includes(OVERLAY_BEGIN.slice(0, 50))).toBe(true);
    expect(once.includes(OVERLAY_END)).toBe(true);
  });

  it.each(PARSEABLE)("%s: the result still reads as a keybindings array: the user's rules, then ours", (_name, text) => {
    const mine = text === null || text.trim() === "" ? [] : rulesOf(text);
    expect(rulesOf(applyOverlay(text))).toEqual([...mine, ...OURS]);
  });

  it.each(BROKEN)("%s: every byte is kept and the overlay is a readable array in front of it", (_name, text) => {
    const out = applyOverlay(text);
    expect(out.endsWith(OVERLAY_END + "\n" + text)).toBe(true);
    const block = out.slice(0, out.length - text.length);
    expect(rulesOf(block)).toEqual(OURS);
  });

  it("puts the overlay inside the array when text follows it, and keeps that text", () => {
    const out = applyOverlay(AFTER_ARRAY);
    expect(out.endsWith("]\nleft over")).toBe(true);
    expect(rulesOf(out.slice(0, out.length - "\nleft over".length))).toEqual([MINE, ...OURS]);
  });

  it("keeps a byte-order mark at the very start", () => {
    const out = applyOverlay("\ufeff" + JSON.stringify([MINE]));
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out.indexOf("\ufeff", 1)).toBe(-1);
    const broken = applyOverlay("\ufeffnot json");
    expect(broken.charCodeAt(0)).toBe(0xfeff);
    expect(broken.endsWith("not json")).toBe(true);
  });

  it("puts a comma after the user's last rule only when it needs one, and takes it out again with the block", () => {
    const noComma = `[${JSON.stringify(MINE)}]`;
    const withComma = `[${JSON.stringify(MINE)},]`;
    expect(rulesOf(applyOverlay(noComma))).toEqual([MINE, ...OURS]);
    expect(rulesOf(applyOverlay(withComma))).toEqual([MINE, ...OURS]);
    expect(removeOverlay(applyOverlay(noComma))).toBe(noComma);
    expect(removeOverlay(applyOverlay(withComma))).toBe(withComma);
  });

  it("replaces an earlier overlay instead of stacking: edits made in the tab are kept, our block is rewritten once", () => {
    const first = applyOverlay(`[${JSON.stringify(MINE)}]`);
    // the user adds a rule inside the tab (VS Code writes it before the closing bracket, after our block)
    const edited = first.replace(/\n\]\n?$/, `\n,  ${JSON.stringify(SLASH)}\n]\n`);
    const again = applyOverlay(edited);
    expect(rulesOf(again)).toEqual([MINE, SLASH, ...OURS]);
    expect(again.match(/\/\/ >>> /g)).toHaveLength(1);
    expect(again.match(/\/\/ <<< /g)).toHaveLength(1);
    expect(applyOverlay(again)).toBe(again);
  });

  // VS Code's keybinding editor (jsonc-parser setProperty(text, [-1], rule)) writes a new rule, and the entry a 'Remove keybinding'
  // adds, straight after the array's LAST element. In our file that is our last entry, so the rule lands before the end comment.
  const insertLikeVsCode = (text: string, rule: Rule) => {
    const end = text.indexOf(`\n${OVERLAY_END}`);
    expect(end).toBeGreaterThan(0);
    // jsonc-parser puts it right after the last element ('}'), wherever the array's closing bracket is: before the end line when
    // the array is the file's own, or, when our block holds the root array itself, before that array's ']'.
    const last = text.lastIndexOf("}", end);
    return text.slice(0, last + 1) + `,\n${JSON.stringify(rule, null, 4)}` + text.slice(last + 1);
  };
  const ADDED: Rule = { key: "ctrl+alt+m", command: "editor.action.formatDocument", when: "editorTextFocus" };
  const REMOVED_DEFAULT: Rule = { key: "cmd+shift+o", command: "-workbench.action.gotoSymbol" };
  const INSIDE: Array<[string, string]> = [
    ["a missing file", null as unknown as string],
    ["an empty file", ""],
    ["a blank file", "  \n\t\n"],
    ["a file of comments only", "// nothing yet\n"],
    ["a byte-order mark and nothing else", "\ufeff"],
    ["rules", JSON.stringify([MINE])],
    ["an empty array", "[]"],
    ["comments and a trailing comma", `// mine\n[\n  ${JSON.stringify(MINE)}, // format\n]\n`],
  ];

  it.each(INSIDE)("%s: a rule added in the tab right after our last entry (before the end comment) survives the next load", (_name, text) => {
    const first = applyOverlay(text);
    const edited = insertLikeVsCode(first, ADDED);
    expect(() => rulesOf(edited)).not.toThrow();
    const again = applyOverlay(edited);
    const mine = text === null || text.trim() === "" || !text.includes("[") ? [] : rulesOf(text);
    expect(rulesOf(again)).toEqual([...mine, ADDED, ...OURS]);
    expect(again.match(/\/\/ >>> /g)).toHaveLength(1);
    expect(again.match(/\/\/ <<< /g)).toHaveLength(1);
    expect(applyOverlay(again)).toBe(again);
    // with the block cut out the rule is still there
    expect(rulesOf(removeOverlay(again))).toEqual([...mine, ADDED]);
  });

  it("keeps a 'Remove keybinding' entry for a default rule that was added before the end comment, and several added rules in order", () => {
    const first = applyOverlay(JSON.stringify([MINE]));
    const edited = insertLikeVsCode(insertLikeVsCode(first, REMOVED_DEFAULT), ADDED);
    const again = applyOverlay(edited);
    expect(rulesOf(again)).toEqual([MINE, REMOVED_DEFAULT, ADDED, ...OURS]);
    expect(applyOverlay(again)).toBe(again);
  });

  it("keeps an added rule that has nested arguments, and one that is also written after the end line", () => {
    const withArgs: Rule & { args: unknown } = { key: "ctrl+alt+a", command: "type", args: { text: "}{ \"x\" // not a comment" } } as never;
    const first = applyOverlay(JSON.stringify([MINE]));
    const edited = insertLikeVsCode(first, withArgs as Rule).replace(/\n\]\n?$/, `\n,  ${JSON.stringify(SLASH)}\n]\n`);
    expect(rulesOf(applyOverlay(edited))).toEqual([MINE, withArgs, SLASH, ...OURS]);
  });

  it("a missing or empty file: a 'Remove keybinding' entry, a rule with arguments and several rules added in the tab all survive, in order, over several loads", () => {
    const withArgs = { key: "ctrl+alt+a", command: "type", args: { text: "}{ \"x\" // not a comment" } } as Rule;
    for (const text of [null, "", "// nothing yet\n"]) {
      const first = applyOverlay(text);
      const edited = insertLikeVsCode(insertLikeVsCode(insertLikeVsCode(first, REMOVED_DEFAULT), withArgs), ADDED);
      let now = applyOverlay(edited);
      expect(rulesOf(now), String(text)).toEqual([REMOVED_DEFAULT, withArgs, ADDED, ...OURS]);
      for (let load = 0; load < 3; load++) expect(applyOverlay(now), `${text} load ${load}`).toBe(now);
      // and one more added after the second load
      now = applyOverlay(insertLikeVsCode(now, SLASH));
      expect(rulesOf(now), String(text)).toEqual([REMOVED_DEFAULT, withArgs, ADDED, SLASH, ...OURS]);
      expect(now.match(/\/\/ >>> /g)).toHaveLength(1);
    }
  });

  it("an added rule that binds a revealing command gets its own unbinding rule after it", () => {
    const reveal: Rule = { key: "ctrl+alt+n", command: "workbench.action.toggleSidebarVisibility" };
    const rules = rulesOf(applyOverlay(insertLikeVsCode(applyOverlay(JSON.stringify([MINE])), reveal)));
    expect(rules).toEqual([MINE, reveal, ...OURS, { key: "ctrl+alt+n", command: "" }]);
    expect(effective(rules, "ctrl+alt+n")).toBe("");
  });

  it("does not keep what the overlay wrote itself, whatever the order of the keys or the spacing of an entry", () => {
    const first = applyOverlay(JSON.stringify([MINE]));
    const reformatted = first.replace(`  ${JSON.stringify(CLOSE_CHORDS[0])}`, JSON.stringify({ command: CLOSE_CHORDS[0].command, key: CLOSE_CHORDS[0].key }, null, 4));
    expect(rulesOf(applyOverlay(reformatted))).toEqual([MINE, ...OURS]);
  });

  it("is the same bytes each time, whatever the file was before", () => {
    for (const [, text] of ALL) {
      const a = applyOverlay(text);
      const b = applyOverlay(applyOverlay(a));
      expect(b).toBe(a);
    }
  });
});

describe("a copied rule that brings a bar back is unbound (E9)", () => {
  const layout: Rule = { key: "ctrl+alt+n", command: "workbench.action.toggleSidebarVisibility" };

  it("unbinds ctrl+alt+n -> toggleSidebarVisibility (the check fixture) with an empty-command rule after it", () => {
    const rules = rulesOf(applyOverlay(JSON.stringify([layout])));
    expect(rules).toEqual([layout, ...OURS, { key: "ctrl+alt+n", command: "" }]);
    expect(effective(rules, "ctrl+alt+n")).toBe("");
  });

  it("unbinds cmd+b, cmd+j, cmd+k z and cmd+w re-bound to their original commands", () => {
    const copied: Rule[] = [
      { key: "cmd+b", command: "workbench.action.toggleSidebarVisibility" },
      { key: "cmd+j", command: "workbench.action.togglePanel" },
      { key: "cmd+k z", command: "workbench.action.toggleZenMode" },
      { key: "cmd+w", command: "workbench.action.closeActiveEditor" },
      { key: "ctrl+b", command: "workbench.action.toggleSidebarVisibility" },
    ];
    const rules = rulesOf(applyOverlay(JSON.stringify(copied)));
    for (const r of copied) expect(effective(rules, r.key), r.key).toBe("");
  });

  it("does so in a file with comments, trailing commas and a byte-order mark", () => {
    const text = `\ufeff// mine\n[\n  { "key": "ctrl+alt+n", "command": "workbench.action.toggleSidebarVisibility" }, // sidebar\n  { "key": "cmd+b", "command": "workbench.action.toggleSidebarVisibility", },\n]\n`;
    const rules = rulesOf(applyOverlay(text));
    expect(effective(rules, "ctrl+alt+n")).toBe("");
    expect(effective(rules, "cmd+b")).toBe("");
  });

  it("unbinds every command of the revealing list, whichever chord it is bound to", () => {
    expect(REVEALING_COMMANDS.length).toBeGreaterThan(0);
    const copied = REVEALING_COMMANDS.map((command, i) => ({ key: `ctrl+alt+f${(i % 12) + 1}`, command, when: `x${i}` }));
    const rules = rulesOf(applyOverlay(JSON.stringify(copied)));
    for (const r of copied) {
      const last = rules.filter((x) => x.key === r.key && x.when === r.when).at(-1);
      expect(last, r.command).toEqual({ key: r.key, command: "", when: r.when });
    }
  });

  it("unbinds the chord with the rule's own `when`, so another rule for the chord under a different `when` is left alone", () => {
    const copied: Rule[] = [
      { key: "ctrl+alt+n", command: "workbench.action.toggleSidebarVisibility", when: "editorTextFocus" },
      { key: "ctrl+alt+n", command: "editor.action.formatDocument", when: "!editorTextFocus" },
    ];
    const rules = rulesOf(applyOverlay(JSON.stringify(copied)));
    expect(rules).toContainEqual({ key: "ctrl+alt+n", command: "", when: "editorTextFocus" });
    expect(rules.filter((r) => r.key === "ctrl+alt+n" && r.command === "")).toHaveLength(1);
  });

  it("leaves a copied rule that brings nothing back alone, `-command` entries of the user included", () => {
    const copied: Rule[] = [MINE, SLASH, { key: "cmd+b", command: "-workbench.action.toggleSidebarVisibility" }, { key: "ctrl+k", command: "-x" }];
    const rules = rulesOf(applyOverlay(JSON.stringify(copied)));
    expect(rules).toEqual([...copied, ...OURS]);
    expect(effective(rules, "ctrl+alt+m")).toBe("editor.action.formatDocument");
    expect(effective(rules, "ctrl+/")).toBe("editor.action.commentLine");
  });

  it("ignores array members that are not rules", () => {
    const text = `[null, 7, "x", [], {}, { "key": 1, "command": "workbench.action.togglePanel" }, { "key": "ctrl+alt+n" }, ${JSON.stringify({ key: "ctrl+alt+n", command: "workbench.action.togglePanel" })}]`;
    const rules = rulesOf(applyOverlay(text));
    expect(effective(rules, "ctrl+alt+n")).toBe("");
    expect(rules.slice(-OURS.length - 1, -1)).toEqual(OURS);
  });

  it("reads the rules of a file whose array never closes one by one, keeps every byte, and unbinds in the block in front", () => {
    const text = `[\n  ${JSON.stringify(layout)},\n  { "key": "cmd+b"`;
    const out = applyOverlay(text);
    expect(out.endsWith(text)).toBe(true);
    expect(rulesOf(out.slice(0, out.length - text.length))).toEqual([...OURS, { key: "ctrl+alt+n", command: "" }]);
  });

  it("uses the lists it is given, so a list that is emptied unbinds nothing", () => {
    const rules = rulesOf(applyOverlay(JSON.stringify([layout]), overlayKeybindings(), []));
    expect(effective(rules, "ctrl+alt+n")).toBe("workbench.action.toggleSidebarVisibility");
  });

  it("the unbind list is the revealing commands plus the commands of the disabled chords, once each", () => {
    const list = unbindCommands();
    expect(new Set(list).size).toBe(list.length);
    for (const c of [...REVEALING_COMMANDS, "workbench.action.closeActiveEditor"]) expect(list).toContain(c);
  });
});
