/**
 * The keybinding overlay (GP4, E9): what the browser profile's keybindings.json gains at EVERY Code tab load, so that no chord and no
 * copied rule can bring a bar back. It is laid over the copy of the chosen instance's keybindings.json (a new server start) or over
 * the file already in the profile (a reload within one start, after the user may have edited it in the tab), by
 * `buildBrowserSeedScript` in src/settings.ts. The source file in the instance's folder is never touched (F1).
 *
 * The overlay is one block of rules at the END of the file, between two comment lines, so the user's own text stays exactly as it
 * was and the last rule for a chord is ours (the plugin's entries first, the unbinding rules last):
 *  - the plugin's own entries (src/chrome-settings.ts `overlayKeybindings()`): the chords the page script presses, and the
 *    `-command` removals that disable Cmd/Ctrl+B, Cmd/Ctrl+J, Cmd+K Z, Cmd+W and the secondary side bar's chord;
 *  - for every rule of the user's that binds a command which would bring a bar back (`unbindCommands()`: the revealing commands and
 *    the commands of the disabled chords) to ANY chord, a rule for the same chord (and `when`) with an empty command, placed after
 *    it. A `-command` removal cannot do this: VS Code only removes default rules with it, and a user rule beats it
 *    (docs/spike-chrome.md S3), but the last rule for a chord wins, and a rule with an empty command is an unbound chord.
 *
 * The block is found by its comment lines and cut out before the next application, so applying the overlay twice gives the same
 * bytes, and cutting it out gives back the file as it was. A rule inside the block that the overlay did not write (VS Code's
 * keybinding editor adds a rule, or a 'Remove keybinding' entry, right after the array's last element, which is our last entry and so
 * before the end line) is not cut out: it stays, in front of where the block was, and the next block follows it (inside an array of its own when the block held the file's root array, i.e. the file was missing or empty). A file that is missing, empty, `[]`, has comments, trailing commas or a
 * byte-order mark gets the block inside its array; a file that is not a JSON array at all (or has a syntax error elsewhere) keeps
 * every one of its bytes, and the block goes inside the array if there is one, in front of the text otherwise.
 *
 * The logic is one piece of JavaScript source, `KEYBINDING_OVERLAY_JS`: the seed script runs it in the page, and the tests run the
 * very same text (tests/overlay-runner.ts), so what they check is what the page does.
 */
/** The first line of the block. A reader of keybindings.json sees where it comes from; the next load replaces everything up to the end line. */
export const OVERLAY_BEGIN = "// >>> obsidian-vscode-workbench: layout overlay (replaced on every load)";
/** The same line when the block also added the comma that joins it to the user's last rule (cut out together with it). */
export const OVERLAY_BEGIN_AFTER_COMMA = "// >>> obsidian-vscode-workbench: layout overlay (replaced on every load; the comma before it is part of it)";
export const OVERLAY_END = "// <<< obsidian-vscode-workbench: layout overlay";

/** The command of a rule that unbinds its chord. */
export const UNBOUND_COMMAND = "";

/**
 * Page-side source (no TypeScript, no outer dependencies): defines `removeOverlay(text, chords)` and `withOverlay(text, chords, unbind)`.
 * `text` is the file's text or null; `chords` the plugin's entries; `unbind` the commands a user rule must not bind to any chord.
 */
