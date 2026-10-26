import { describe, expect, it } from "vitest";
import { buildServeWebArgs, parseServeWebHelp, LOOPBACK_HOST } from "../../src/server";

const base = {
  port: 51234,
  tokenFile: "/vault/.obsidian/plugins/obsidian-vscode-workbench/.server/connection-token",
  serverDataDir: "/vault/.obsidian/plugins/obsidian-vscode-workbench/.server/server-data",
  cliDataDir: "/vault/.obsidian/plugins/obsidian-vscode-workbench/.server/cli-data",
  acceptLicense: false,
};

function valueOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe("buildServeWebArgs", () => {
  it("starts with serve-web and binds to 127.0.0.1 (F4)", () => {
    const args = buildServeWebArgs(base);
    expect(args[0]).toBe("serve-web");
    expect(LOOPBACK_HOST).toBe("127.0.0.1");
    expect(valueOf(args, "--host")).toBe("127.0.0.1");
    expect(args.filter((a) => a === "--host")).toHaveLength(1);
  });

  it("never names a wildcard or non-loopback address (F4)", () => {
    const joined = buildServeWebArgs({ ...base, acceptLicense: true }).join(" ");
    expect(joined).not.toMatch(/0\.0\.0\.0|::|\*|localhost/);
  });

  it("passes the chosen port as a string", () => {
    expect(valueOf(buildServeWebArgs(base), "--port")).toBe("51234");
  });

  it("uses --connection-token-file and never carries a token itself", () => {
    const args = buildServeWebArgs(base);
    expect(valueOf(args, "--connection-token-file")).toBe(base.tokenFile);
    expect(args).not.toContain("--connection-token");
    expect(args).not.toContain("--without-connection-token");
    // no argument looks like a 64-hex token or carries tkn=
    expect(args.filter((a) => /^[0-9a-f]{32,}$/i.test(a) || a.includes("tkn="))).toEqual([]);
  });

  it("adds --accept-server-license-terms only when the licence flag is set", () => {
    expect(buildServeWebArgs(base)).not.toContain("--accept-server-license-terms");
    expect(buildServeWebArgs({ ...base, acceptLicense: true })).toContain("--accept-server-license-terms");
  });

  it("switches telemetry off by default and omits the flag only when told the build lacks it (F5)", () => {
    expect(buildServeWebArgs(base)).toContain("--disable-telemetry");
    expect(buildServeWebArgs({ ...base, disableTelemetry: true })).toContain("--disable-telemetry");
    expect(buildServeWebArgs({ ...base, disableTelemetry: false })).not.toContain("--disable-telemetry");
  });

  it("pins the server to the installed build's commit so serve-web does not ask for the latest on every start (F5)", () => {
    const sha = "a57ca762e62475ed8fc64b5aec67485c06766141";
    expect(valueOf(buildServeWebArgs({ ...base, commitId: sha }), "--commit-id")).toBe(sha);
    expect(buildServeWebArgs(base)).not.toContain("--commit-id");
    expect(buildServeWebArgs({ ...base, commitId: null })).not.toContain("--commit-id");
    expect(buildServeWebArgs({ ...base, commitId: "latest; rm -rf" })).not.toContain("--commit-id");
  });

  it("keeps server and CLI data in the plugin-owned dirs it was given", () => {
    const args = buildServeWebArgs(base);
    expect(valueOf(args, "--server-data-dir")).toBe(base.serverDataDir);
    expect(valueOf(args, "--cli-data-dir")).toBe(base.cliDataDir);
  });
});

describe("parseServeWebHelp", () => {
  const help = "Usage: code-tunnel serve-web [OPTIONS]\n --connection-token-file <F>\n --disable-telemetry\n";

  it("accepts a build whose --help lists the token-file and telemetry flags", () => {
    expect(parseServeWebHelp(0, help)).toEqual({ serveWeb: true, disableTelemetry: true, connectionTokenFile: true });
  });

  it("records a build without --disable-telemetry", () => {
    const s = parseServeWebHelp(0, "serve-web\n --connection-token-file <F>");
    expect(s.serveWeb).toBe(true);
    expect(s.disableTelemetry).toBe(false);
  });

  it("refuses a build whose serve-web --help fails", () => {
    expect(parseServeWebHelp(2, "error: unrecognized subcommand 'serve-web'").serveWeb).toBe(false);
    expect(parseServeWebHelp(0, "Usage: code [options]").serveWeb).toBe(false);
  });
});
