/**
 * The shell-recognition rule (G10) against fixed `ps -A -o pid=,ppid=,command=` text. The shape is the one measured in
 * docs/terminal-spike.md (S4): wrapper -> cli -> tunnel -> launcher -> server-main -> { extension host, pty host }, and one
 * shell per terminal as a child of the pty host. The pids are made up; the shape is the measured one.
 */
import { describe, expect, it } from "vitest";
import { hasLiveTerminalShell, liveShellPids } from "../../src/terminal-keepalive";

const WRAPPER = 100;
const SERVER = [
  "100 1 bash /opt/code/bin/code serve-web --host 127.0.0.1 --port 52115 --connection-token-file /vault/.server/connection-token",
  "101 100 /opt/code/Code - Insiders /opt/code/resources/app/out/cli.js serve-web --host 127.0.0.1 --port 52115",
  "102 101 /opt/code/code-tunnel-insiders serve-web --host 127.0.0.1 --port 52115",
  "103 102 bash /srv/server/bin/code-server-insiders --socket-path /tmp/code-insiders-abc.sock",
  "104 103 /srv/server/node /srv/server/out/server-main.js --socket-path /tmp/code-insiders-abc.sock",
  "110 104 /srv/server/node /srv/server/out/bootstrap-fork --type=extensionHost --transformURIs",
  "120 104 /srv/server/node /srv/server/out/bootstrap-fork --type=ptyHost --logsPath /srv/logs",
];
const ps = (...rows: string[]) => rows.map((r) => `${r}`.padStart(r.length + 2)).join("\n") + "\n";

describe("liveShellPids: which processes under the server are live terminal shells", () => {
  it("no terminal yet: the pty host has no child", () => {
    expect(liveShellPids(ps(...SERVER), WRAPPER)).toEqual([]);
  });

  it("an idle prompt: the shell is a child of the pty host and has no child of its own", () => {
    expect(liveShellPids(ps(...SERVER, "130 120 /bin/zsh -il"), WRAPPER)).toEqual([130]);
  });

  it("a running command: the shell is counted once, not its command or the command's children", () => {
    const out = liveShellPids(ps(...SERVER, "130 120 /bin/zsh -il", "131 130 sleep 600", "132 131 sleep 600"), WRAPPER);
    expect(out).toEqual([130]);
  });

  it("two terminals, one idle and one running a dev server: both shells", () => {
    expect(liveShellPids(ps(...SERVER, "130 120 /bin/zsh -il", "140 120 /bin/bash --login", "141 140 node server.js"), WRAPPER)).toEqual([130, 140]);
  });

  it("an exited shell with other children left behind: they were re-parented to init, so nothing under the server is a shell", () => {
    // the shell 130 is gone from the table; its tab may remain on the page, which is not asked. The nohup child is now a child of init (1).
    expect(liveShellPids(ps(...SERVER, "131 1 sleep 600", "132 131 sleep 600"), WRAPPER)).toEqual([]);
  });

  it("an exited shell whose tab is left: of two terminals only the one whose process is still in the table counts", () => {
    expect(liveShellPids(ps(...SERVER, "130 120 /bin/zsh -il"), WRAPPER)).toEqual([130]);
  });

  it("an exited shell not yet collected (a zombie) does not count, on macOS and Linux", () => {
    expect(liveShellPids(ps(...SERVER, "130 120 (zsh)"), WRAPPER)).toEqual([]);
    expect(liveShellPids(ps(...SERVER, "130 120 [zsh] <defunct>"), WRAPPER)).toEqual([]);
    expect(liveShellPids(ps(...SERVER, "130 120 (zsh)", "140 120 /bin/zsh -il"), WRAPPER)).toEqual([140]);
  });

  it("a hung shell (stopped, still the pty host's child) counts: ps shows the same row for it", () => {
    expect(liveShellPids(ps(...SERVER, "130 120 /bin/zsh -il", "150 120 /bin/zsh -il"), WRAPPER)).toEqual([130, 150]);
  });

  it("a shell outside the server's tree does not count: another VS Code's pty host and a shell in a Terminal.app window", () => {
    const other = [
      "900 1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron",
      "901 900 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (PtyHost) --type=ptyHost",
      "902 901 /bin/zsh -il",
      "950 1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
      "951 950 /bin/zsh -il",
    ];
    expect(liveShellPids(ps(...SERVER, ...other), WRAPPER)).toEqual([]);
    expect(liveShellPids(ps(...SERVER, "130 120 /bin/zsh -il", ...other), WRAPPER)).toEqual([130]);
  });

  it("a child of the server that is not under a pty host is not a shell: the launcher scripts are bash too", () => {
    // 103 is a bash launcher under the server; its command line is a shell's, but it is not a terminal.
    expect(liveShellPids(ps(...SERVER, "135 104 /bin/sh -c something"), WRAPPER)).toEqual([]);
  });

  it("an extension host's children are not shells", () => {
    expect(liveShellPids(ps(...SERVER, "136 110 /bin/zsh -c language-server"), WRAPPER)).toEqual([]);
  });

  it("a pty host that is not under the root is not looked at, even when a shell hangs under it", () => {
    expect(liveShellPids(ps(...SERVER.slice(0, 3), "120 999 node bootstrap-fork --type=ptyHost", "130 120 /bin/zsh -il"), WRAPPER)).toEqual([]);
  });

  it("a command that only mentions ptyHost in an argument value is not a pty host", () => {
    expect(liveShellPids(ps(...SERVER.slice(0, 5), "121 104 node run.js --name=notptyHost", "131 121 /bin/zsh -il"), WRAPPER)).toEqual([]);
  });

  it("an empty table", () => {
    expect(liveShellPids("", WRAPPER)).toEqual([]);
    expect(liveShellPids("\n\n", WRAPPER)).toEqual([]);
  });

  it("a root that is not in the table", () => {
    expect(liveShellPids(ps(...SERVER, "130 120 /bin/zsh -il"), 4242)).toEqual([]);
  });

  it("malformed lines are skipped and do not hide the shells around them", () => {
    const out = liveShellPids(["garbage", ...ps(...SERVER).split("\n"), "130 120", "abc 120 /bin/zsh", "131 xyz /bin/zsh", "  140   120   /bin/zsh -il", "", "999"].join("\n"), WRAPPER);
    expect(out).toEqual([140]); // "130 120" has no command: skipped
  });
});

describe("hasLiveTerminalShell: the reader and the rule together", () => {
  it("true with a shell under the server, from the text the reader returns", async () => {
    expect(await hasLiveTerminalShell(WRAPPER, async () => ps(...SERVER, "130 120 /bin/zsh -il"))).toBe(true);
  });

  it("false with the pty host alone", async () => {
    expect(await hasLiveTerminalShell(WRAPPER, async () => ps(...SERVER))).toBe(false);
  });

  it("false when there is no server process", async () => {
    let read = false;
    expect(
      await hasLiveTerminalShell(undefined, async () => {
        read = true;
        return "";
      }),
    ).toBe(false);
    expect(read).toBe(false);
  });

  it("a reader that fails rejects: the idle clock reads that as 'cannot tell'", async () => {
    await expect(
      hasLiveTerminalShell(WRAPPER, async () => {
        throw new Error("ps failed");
      }),
    ).rejects.toThrow("ps failed");
  });

  it("the default reader reads this machine's real process table: a pid that is not a server has no shell, and this test process is not under a pty host", async () => {
    expect(await hasLiveTerminalShell(process.pid)).toBe(false);
  });
});
