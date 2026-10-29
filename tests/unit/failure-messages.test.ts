/**
 * Table-driven: every start and download failure maps to its exact Notice text.
 * Errors are built the way server.ts builds them.
 */
import { describe, expect, it } from "vitest";
import { describeFailure, lastLine, type FailureContext } from "../../src/failure-messages";
import { ServerStartError, redactToken } from "../../src/server";
import { promptReuseBuild } from "../../src/modals";
import { Modal } from "../mocks/obsidian";

const P = "VS Code Workbench: ";
const DNS = "Error downloading server: error sending request for url (https://update.example/): error trying to connect: dns error: failed to lookup address information";

interface Row {
  name: string;
  err: unknown;
  ctx?: FailureContext;
  kind: string;
  message: string;
  offer?: { commit: string; version: string };
}

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const updated: FailureContext = { installedVersion: "1.145.0", installedCommit: NEW, lastServer: { commit: OLD, version: "1.144.2" }, lastServerCached: true };

const rows: Row[] = [
  {
    name: "missing VS Code",
    err: new ServerStartError("No VS Code installation found.", null, "", { kind: "missing-binary" }),
    kind: "missing-binary",
    message: `${P}VS Code was not found. Install Visual Studio Code, then open a Code tab again.`,
  },
  {
    name: "the CLI path does not exist (spawn ENOENT)",
    err: new ServerStartError("Could not run VS Code: spawn /x/code ENOENT", null, "", { kind: "spawn" }),
    kind: "missing-binary",
    message: `${P}VS Code was not found. Install Visual Studio Code, then open a Code tab again.`,
  },
  {
    name: "missing serve-web",
    err: new ServerStartError('/Applications/VSCodium.app/bin/codium has no "serve-web" command.', null, "", { kind: "no-serve-web", detail: "/Applications/VSCodium.app/bin/codium" }),
    kind: "no-serve-web",
    message: `${P}/Applications/VSCodium.app/bin/codium has no "serve-web" command. Update Visual Studio Code to a version that includes it.`,
  },
  {
    name: "port bind failure (address in use), with port, exit code and last stderr line",
    err: new ServerStartError("x", 1, "starting\nError: listen EADDRINUSE: address already in use 127.0.0.1:52100", { kind: "exit", port: 52100 } as never),
    kind: "port-bind",
    message: `${P}The VS Code server could not listen on 127.0.0.1:52100 (exit code 1). Use "Restart server" in the plugin settings to try another port. Last message: Error: listen EADDRINUSE: address already in use 127.0.0.1:52100`,
  },
  {
    name: "port bind failure from Rust's wording",
    err: new ServerStartError("x", 101, "error: could not bind to 127.0.0.1:9 (os error 48)", { kind: "exit", port: 9 }),
    kind: "port-bind",
    message: `${P}The VS Code server could not listen on 127.0.0.1:9 (exit code 101). Use "Restart server" in the plugin settings to try another port. Last message: error: could not bind to 127.0.0.1:9 (os error 48)`,
  },
  {
    name: "offline on the first run (nothing was ever downloaded)",
    err: new ServerStartError("x", 1, DNS, { kind: "exit", port: 1 }),
    ctx: { installedVersion: "1.144.2", installedCommit: NEW, lastServer: null },
    kind: "offline-first-run",
    message: `${P}The VS Code server could not be downloaded because the network is unreachable. Connect to the internet and open a Code tab again. Your licence acceptance is kept.`,
  },
  {
    name: "offline, last build recorded but no longer in the cache: still a first-run message",
    err: new ServerStartError("x", 1, DNS, { kind: "exit" }),
    ctx: { ...updated, lastServerCached: false },
    kind: "offline-first-run",
    message: `${P}The VS Code server could not be downloaded because the network is unreachable. Connect to the internet and open a Code tab again. Your licence acceptance is kept.`,
  },
  {
    name: "offline re-download after a VS Code update: names the version change and offers the last build",
    err: new ServerStartError("x", 1, DNS, { kind: "exit" }),
    ctx: updated,
    kind: "offline-redownload",
    message: `${P}VS Code was updated from 1.144.2 to 1.145.0, and the matching VS Code server cannot be downloaded because the network is unreachable. The server downloaded for 1.144.2 is still available.`,
    offer: { commit: OLD, version: "1.144.2" },
  },
  {
    name: "offline with the same commit as the last build is not an update",
    err: new ServerStartError("x", 1, "dns error", { kind: "exit" }),
    ctx: { ...updated, installedCommit: OLD },
    kind: "offline-first-run",
    message: `${P}The VS Code server could not be downloaded because the network is unreachable. Connect to the internet and open a Code tab again. Your licence acceptance is kept.`,
  },
  {
    name: "offline as the real serve-web reports it (log tail from stdout, reason added by the reachability check)",
    err: new ServerStartError("x", null, "[2026-10-26 11:36:36] info Downloading server aaaa\n[2026-10-26 11:36:37] info Downloading server aaaa\nThe server download was attempted again after it failed.\nNetwork is unreachable: could not connect to update.code.visualstudio.com (dns error: failed to lookup address information).", { kind: "download" }),
    ctx: { installedVersion: "1.144.2", installedCommit: NEW, lastServer: null },
    kind: "offline-first-run",
    message: `${P}The VS Code server could not be downloaded because the network is unreachable. Connect to the internet and open a Code tab again. Your licence acceptance is kept.`,
  },
  {
    name: "offline re-download as the real serve-web reports it",
    err: new ServerStartError("x", null, "[t] info Downloading server bbbb\nNetwork is unreachable: could not connect to update.code.visualstudio.com (dns error: failed to lookup address information).", { kind: "download" }),
    ctx: updated,
    kind: "offline-redownload",
    message: `${P}VS Code was updated from 1.144.2 to 1.145.0, and the matching VS Code server cannot be downloaded because the network is unreachable. The server downloaded for 1.144.2 is still available.`,
    offer: { commit: OLD, version: "1.144.2" },
  },
  {
    name: "download failed while the download host is reachable: not called offline",
    err: new ServerStartError("x", null, "[t] info Downloading server cccc\nThe server download keeps failing although update.code.visualstudio.com answers.", { kind: "download" }),
    kind: "download",
    message: `${P}The VS Code server could not be downloaded. Try again later, or use "Restart server" in the plugin settings. Your licence acceptance is kept. Last message: The server download keeps failing although update.code.visualstudio.com answers.`,
  },
  {
    name: "non-zero exit, with the last stderr line",
    err: new ServerStartError("x", 5, "booting\nfatal: the fake server broke", { kind: "exit" }),
    kind: "exit",
    message: `${P}The VS Code server exited with code 5. Last message: fatal: the fake server broke`,
  },
  {
    name: "non-zero exit with no stderr",
    err: new ServerStartError("x", 2, "", { kind: "exit" }),
    kind: "exit",
    message: `${P}The VS Code server exited with code 2.`,
  },
  {
    name: "killed by a signal before it was ready",
    err: new ServerStartError("x", null, "", { kind: "exit" }),
    kind: "exit",
    message: `${P}The VS Code server was stopped before it was ready.`,
  },
  {
    name: "not ready in time",
    err: new ServerStartError("x", null, "warming up", { kind: "timeout", seconds: 30 }),
    kind: "timeout",
    message: `${P}The VS Code server was not ready after 30 s. Last message: warming up`,
  },
  {
    name: "any other error is shown as its message",
    err: new Error("disk full"),
    kind: "spawn",
    message: `${P}disk full`,
  },
];

