/**
 * Builds a fake Application Support root for the mirrored-profile tests, in the shape desktop VS Code writes it:
 *
 *   <appSupport>/<user-data name>/User/settings.json, keybindings.json          the Default profile
 *   <appSupport>/<user-data name>/User/globalStorage/storage.json                profiles and which folder uses which
 *   <appSupport>/<user-data name>/User/profiles/<location>/                      one folder per profile with its own files
 *
 * Profiles in `storage.json` (`userDataProfiles`):
 *   FDE Practice   a custom profile, location 5c6b7f1e, with its own extensions.json, settings.json, keybindings.json
 *   Agents         a built-in style profile, location agents-7a2d, useDefaultFlags { settings, keybindings } (so it reads
 *                  Default's settings and keybindings), with its own extensions.json
 *   Old Profile    listed, but its folder under User/profiles/ is gone (a deleted profile)
 *
 * The settings files carry different `editor.fontSize` values (Default 14, FDE Practice 22), one different keybinding each
 * (`TOGGLE_SIDEBAR_KEY` in Default's, `TOGGLE_PANEL_KEY` in FDE Practice's) and `security.workspace.trust.*` keys
 * (`TRUST_KEYS`), so PR-6 tests can tell whose file reached the tab and that the trust keys did not.
 *
 * The files are generated, never mocked: the real `fs` reads them. Nothing is written outside `appSupport`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_LOCATION = "__default__profile__";

export const PROFILES = {
  custom: { name: "FDE Practice", location: "5c6b7f1e" },
  agents: { name: "Agents", location: "agents-7a2d", useDefaultFlags: { settings: true, keybindings: true } },
  deleted: { name: "Old Profile", location: "d3adbeef" },
};

/** `security.workspace.trust.*` settings both fixtures' settings.json carry (G12): none may reach the tab. */
export const TRUST_KEYS = {
  "security.workspace.trust.enabled": false,
  "security.workspace.trust.startupPrompt": "never",
  "security.workspace.trust.banner": "never",
  "security.workspace.trust.untrustedFiles": "open",
  "security.workspace.trust.emptyWindow": true,
};

/** The one keybinding each fixture profile has (G13): they differ in key and command. */
export const TOGGLE_SIDEBAR_KEY = { key: "ctrl+alt+n", command: "workbench.action.toggleSidebarVisibility" };
export const TOGGLE_PANEL_KEY = { key: "ctrl+alt+m", command: "workbench.action.togglePanel" };

/** The user-data folder names of the known builds (KNOWN_BUILDS in src/instances/scan.ts). */
export const BUILD_FOLDERS = ["Code", "Code - Insiders", "VSCodium", "Antigravity", "Antigravity IDE"];

/** A folder as VS Code writes it into `storage.json`: `file://` and the path with each segment percent-encoded. */
export function vscodeFolderUri(folder) {
  return `file://${folder.split("/").map((s) => encodeURIComponent(s)).join("/")}`;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/**
 * One user-data folder. `associations` maps a folder URI (as it is written in `storage.json`) to a profile
 * location. `label` is written into the files so a test can tell whose file it read.
 */
export function writeUserData(userDataRoot, { associations = {}, label = path.basename(userDataRoot) } = {}) {
  const user = path.join(userDataRoot, "User");
  const settings = (fontSize, who) => `// ${who}\n${JSON.stringify({ "editor.fontSize": fontSize, fixture: `${label} ${who}`, ...TRUST_KEYS }, null, 2).replace(/\n}$/, ",\n}")}\n`;
  const keybindings = (k) => `// ${k.command}\n[\n  ${JSON.stringify(k)},\n]\n`;
  write(path.join(user, "settings.json"), settings(14, "default"));
  write(path.join(user, "keybindings.json"), keybindings(TOGGLE_SIDEBAR_KEY));
  const profiles = Object.values(PROFILES).map((p) => ({ name: p.name, location: p.location, ...(p.useDefaultFlags ? { useDefaultFlags: p.useDefaultFlags } : {}) }));
  write(
    path.join(user, "globalStorage", "storage.json"),
    JSON.stringify({ userDataProfiles: profiles, profileAssociations: { workspaces: associations, emptyWindows: {} } }, null, 2) + "\n",
  );
  for (const p of [PROFILES.custom, PROFILES.agents]) {
    const dir = path.join(user, "profiles", p.location);
    write(path.join(dir, "extensions.json"), `[]\n`);
    if (p !== PROFILES.agents) {
      write(path.join(dir, "settings.json"), settings(22, p.name));
      write(path.join(dir, "keybindings.json"), keybindings(TOGGLE_PANEL_KEY));
    }
  }
  // PROFILES.deleted has no folder.
  return userDataRoot;
}

/**
 * The whole root: a user-data folder for every build in `folders` (default: all known builds), each with the same
 * `associations`. Returns the paths.
 */
export function makeFakeUserData(appSupport, { associations = {}, folders = BUILD_FOLDERS } = {}) {
  fs.mkdirSync(appSupport, { recursive: true });
  const roots = {};
  for (const name of folders) roots[name] = writeUserData(path.join(appSupport, name), { associations, label: name });
  return { appSupport, roots };
}
