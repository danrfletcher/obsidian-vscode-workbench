#!/usr/bin/env node
/**
 * The pack for tests/render/container-chrome-check.py (ticket warkworth-42, PR-1, R1): everything the Obsidian container run needs
 * that only the plugin's TypeScript can produce, written as one JSON file. The container has python3 but no node, so this runs on
 * the Mac and the file is copied next to the helper.
 *
 *   node tests/render/chrome-spike-pack.mjs <out.json> [vaultFolderInContainer, default /config/vault]
 *
 * What is in it (same sources as chrome-spike-check.mjs, which measures the same routes in headless Chrome on the host):
 *   scripts  the page-side scripts of the probe (MEASURE, READY, LAYOUT_DUMP, ...) and the trust seed with a placeholder origin
 *   cases    one entry per route of docs/spike-chrome.md (R1 .. R6, R2+R3+R4, the best combination): the browser seed script
 *            the plugin's own `buildBrowserSeedScript` makes for that route's settings, and the route's page script
 * No token, no secret and no address of the machine is written: the origin is the placeholder `http://127.0.0.1:1`, which the
 * helper replaces with the Code tab's real origin.
 */
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BREADCRUMBS_OFF, CLOSE_OTHERS_CHORD, DISABLE_ENTRIES, EDITOR_NOW, LAYOUT_DUMP, LAYOUT_SEED, MEASURE, OTHER, PAGE_CLOSE_SCRIPT, PAGE_CSS_SCRIPT,
  PART_NAMES, READY, TABS_NONE, USER_CLOSE_CHORDS, ZEN,
} from "./chrome-spike-scripts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** A valid origin nobody serves on (port 1); the helper replaces `127.0.0.1:1` with the Code tab's real host and port. */
export const PLACEHOLDER_ORIGIN = "http://127.0.0.1:1";

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

/** Builds the pack. `plugin` holds the bundled settings, paths, chrome-settings and trust-seed modules. */
export function buildPack(plugin, vault = "/config/vault") {
  const { settings, paths, chromeSettings, trustSeed } = plugin;
  const OVERLAY = { ...chromeSettings.legacyChromeSettings() }; // what the plugin wrote in 0.1.0 (the spike's R0 baseline)
  const seedFor = (name, route) => {
    const machine = { ...OVERLAY, "workbench.colorTheme": "Light Modern", ...(route.settings ?? {}) };
    const kb = [...(route.userKeybindings ?? []), ...(route.keybindings ?? [])];
    const copy = { id: `probe-${name}`, settings: {}, keybindingsBase64: kb.length ? b64(JSON.stringify(kb)) : null };
    return settings.buildBrowserSeedScript({ ...settings.BROWSER_APP_SETTINGS, ...machine }, copy);
  };
  const SETTINGS_ALL = { ...TABS_NONE, ...BREADCRUMBS_OFF, ...OTHER };
  const closeKeys = USER_CLOSE_CHORDS.concat([CLOSE_OTHERS_CHORD]);
  const routes = [
    { id: "r0", label: "R0 plugin settings (today)", route: {} },
    { id: "r1", label: "R1 Zen Mode", route: { settings: ZEN, enterZen: true, userKeybindings: [], keybindings: DISABLE_ENTRIES.filter((e) => /toggleZenMode|exitZenMode/.test(e.command)) } },
    { id: "r2", label: "R2 showTabs none", route: { settings: TABS_NONE } },
    { id: "r3", label: "R3 breadcrumbs.enabled false", route: { settings: BREADCRUMBS_OFF } },
    { id: "r4", label: "R4 other settings", route: { settings: OTHER } },
    { id: "r234", label: "R2+R3+R4 settings together", route: { settings: SETTINGS_ALL } },
    { id: "r5-discover", label: "R5 layout state (parts closed with the close chords)", route: { userKeybindings: [], keybindings: USER_CLOSE_CHORDS }, pageScript: PAGE_CLOSE_SCRIPT(false) },
    { id: "r6a", label: "R6a page script: close commands via seeded chords", route: { userKeybindings: [], keybindings: closeKeys }, pageScript: PAGE_CLOSE_SCRIPT(false) },
    { id: "r6b", label: "R6b page script: CSS display none", route: {}, pageScript: PAGE_CSS_SCRIPT },
    // The best combination of docs/spike-chrome.md: all the settings, the close chords (with the chords of Zen disabled) and the
    // watching page script. The saved layout state (R5b) is added by the helper when R5b hid the side bar, as the host probe does.
    { id: "best", label: "best: R2+R3+R4 + R6a with a watcher", route: { settings: SETTINGS_ALL, userKeybindings: [], keybindings: closeKeys.concat(DISABLE_ENTRIES) }, pageScript: PAGE_CLOSE_SCRIPT(true) },
  ];
  const cases = routes.map((r) => ({
    id: r.id,
    label: r.label,
    seed: seedFor(r.id, r.route),
    enterZen: !!r.route.enterZen,
    pageScript: r.pageScript ?? null,
    settingKeys: Object.keys(r.route.settings ?? {}),
  }));
  const trust = trustSeed.buildTrustSeedScript({
    origin: PLACEHOLDER_ORIGIN,
    folderUri: paths.buildFileUri(PLACEHOLDER_ORIGIN, vault),
    heldPorts: [],
  });
  return {
    vault,
    partNames: PART_NAMES,
    scripts: { MEASURE, READY, EDITOR_NOW, LAYOUT_DUMP, LAYOUT_SEED_TEMPLATE: LAYOUT_SEED(null), TRUST: trust },
    cases,
  };
}

/** Bundles the plugin modules the pack needs (the same four the host probe loads) and imports them. */
export async function loadPlugin(work) {
  await build({
    entryPoints: {
      settings: path.join(root, "src/settings.ts"),
      paths: path.join(root, "src/paths.ts"),
      "chrome-settings": path.join(root, "src/chrome-settings.ts"),
      "trust-seed": path.join(root, "src/trust/trust-seed.ts"),
    },
    bundle: true, format: "esm", platform: "node", outdir: work, outExtension: { ".js": ".mjs" }, logLevel: "error",
    alias: { obsidian: path.join(root, "tests/mocks/obsidian.ts") },
  });
  const load = (n) => import(pathToFileURL(path.join(work, `${n}.mjs`)).href);
  return { settings: await load("settings"), paths: await load("paths"), chromeSettings: await load("chrome-settings"), trustSeed: await load("trust-seed") };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: node tests/render/chrome-spike-pack.mjs <out.json> [vault folder in the container]");
    process.exit(2);
  }
  const work = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "chrome-spike-pack-"));
  try {
    const pack = buildPack(await loadPlugin(work), process.argv[3] ?? "/config/vault");
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(pack, null, 2));
    console.log(`wrote ${out}: ${pack.cases.length} cases, ${Object.keys(pack.scripts).length} scripts`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
