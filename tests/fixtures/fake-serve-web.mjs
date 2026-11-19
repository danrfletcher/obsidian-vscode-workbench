// Stand-in for the `code serve-web` server. Behaviour is chosen with FAKE_CODE_MODE:
//   (unset)      listen on --host/--port, token from --connection-token-file
//   exit-early   print an error to stderr (which contains the token) and exit 3
//   exit-plain   print "fatal: the fake server broke" to stderr and exit 5
//   exit-stdout  like the real CLI on a failure: log to stdout only (stderr stays empty) and exit 7
//   offline      behave like the real CLI when the server download cannot be fetched (measured against the real
//                `code serve-web`): listen, log to STDOUT, leave stderr empty, never exit, answer every request
//                202 "downloading" and log "info Downloading server <commit>" once per request, with no reason.
//                FAKE_CODE_PARTIAL_DIR (if set) is created first, like a half-downloaded server build;
//                FAKE_CODE_OFFLINE_EXCEPT=<commit> lets a start with --commit-id <commit> succeed (a cached build)
//   download-500 like offline, but the failed download is reported in the page: 500 "An error was encountered
//                downloading the server, please retry: ..."
//   download-error-log  like offline, but each attempt also logs an error-level line about the download
//   slow-download  a real, slow download: FAKE_CODE_DOWNLOAD_REQUESTS=n requests answer 202, "Downloading server" is logged once
//   workbench    answer a request with a page that has the parts of the VS Code workbench under their real class names
//                (fake-workbench-page.mjs, imported only in these two modes: other tests copy this file alone), built a moment after
//                load, that applies the browser profile's settings and keybindings and a saved layout. The file to open is the
//                first entry of the URL's `payload`, as the Code tab builds it
//   workbench-renamed  the same page with every class name of every part changed, as after a VS Code update that renamed them
//   hang         never listen
// FAKE_CODE_DOWNLOAD_REQUESTS=n makes the first n requests answer 202 (server still downloading).
// FAKE_CODE_MAX_LIFETIME_S=s (default 600): the server ends itself and everything it started after s seconds (see below).
// A server that starts extras (the shells below, the pty host) also starts one detached watcher for them (the reaper, further
//   down), which ends them when the test process that started this fake is gone, even after the wrapper and this server have
//   ended, and leaves by itself once they have all ended.
// FAKE_CODE_SHELL_PORT=p makes the server start a terminal the way the real one's pty host does: a shell in its own
//   process group (the pty's session) with a child `python3 -m http.server p --bind 127.0.0.1`. The shell's pid is
//   appended to FAKE_CODE_SHELL_PIDFILE. The shell is a descendant of the server and carries neither the server's
//   token-file path nor "serve-web" on its command line, like a real shell under the pty host. FAKE_CODE_SHELL_NOHUP_PIDFILE=f adds
//   a `nohup sleep 307 &` child of that shell, its pid appended to f.
// FAKE_CODE_SHELLS=n makes the server hold n live terminal children, started the way a shell of the real server is: children of the
//   server in its own process group, not detached. FAKE_CODE_SHELL_KINDS=a,b,c (default: all `sleep`) picks each child's kind, in
//   order and repeating: `sleep` is a bare `sleep 600` (an idle shell), `fg` a shell with a foreground child (`sh -c 'sleep 600; true'`),
//   `ignore` a shell that ignores SIGTERM and SIGHUP and keeps starting `sleep 600` (only SIGKILL ends it). One more child is
//   started the way a `nohup`/`setsid` process is: in a session of its own and re-parented to init, so neither the tree nor the
//   process group of the server reaches it. Their pids go to FAKE_CODE_PIDFILE after the server's own, one per line, as
//   `shell <pid>` and `setsid <pid>` (the server's line is a bare number, so a reader that wants only servers still gets them).
// FAKE_CODE_TERMINAL_PIDFILE=f makes the server start a pty host the way the real one does (fake-pty-host.mjs: a node process
//   with `--type=ptyHost` on its command line) whose one terminal is a long-lived `sh`. The shell's pid is appended to f.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const tokenFile = arg("--connection-token-file");
const token = fs.readFileSync(tokenFile, "utf8").trim();
const mode = process.env.FAKE_CODE_MODE;