describe("describeFailure", () => {
  it.each(rows)("$name", (row) => {
    const f = describeFailure(row.err, row.ctx);
    expect(f.kind).toBe(row.kind);
    expect(f.message).toBe(row.message);
    expect(f.offerReuse).toEqual(row.offer);
  });

  it("an offline re-download carries the version change for the reuse prompt", () => {
    const f = describeFailure(new ServerStartError("x", 1, DNS, { kind: "exit" }), updated);
    expect(f.versionChange).toEqual({ from: "1.144.2", to: "1.145.0" });
  });

  it("never lets the connection token into the text, even from an unredacted stderr tail", () => {
    const token = "f".repeat(64);
    const f = describeFailure(new ServerStartError("x", 5, `boom tkn=${token}\nUI at http://127.0.0.1:1/?tkn=${token}`, { kind: "exit" }));
    expect(f.message).not.toContain(token);
    expect(f.message).toContain("tkn=<redacted>");
  });

  // Obsidian wraps a Notice and a Modal paragraph at word breaks, so text is only cut off by one very long
  // word or by a very long message. Hold both offline texts (and the reuse offer's wording) to that.
  it("the offline notices and the reuse offer wrap cleanly: one paragraph, no long unbroken word, bounded length", () => {
    const first = describeFailure(new ServerStartError("x", 1, DNS, { kind: "exit" }), { installedVersion: "1.144.2", installedCommit: NEW, lastServer: null });
    const again = describeFailure(new ServerStartError("x", 1, DNS, { kind: "exit" }), updated);
    expect(first.kind).toBe("offline-first-run");
    expect(again.kind).toBe("offline-redownload");
    for (const text of [first.message, again.message]) {
      expect(text).not.toMatch(/\n/);
      expect(text.length).toBeLessThanOrEqual(320);
      expect(Math.max(...text.split(/\s+/).map((w) => w.length))).toBeLessThanOrEqual(30);
      expect(text).not.toContain("dns error"); // the raw log line is not quoted
    }
  });

  it("the reuse offer modal is short paragraphs plus two buttons, none with a long unbroken word", async () => {
    Modal.reset();
    const answer = promptReuseBuild({} as never, { from: "1.144.2", to: "1.145.0" });
    const modal = Modal.opened[Modal.opened.length - 1] as unknown as { contentEl: import("../mocks/obsidian").FakeNode; close(): void };
    const buttons = modal.contentEl.buttons();
    expect(buttons.map((b) => b.text)).toEqual(["Not now", "Use 1.144.2 server"]);
    const text = JSON.stringify(modal.contentEl);
    expect(text).toContain("network is unreachable");
    expect(text).toContain("1.144.2");
    expect(text).toContain("1.145.0");
    for (const w of text.split(/[\s"]+/)) expect(w.length).toBeLessThanOrEqual(40);
    modal.close();
    await expect(answer).resolves.toBe(false);
  });

  it("lastLine skips blank lines and trims", () => {
    expect(lastLine("a\n  b  \n\n")).toBe("b");
    expect(lastLine("")).toBe("");
  });

  it("redactToken is what keeps a bare token out", () => {
    expect(redactToken("secret abc", "abc")).toBe("secret <redacted>");
  });
});
