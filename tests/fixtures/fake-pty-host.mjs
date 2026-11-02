// Stand-in for the VS Code server's pty host, started by fake-serve-web.mjs when FAKE_CODE_TERMINAL_PIDFILE is set. Like the
// real one it carries `--type=ptyHost` on its command line and runs one terminal as a child: a long-lived `sh` (the `; true`
// keeps sh as the parent instead of exec-ing the sleep), in its own process group so that a test can end the shell and its sleep
// together. The shell's pid is appended to the file named by FAKE_CODE_TERMINAL_PIDFILE.
import { spawn } from "node:child_process";
import fs from "node:fs";

const shell = spawn("sh", ["-c", "sleep 600; true"], { detached: true, stdio: "ignore" });
fs.appendFileSync(process.env.FAKE_CODE_TERMINAL_PIDFILE, `${shell.pid}\n`);
shell.on("exit", () => undefined);
setInterval(() => undefined, 1000);