if (process.env.FAKE_CODE_PIDFILE) fs.appendFileSync(process.env.FAKE_CODE_PIDFILE, `${process.pid}\n`);

// Lifetime cap: after FAKE_CODE_MAX_LIFETIME_S seconds (default 600; a value that is not a positive number means 600, so the cap
// cannot be switched off) this server ends itself and everything it started. fake-code.sh enforces the same cap, but its
// watchdog dies with a wrapper that is killed alone (a test that orphans the server on purpose), so the server has its own, and
// a server started directly with `node` (chrome-hiding.test.ts does) is covered too. Only pids found by walking the descendants
// of this process, and the `setsid` pids this server wrote to FAKE_CODE_PIDFILE that were re-parented to init and are still a
// `sleep`, are signalled: never a process found by name.
const psRows = (psArgs) => {
  const out = spawnSync("ps", psArgs, { encoding: "utf8" });
  return out.status === 0 ? out.stdout.split("\n").map((l) => l.trim().split(/\s+/)).filter((r) => r[0]) : [];
};
function descendantsOfSelf() {
  const rows = psRows(["-A", "-o", "pid=,ppid="]);
  const found = [];
  let level = [String(process.pid)];
  while (level.length && found.length < 10000) {
    level = rows.filter((r) => level.includes(r[1])).map((r) => r[0]).filter((p) => !found.includes(p));
    found.push(...level);
  }
  return found.map(Number);
}
function endEverything() {
  const victims = new Set();
  // Stop each process before signalling it and repeat until the walk finds nothing new: a stopped shell starts no new child,
  // so a shell that ignores SIGTERM and keeps starting `sleep` leaves nothing behind.
  for (let round = 0; round < 6; round++) {
    const fresh = descendantsOfSelf().filter((p) => !victims.has(p));
    if (!fresh.length) break;
    for (const p of fresh) {
      victims.add(p);
      try { process.kill(p, "SIGSTOP"); } catch { /* already gone */ }
    }
  }
  if (process.env.FAKE_CODE_PIDFILE) {
    let lines = [];
    try { lines = fs.readFileSync(process.env.FAKE_CODE_PIDFILE, "utf8").split("\n"); } catch { /* no file */ }
    for (const line of lines) {
      const m = /^setsid (\d+)$/.exec(line.trim());
      if (!m) continue;
      const [row] = psRows(["-o", "ppid=,comm=", "-p", m[1]]);
      if (row && row[0] === "1" && path.basename(row.slice(1).join(" ")) === "sleep") victims.add(Number(m[1]));
    }
  }
  for (const p of victims) {
    try { process.kill(p, "SIGKILL"); } catch { /* already gone */ }
  }
  process.exit(0);
}
const maxLifetimeS = Number(process.env.FAKE_CODE_MAX_LIFETIME_S || 600);
const capMs = Math.min((Number.isFinite(maxLifetimeS) && maxLifetimeS > 0 ? maxLifetimeS : 600) * 1000, 2 ** 31 - 1);
setTimeout(endEverything, capMs).unref();

