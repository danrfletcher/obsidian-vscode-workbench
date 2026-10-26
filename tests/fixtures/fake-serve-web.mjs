// Stand-in for the `code serve-web` server. Behaviour is chosen with FAKE_CODE_MODE:
//   (unset)      listen on --host/--port, token from --connection-token-file
//   exit-early   print an error to stderr (which contains the token) and exit 3
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
if (mode === "hang") {
  setInterval(() => {}, 1000);
} else {
  let downloading = Number(process.env.FAKE_CODE_DOWNLOAD_REQUESTS || 0);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.searchParams.get("tkn") !== token) {
      res.writeHead(403).end();
      return;
    }
    if (downloading > 0) {
      downloading--;
      res.writeHead(202).end("downloading");
      return;
    }
    res.writeHead(302, { location: "/" }).end();
  });
  server.listen(Number(arg("--port")), arg("--host"), () => {
    console.log(`Web UI available at http://${arg("--host")}:${arg("--port")}?tkn=${token}`);
  });
}
