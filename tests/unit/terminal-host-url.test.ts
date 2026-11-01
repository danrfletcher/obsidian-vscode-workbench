import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CODE_TAB_PARTITION } from "../../src/code-view";
import { BROWSER_APP_SETTINGS } from "../../src/settings";
import { PANEL_SETTINGS, TERMINAL_PAGE_SETTING, TERMINAL_PARTITION, buildTerminalHostUrl, hostOriginUrl, hostSettings } from "../../src/terminal-host/host-url";
import { REPO_ROOT } from "../helpers";

const BASE = "http://127.0.0.1:5555";

describe("the terminal host page's URL (PR-1 recipe, S1)", () => {
  it("is the server's workbench page on the vault root with the token", () => {
    const url = new URL(buildTerminalHostUrl(BASE, "/Users/dan/My Vault", "tok123"));
    expect(url.origin).toBe(BASE);
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("folder")).toBe("/Users/dan/My Vault");
    expect(url.searchParams.get("tkn")).toBe("tok123");
    // the folder only: no file to open, so no editor payload
    expect([...url.searchParams.keys()].sort()).toEqual(["folder", "tkn"]);
  });

  it("percent-encodes a vault path with spaces, #, ?, % and non-ASCII characters so it survives the round trip", () => {
    const root = "/Users/dan/Vault #1 ?% estimaté 文件";
    const raw = buildTerminalHostUrl(BASE, root, "t");
    expect(raw).not.toContain(" ");
    expect(new URL(raw).searchParams.get("folder")).toBe(root);
  });

  it("carries no token when none is given", () => {
    const url = new URL(buildTerminalHostUrl(BASE, "/v"));
    expect(url.searchParams.has("tkn")).toBe(false);
  });

  it("the page the settings are written from is the bare origin, with no token and no folder", () => {
    expect(hostOriginUrl(BASE)).toBe("http://127.0.0.1:5555/");
    expect(hostOriginUrl(BASE)).not.toMatch(/tkn|folder|\?/);
  });

  it("uses the Code tab server's own origin (F3): the same host and port, never a second server", () => {
    expect(new URL(buildTerminalHostUrl("http://127.0.0.1:61092", "/v", "t")).origin).toBe("http://127.0.0.1:61092");
  });
});

describe("the host page's partition (F5)", () => {
  it("is not the Code tabs' partition, by value and by prefix", () => {
    expect(TERMINAL_PARTITION).toBe("persist:vscode-workbench-terminal");
    expect(CODE_TAB_PARTITION).toBe("persist:vscode-workbench");
    expect(TERMINAL_PARTITION).not.toBe(CODE_TAB_PARTITION);
  });

  it("is persistent, so the panel layout it keeps holds across reloads", () => {
    expect(TERMINAL_PARTITION.startsWith("persist:")).toBe(true);
  });

  it("code-view.ts gives its webviews the partition it exports, and never the host's", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "src/code-view.ts"), "utf8");
    expect(src).toContain('setAttribute("partition", CODE_TAB_PARTITION)');
    expect(src).not.toContain(TERMINAL_PARTITION);
    const host = fs.readFileSync(path.join(REPO_ROOT, "src/terminal-host/host-page.ts"), "utf8");
    expect(host).toContain('setAttribute("partition", TERMINAL_PARTITION)');
    expect(host).not.toContain("CODE_TAB_PARTITION");
  });
});

describe("the host page's settings", () => {
  it("are the Code tab's off switches, its overlay, and then the panel-only ones", () => {
    const merged = hostSettings({ "workbench.colorTheme": "Light Modern", "workbench.statusBar.visible": false });
    for (const [k, v] of Object.entries(BROWSER_APP_SETTINGS)) expect(merged[k], k).toEqual(v);
    expect(merged["workbench.colorTheme"]).toBe("Light Modern");
    expect(merged["workbench.panel.opensMaximized"]).toBe("always");
    expect(merged[TERMINAL_PAGE_SETTING]).toBe(true);
    expect(TERMINAL_PAGE_SETTING).toBe("obsidianWorkbench.terminalPage");
  });

  it("the panel-only settings win over an overlay that sets the same key", () => {
    expect(hostSettings({ "workbench.panel.opensMaximized": "never" })["workbench.panel.opensMaximized"]).toBe("always");
    expect(PANEL_SETTINGS["workbench.panel.opensMaximized"]).toBe("always");
  });
});
