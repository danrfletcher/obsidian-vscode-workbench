// Stand-in for the VS Code server's pty host, started by fake-serve-web.mjs when FAKE_CODE_TERMINAL_PIDFILE is set. Like the
// real one it carries `--type=ptyHost` on its command line and runs one terminal as a child: a long-lived `sh` (the `; true`
// keeps sh as the parent instead of exec-ing the sleep), in its own process group so that a test can end the shell and its sleep
// together. The shell's pid is appended to the file named by FAKE_CODE_TERMINAL_PIDFILE.
import { spawn } from "node:child_process";
import fs from "node:fs";

const shell = spawn("sh", ["-c", "sleep 600; true"], { detached: true, stdio: "ignore" });
fs.appendFileSync(process.env.FAKE_CODE_TERMINAL_PIDFILE, `${shell.pid}\n`);
shell.on("exit", () => undefined);
// Like the real pty host, this is not meant to outlive its server: when the server (its parent) is gone, the shell and its
// `sleep` go too, so a test run that is killed before its afterEach leaves nothing behind for the length of the sleep.
const server = process.ppid;
setInterval(() => {
  if (process.ppid === server) return;
  if (shell.pid) { try { process.kill(-shell.pid, "SIGKILL"); } catch { /* already gone */ } }
  process.exit(0);
}, 500);