export const KEYBINDING_OVERLAY_JS = String.raw`const OVERLAY_PREFIX = "// >>> obsidian-vscode-workbench: layout overlay";
  const OVERLAY_BEGIN = ${JSON.stringify(OVERLAY_BEGIN)};
  const OVERLAY_BEGIN_AFTER_COMMA = ${JSON.stringify(OVERLAY_BEGIN_AFTER_COMMA)};
  const OVERLAY_END = ${JSON.stringify(OVERLAY_END)};
  const UNBOUND_COMMAND = ${JSON.stringify(UNBOUND_COMMAND)};
  const stripJsonc = (t) => {
    let out = "", i = 0, inString = false;
    while (i < t.length) {
      const c = t[i], n = t[i + 1];
      if (inString) {
        out += c;
        if (c === "\\") { out += n === undefined ? "" : n; i += 2; continue; }
        if (c === '"') inString = false;
        i++;
      } else if (c === '"') { inString = true; out += c; i++; }
      else if (c === "/" && n === "/") { while (i < t.length && t[i] !== "\n") i++; }
      else if (c === "/" && n === "*") { i += 2; while (i < t.length && !(t[i] === "*" && t[i + 1] === "/")) i++; i += 2; }
      else { out += c; i++; }
    }
    return out.replace(/,(\s*[\]}])/g, "$1");
  };
  const canon = (v) => Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : v !== null && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}" : JSON.stringify(v);
  const objectsIn = (body) => {
    const found = [];
    let i = 0, depth = 0, from = -1;
    while (i < body.length) {
      const c = body[i], n = body[i + 1];
      if (c === '"') { i++; while (i < body.length && body[i] !== '"') i += body[i] === "\\" ? 2 : 1; i++; continue; }
      if (c === "/" && n === "/") { while (i < body.length && body[i] !== "\n") i++; continue; }
      if (c === "/" && n === "*") { const e = body.indexOf("*/", i + 2); i = e < 0 ? body.length : e + 2; continue; }
      if (c === "{") { if (depth === 0) from = i; depth++; }
      else if (c === "}" && depth > 0) { depth--; if (depth === 0) found.push(body.slice(from, i + 1)); }
      i++;
    }
    return found;
  };
  const writtenByOverlay = (piece, written) => {
    let rule;
    try { rule = JSON.parse(stripJsonc(piece)); } catch (e) { return false; }
    if (rule === null || typeof rule !== "object" || Array.isArray(rule)) return false;
    if (written.has(canon(rule))) return true;
    const keys = Object.keys(rule);
    return rule.command === UNBOUND_COMMAND && typeof rule.key === "string" && keys.every((k) => k === "key" || k === "command" || (k === "when" && typeof rule.when === "string"));
  };
  const removeOverlay = (text, chords) => {
    const written = new Set((chords || []).map(canon));
    let out = text;
    let from = 0;
    for (;;) {
      const b = out.indexOf(OVERLAY_PREFIX, from);
      if (b < 0) return out;
      const e = out.indexOf(OVERLAY_END, b);
      if (e < 0) return out;
      let end = e + OVERLAY_END.length;
      if (out[end] === "\r" && out[end + 1] === "\n") end += 2;
      else if (out[end] === "\n") end += 1;
      // VS Code's keybinding editor appends a rule right after the array's last element: inside our block, before its end line.
      // Whatever the block holds that the overlay did not write is the user's, and stays, in front of where the block was.
      const kept = objectsIn(out.slice(b, e)).filter((piece) => !writtenByOverlay(piece, written));
      if (kept.length === 0) {
        const start = out.startsWith(OVERLAY_BEGIN_AFTER_COMMA, b) && out[b - 1] === "," ? b - 1 : b;
        out = out.slice(0, start) + out.slice(end);
        from = start;
      } else {
        const lead = b > 0 && out[b - 1] !== "\n" ? "\n" : "";
        // each kept rule ends with a comma, unless the text that follows the block already starts with one (a comma-first rule)
        const comma = /^(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*,/.test(out.slice(end)) ? "" : ",";
        // A block written into a file that had no array holds the root array itself ('[' ... ']' between the two lines): the rules
        // stay inside an array of their own, or what is left of the file would be bare rules that nothing reads.
        const ownArray = /^[^\n]*\n\s*\[/.test(out.slice(b, e));
        const rules = ownArray
          ? "[\n" + kept.map((piece) => "  " + piece).join(",\n") + "\n]\n"
          : kept.map((piece, i) => "  " + piece + (i === kept.length - 1 ? comma : ",") + "\n").join("");
        out = out.slice(0, b) + lead + rules + out.slice(end);
        from = b + lead.length + rules.length;
      }
    }
  };
  const rootArray = (text) => {
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0, depth = 0, open = -1, last = "";
    while (i < text.length) {
      const c = text[i], n = text[i + 1];
      if (c === '"') {
        i++;
        while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
        i++;
        last = '"';
        continue;
      }
      if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
      if (c === "/" && n === "*") { const e = text.indexOf("*/", i + 2); if (e < 0) return null; i = e + 2; continue; }
      if (c === "[" || c === "{") {
        if (depth === 0) { if (c !== "[") return null; open = i; }
        depth++;
        last = c;
      } else if (c === "]" || c === "}") {
        depth--;
        if (depth === 0) return c === "]" ? { open, close: i, last } : null;
        if (depth < 0) return null;
        last = c;
      } else if (!/\s/.test(c)) {
        if (depth === 0) return null;
        last = c;
      }
      i++;
    }
    return null;
  };
  const userRules = (text) => {
    const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const stripped = stripJsonc(source);
    try {
      const parsed = JSON.parse(stripped);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) { /* read it object by object below */ }
    const rules = [];
    for (const piece of stripped.match(/\{[^{}]*\}/g) || []) {
      try { rules.push(JSON.parse(piece)); } catch (e) { /* not a rule */ }
    }
    return rules;
  };
  const withOverlay = (text, chords, unbind) => {
    const base = removeOverlay(text === null ? "" : text, chords);
    const seen = new Set();
    const unbound = [];
    for (const rule of userRules(base)) {
      if (rule === null || typeof rule !== "object" || typeof rule.key !== "string" || typeof rule.command !== "string") continue;
      if (rule.command === "" || rule.command.charAt(0) === "-" || unbind.indexOf(rule.command) < 0) continue;
      const entry = typeof rule.when === "string" ? { key: rule.key, command: UNBOUND_COMMAND, when: rule.when } : { key: rule.key, command: UNBOUND_COMMAND };
      const id = JSON.stringify(entry);
      if (seen.has(id)) continue;
      seen.add(id);
      unbound.push(entry);
    }
    const lines = chords.concat(unbound).map((e) => "  " + JSON.stringify(e)).join(",\n");
    const root = rootArray(base);
    if (root !== null) {
      const comma = root.last !== "[" && root.last !== ",";
      return base.slice(0, root.close) + (comma ? "," + OVERLAY_BEGIN_AFTER_COMMA : OVERLAY_BEGIN) + "\n" + lines + "\n" + OVERLAY_END + "\n" + base.slice(root.close);
    }
    const bom = base.charCodeAt(0) === 0xfeff ? base.charAt(0) : "";
    return bom + OVERLAY_BEGIN + "\n[\n" + lines + "\n]\n" + OVERLAY_END + "\n" + base.slice(bom.length);
  };`;
