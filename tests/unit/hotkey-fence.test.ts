/**
 * The bridge's fences: it makes and accepts no network connection of its own (F4), sends nothing out and logs no
 * key content (F5), adds no native module (F9) and writes no note. And the decision constant (E12) is the value
 * `docs/spike-decision.md` records.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { HOTKEY_BRIDGE } from "../../src/hotkey/decision";
import { parseDecision } from "../decision";
import { REPO_ROOT } from "../helpers";

const DIR = path.join(REPO_ROOT, "src/hotkey");
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".ts"));
const sources = files.map((f) => [f, fs.readFileSync(path.join(DIR, f), "utf8")] as const);

describe("decision constant (E12)", () => {
  it("equals the hotkey_bridge header of docs/spike-decision.md", () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, "docs/spike-decision.md"), "utf8");
    expect(HOTKEY_BRIDGE).toBe(parseDecision(text).hotkey_bridge);
  });

  it("is read nowhere else in src/ (the relay asks bridgeEnabled), so no other code hard-codes the answer", () => {
    const users: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts") && /HOTKEY_BRIDGE/.test(fs.readFileSync(p, "utf8"))) users.push(path.relative(REPO_ROOT, p));
      }
    };
    walk(path.join(REPO_ROOT, "src"));
    expect(users).toEqual(["src/hotkey/decision.ts"]);
  });
});

describe("src/hotkey fences", () => {
  it("has the modules to check", () => {
    expect(files.sort()).toEqual(["decision.ts", "drawer-toggle.ts", "embed-key-relay.ts", "hotkey-bridge.ts"]);
  });

  it("opens no socket and makes no request (F4, F5): no net, http, ws, fetch, XMLHttpRequest, WebSocket, beacon", () => {
    for (const [file, text] of sources) {
      expect(text, file).not.toMatch(/from\s+["'](?:node:)?(?:net|dgram|http2?|https|tls|ws)["']/);
      expect(text, file).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|createServer|\.listen\s*\(/);
    }
  });

  it("imports only its own modules: no third-party or native module (F9), no child process, no file access", () => {
    for (const [file, text] of sources) {
      for (const m of text.matchAll(/from\s+["']([^"']+)["']/g)) expect(m[1], file).toMatch(/^\.\.?\//);
      expect(text, file).not.toMatch(/child_process|node:fs|require\(/);
    }
  });

  it("never logs: no console use in the host modules, and the page script's one console use is the bound log it reports through", () => {
    for (const [file, text] of sources) {
      if (file === "hotkey-bridge.ts") {
        expect(text.match(/console\.\w+[.(]/g)).toEqual(["console.log."]); // a call or a bind; prose mentions have neither
        expect(text).toContain("var log = console.log.bind(console);");
        expect(text.match(/\blog\(/g)).toEqual(["log("]);
      } else {
        expect(text, file).not.toMatch(/console\./);
      }
    }
  });

  it("the page script sends only the version and the action name (and, on the console line, the load's nonce)", () => {
    const text = fs.readFileSync(path.join(DIR, "hotkey-bridge.ts"), "utf8");
    expect(text).toContain("var payload = { v: 1, action: action };");
    expect(text).toContain("if (nonce !== null) payload.n = nonce;");
    expect(text.match(/payload\.\w+ =/g)).toEqual(["payload.n ="]);
    expect(text).toMatch(/postMessage\(\{ vscw: 1, v: payload\.v, action: payload\.action \}/);
  });
});
