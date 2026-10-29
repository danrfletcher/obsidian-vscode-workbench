import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTokenFile, redactToken } from "../../src/server";
import { tempDir } from "../helpers";

const mode = (p: string) => fs.statSync(p).mode & 0o777;

afterEach(() => vi.restoreAllMocks());

describe("createTokenFile", () => {
  it("creates the file with mode 0600 and a 64-hex-char token matching its content", () => {
    const file = path.join(tempDir(), "plugin", ".server", "connection-token");
    const token = createTokenFile(file);
    expect(mode(file)).toBe(0o600);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(file, "utf8")).toBe(token);
  });

  it("regenerates a different token on every call", () => {
    const file = path.join(tempDir(), "connection-token");
    const tokens = new Set([createTokenFile(file), createTokenFile(file), createTokenFile(file)]);
    expect(tokens.size).toBe(3);
    expect(fs.readFileSync(file, "utf8")).toBe([...tokens][2]);
  });

  it("tightens a pre-existing world-readable file to 0600", () => {
    const file = path.join(tempDir(), "connection-token");
    fs.writeFileSync(file, "old", { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    createTokenFile(file);
    expect(mode(file)).toBe(0o600);
  });

  it("never writes the token to console or to a data.json next to it", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const dir = tempDir();
    const token = createTokenFile(path.join(dir, "connection-token"));
    const logged = spies.flatMap((s) => s.mock.calls.flat()).join("\n");
    expect(logged).not.toContain(token);
    expect(fs.existsSync(path.join(dir, "data.json"))).toBe(false);
    // the only file written is the token file itself
    expect(fs.readdirSync(dir)).toEqual(["connection-token"]);
  });
});

describe("redactToken", () => {
  const token = "ab".repeat(32);

  it("removes the token and any tkn= query value from text bound for a Notice", () => {
    const text = `listen failed at http://127.0.0.1:1?tkn=${token}&x=1 (secret ${token})`;
    const out = redactToken(text, token);
    expect(out).not.toContain(token);
    expect(out).toBe("listen failed at http://127.0.0.1:1?tkn=<redacted>&x=1 (secret <redacted>)");
  });

  it("still strips tkn= values when the token itself is unknown", () => {
    expect(redactToken("url ?tkn=deadbeef end", null)).toBe("url ?tkn=<redacted> end");
  });
});
