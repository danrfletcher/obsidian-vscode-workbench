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
//   hang         never listen
// FAKE_CODE_DOWNLOAD_REQUESTS=n makes the first n requests answer 202 (server still downloading).
import fs from "node:fs";
import http from "node:http";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const tokenFile = arg("--connection-token-file");
const token = fs.readFileSync(tokenFile, "utf8").trim();
const mode = process.env.FAKE_CODE_MODE;

if (process.env.FAKE_CODE_PIDFILE) fs.appendFileSync(process.env.FAKE_CODE_PIDFILE, `${process.pid}\n`);
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
    res.writeHead(302, { location: "/" }).end();
  });
  server.listen(Number(arg("--port")), arg("--host"), () => {
    // The real CLI prints a licence banner (CRLF line ends) and this line, which carries the token.
    process.stdout.write("*\r\n* Visual Studio Code Server\r\n*\r\n");
    console.log(`Web UI available at http://${arg("--host")}:${arg("--port")}?tkn=${token}`);
  });
}
