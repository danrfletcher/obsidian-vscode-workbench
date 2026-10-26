import esbuild from "esbuild";
import { builtinModules } from "node:module";
import * as fs from "node:fs";

const production = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  format: "cjs",
  target: "es2022",
  platform: "node",
  loader: { ".py": "text" },
  logLevel: "info",
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  outfile: "main.js",
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}

// styles.css is what Obsidian loads: xterm's own stylesheet, then the plugin's.
fs.writeFileSync("styles.css", `${fs.readFileSync("node_modules/@xterm/xterm/css/xterm.css", "utf8")}\n${fs.readFileSync("src/styles.css", "utf8")}`);
