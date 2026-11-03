import fs from "node:fs";
import path from "node:path";

/**
 * What the plugin shares since PR-5: the extensions the profile lists. The render checks that use this have no
 * desktop state, so they share every entry of the folder's own `extensions.json`. One copy, so the checks
 * cannot drift apart.
 */
export function listedIn(dir) {
  const file = path.join(dir, "extensions.json");
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8")).map((entry) => ({ id: String(entry.identifier?.id ?? "").toLowerCase(), folder: entry.relativeLocation, entry }));
}