// The reaper: what is left when the test process (the owner) dies after the wrapper and this server are already gone. A stop()
// in progress is such a time (the wrapper and the server end first; a shell that ignores SIGTERM and the deliberate `setsid`
// survivor outlive them until the test's own cleanup), and a run that is SIGKILLed then runs no cleanup. Neither the wrapper's
// watchdog (it dies with the wrapper) nor this server's cap (it died with the server) is left to end them. So the extras get a
// watcher of their own: a node process started detached AND re-parented to init (a shell that starts it and exits at once), so
// that a tree walk from the server or the wrapper cannot reach it and a stop() cannot end it before it has done its job. It
// holds the start time of each extra (and of everything that starts under one) and ends all of them, stopped first and then
// killed, when the owner is gone (or is a zombie, or its pid is reused) or at the lifetime cap. When every one of them has
// ended on its own it signals nothing and just leaves. Only pids it saw start under the extras are signalled, never a process
// found by name. It runs the source of the function below with `node -e`, so this file stays the only one needed.
// Argument order: cap in seconds, owner pid (empty: no owner known, so only the cap and the extras' own end count), the
// server's temp dir (only so that a command line shows whose it is), then the extras' pids.
function reaperMain() {
  const { spawnSync } = require("node:child_process");
  const [capSeconds, ownerArg, , ...targetArgs] = process.argv.slice(1);
  const began = Date.now();
  const known = new Map();
  let ownerStart;
  let firstTick = true;
  const table = () => {
    const out = spawnSync("ps", ["-A", "-o", "pid=,ppid=,stat=,lstart="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (out.status !== 0) return null;
    const rows = new Map();
    for (const line of out.stdout.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*\S)\s*$/.exec(line);
      if (m) rows.set(m[1], { ppid: m[2], stat: m[3], start: m[4] });
    }
    return rows;
  };
  const live = (rows, pid) => {
    const r = rows.get(pid);
    return r !== undefined && !r.stat.startsWith("Z") && r.start === known.get(pid);
  };
  const absorb = (rows) => {
    for (let again = true; again; ) {
      again = false;
      for (const [pid, r] of rows) {
        if (!known.has(pid) && !r.stat.startsWith("Z") && live(rows, r.ppid)) {
          known.set(pid, r.start);
          again = true;
        }
      }
    }
  };
  const signal = (pid, sig) => {
    try {
      process.kill(Number(pid), sig);
    } catch (e) {
      /* already gone */
    }
  };
  const endAll = () => {
    const stopped = new Set();
    for (let round = 0; round < 6; round++) {
      const rows = table();
      if (!rows) break;
      absorb(rows);
      const fresh = [...known.keys()].filter((p) => live(rows, p) && !stopped.has(p));
      if (!fresh.length) break;
      for (const p of fresh) {
        stopped.add(p);
        signal(p, "SIGSTOP");
      }
    }
    const rows = table();
    for (const p of known.keys()) if (rows ? live(rows, p) : stopped.has(p)) signal(p, "SIGKILL");
  };
  const tick = () => {
    const rows = table();
    if (!rows) return;
    if (firstTick) {
      firstTick = false;
      for (const p of targetArgs) if (rows.has(p)) known.set(p, rows.get(p).start);
      ownerStart = ownerArg ? (rows.get(ownerArg) || {}).start : undefined;
    }
    for (const p of [...known.keys()]) if (!live(rows, p)) known.delete(p);
    absorb(rows);
    if (known.size === 0) process.exit(0);
    const owner = rows.get(ownerArg);
    const ownerGone = ownerArg !== "" && !(owner && !owner.stat.startsWith("Z") && owner.start === ownerStart);
    if (ownerGone || Date.now() - began >= Number(capSeconds) * 1000) {
      endAll();
      process.exit(0);
    }
  };
  const safeTick = () => {
    try {
      tick();
    } catch (e) {
      /* try again next time */
    }
  };
  safeTick();
  setInterval(safeTick, 1000);
}
// The test process that started this fake: the wrapper's parent when the wrapper started it, else this server's own parent
// (the test, when it runs this file with node directly). Read once, to know whom to wait for: this server never exits because
// of it. Empty when it cannot be told (a parent that is init, or `ps` failing), and then no owner is waited for.
function ownerOfServer() {
  const [mine] = psRows(["-o", "ppid=", "-p", String(process.pid)]);
  const parent = mine?.[0];
  if (!parent || parent === "0" || parent === "1") return "";
  const [row] = psRows(["-ww", "-o", "ppid=,command=", "-p", parent]);
  if (!row) return "";
  const owner = row.slice(1).join(" ").includes("fake-code.sh") ? row[0] : parent;
  return owner === "0" || owner === "1" ? "" : owner;
}
const extraPids = [];
function startReaper() {
  if (!extraPids.length) return;
  const source = `(${reaperMain.toString()})()`.replace(/\s*\n\s*/g, " ");
  // `sh` starts it in the background and exits, which re-parents it to init; nohup, so it also ignores a hangup.
  spawn("sh", ["-c", 'nohup "$@" >/dev/null 2>&1 &', "sh", process.execPath, "-e", source, String(capMs / 1000), ownerOfServer(), marker, ...extraPids.map(String)], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

// What a sweep needs to find the leader of an extra whose command line shows nothing else: the server's temp dir (the directory
// of its token file) as a trailing shell comment. It is the directory, not the token file, so these command lines still carry
// neither the token-file path nor "serve-web".
const marker = path.dirname(tokenFile).replace(/[\r\n]+/g, " ");
if (process.env.FAKE_CODE_SHELLS) {
  const kinds = (process.env.FAKE_CODE_SHELL_KINDS || "sleep").split(",");
  const commands = {
    sleep: ["sleep", ["600"]],
    fg: ["sh", ["-c", "sleep 600; true"]],
    ignore: ["sh", ["-c", `trap '' TERM HUP; while :; do sleep 600; done # ${marker}`]],
  };
  for (let i = 0; i < Number(process.env.FAKE_CODE_SHELLS); i++) {
    const [cmd, cmdArgs] = commands[kinds[i % kinds.length]];
    const child = spawn(cmd, cmdArgs, { stdio: "ignore" });
    child.unref();
    extraPids.push(child.pid);
    if (process.env.FAKE_CODE_PIDFILE) fs.appendFileSync(process.env.FAKE_CODE_PIDFILE, `shell ${child.pid}\n`);
  }
  // The process that outlives its shell and its server: a background `nohup sleep` of a shell that then exits, in its own session.
  const out = spawnSync("sh", ["-c", "nohup sleep 600 >/dev/null 2>&1 & echo $!"], { encoding: "utf8", detached: true });
  const survivor = Number(out.stdout.trim());
  if (survivor) extraPids.push(survivor);
  if (survivor && process.env.FAKE_CODE_PIDFILE) fs.appendFileSync(process.env.FAKE_CODE_PIDFILE, `setsid ${survivor}\n`);
}
if (process.env.FAKE_CODE_SHELL_PORT) {
  // `; true` keeps the shell alive as the parent (without it, sh -c would exec the last command in place).
  // FAKE_CODE_SHELL_NOHUP_PIDFILE=f: the shell first does `nohup sleep 307 & disown`-style work, so a nohup process is still a child of the
  //   shell (the tree reaches it) and its pid is appended to f. Without it there is no such process.
  const nohupFile = process.env.FAKE_CODE_SHELL_NOHUP_PIDFILE;
  const nohup = nohupFile ? `nohup sleep 307 >/dev/null 2>&1 & echo $! >> '${nohupFile.replace(/'/g, "'\\''")}'; ` : "";
  const shell = spawn("sh", ["-c", `${nohup}python3 -m http.server ${process.env.FAKE_CODE_SHELL_PORT} --bind 127.0.0.1; true # ${marker}`], { detached: true, stdio: "ignore", env: { ...process.env, FAKE_CODE_SHELL_PORT: "", FAKE_CODE_PIDFILE: "", FAKE_CODE_SHELL_NOHUP_PIDFILE: "" } });
  shell.unref();
  extraPids.push(shell.pid);
  if (process.env.FAKE_CODE_SHELL_PIDFILE) fs.appendFileSync(process.env.FAKE_CODE_SHELL_PIDFILE, `${shell.pid}\n`);
}
if (process.env.FAKE_CODE_TERMINAL_PIDFILE) {
  const ptyHost = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-pty-host.mjs");
  const pty = spawn(process.execPath, [ptyHost, "--type=ptyHost"], { detached: true, stdio: "ignore", env: process.env });
  pty.unref();
  extraPids.push(pty.pid);
}
startReaper();
if (process.env.FAKE_CODE_ARGSFILE) fs.writeFileSync(process.env.FAKE_CODE_ARGSFILE, JSON.stringify(args));

if (mode === "exit-early") {
  console.error("Error: could not start");
  console.error(`address already in use (connection tkn=${token})`);
  console.error(`secret ${token} leaked on purpose`);
  process.exit(3);
}
if (mode === "exit-stdout") {
  process.stdout.write("*\r\n* Visual Studio Code Server\r\n*\r\n");
  console.log(`Web UI available at http://127.0.0.1:1?tkn=${token}`);
  console.log("[2026-10-26 11:36:36] error could not bind to 127.0.0.1:1 (os error 48)");
  process.exit(7);
}
if (mode === "exit-plain") {
  console.error("fatal: the fake server broke");
  process.exit(5);
}
// FAKE_CODE_OFFLINE_EXCEPT=<commit>: only a start with `--commit-id <commit>` (a cached build) works offline.
const offlineExcept = process.env.FAKE_CODE_OFFLINE_EXCEPT;
const failingDownload =
  ["offline", "download-500", "download-error-log"].includes(mode) && !(offlineExcept && arg("--commit-id") === offlineExcept);
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const commit = arg("--commit-id") ?? "0".repeat(40);
if (failingDownload && process.env.FAKE_CODE_PARTIAL_DIR) {
  fs.mkdirSync(process.env.FAKE_CODE_PARTIAL_DIR, { recursive: true });
  fs.writeFileSync(process.env.FAKE_CODE_PARTIAL_DIR + "/partial.tmp", "half");
}
if (mode === "hang") {
  setInterval(() => {}, 1000);
} else {
  let downloading = Number(process.env.FAKE_CODE_DOWNLOAD_REQUESTS || 0);
  let slowLogged = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.searchParams.get("tkn") !== token) {
      res.writeHead(403).end();
      return;
    }
    if (failingDownload) {
      if (mode === "download-500") {
        res.writeHead(500).end("An error was encountered downloading the server, please retry: connection failed");
        return;
      }
      console.log(`[${stamp()}] info Downloading server ${commit}`);
      if (mode === "download-error-log") console.log(`[${stamp()}] error Error downloading server: connection failed`);
      res.writeHead(202).end("The latest version of the Visual Studio Code Server is downloading, please wait a moment...");
      return;
    }
    if (downloading > 0) {
      downloading--;
      if (mode === "slow-download" && !slowLogged) {
        slowLogged = true;
        console.log(`[${stamp()}] info Downloading server ${commit}`);
      }
      res.writeHead(202).end("downloading");
      return;
    }
    if (mode === "workbench" || mode === "workbench-renamed") {
      let files = [];
      try {
        const payload = JSON.parse(url.searchParams.get("payload") ?? "[]");
        if (typeof payload?.[0]?.[1] === "string") files = [payload[0][1]];
      } catch {
        // no usable payload: a page with no file
      }
      import("./fake-workbench-page.mjs").then(({ fakeWorkbenchHtml }) => res.writeHead(200, { "content-type": "text/html" }).end(fakeWorkbenchHtml({ renamed: mode === "workbench-renamed", files })));
      return;
    }
    res.writeHead(302, { location: "/" }).end();
  });
  server.listen(Number(arg("--port")), arg("--host"), () => {
    // The real CLI prints a licence banner (CRLF line ends) and this line, which carries the token.
    process.stdout.write("*\r\n* Visual Studio Code Server\r\n*\r\n");
    console.log(`Web UI available at http://${arg("--host")}:${arg("--port")}?tkn=${token}`);
  });
}
