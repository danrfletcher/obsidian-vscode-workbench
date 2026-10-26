/**
 * Coexistence (E7, F8): who already owns an extension in Obsidian's view
 * registry. Obsidian lets one view type own an extension; a second claim throws.
 * This plugin never takes an extension from another plugin, never changes
 * another plugin's registration and never touches another plugin's settings: it
 * only reads the registry, and refuses that extension.
 *
 * `app.viewRegistry` is not part of Obsidian's public API. It is read only
 * (`typeByExtension`), every access is guarded, and when it is missing the
 * registration call's own error is the signal instead.
 */

export interface Owner {
  /** The view type that owns the extension. */
  viewType: string;
  /** A name for the notice: the plugin if it is recognised, else the view type. */
  name: string;
  /** Obsidian's own view (images, audio, video, pdf, markdown, canvas, bases). */
  core: boolean;
}

/** Obsidian's own view types that own extensions. */
const CORE_VIEW_TYPES = new Set(["markdown", "canvas", "base", "bases", "image", "audio", "video", "pdf"]);

/** Known plugins, by the shape of their view type. Our own view type must never match another plugin. */
const KNOWN_PLUGINS: Array<{ name: string; match: RegExp }> = [
  { name: "Code Files", match: /^(code-editor|code-files?(-.*)?)$/ },
  { name: "VSCode Editor", match: /^(vscode-editor|vscode-editor-.*)$/ },
  { name: "Code Workbench", match: /^(code-workbench|code-workbench-.*|workbench-code-.*)$/ },
];

export function describeOwner(viewType: string): Owner {
  if (CORE_VIEW_TYPES.has(viewType)) return { viewType, name: "Obsidian", core: true };
  const known = KNOWN_PLUGINS.find((p) => p.match.test(viewType));
  return { viewType, name: known?.name ?? `another plugin (view type "${viewType}")`, core: false };
}

/** The part of Obsidian's (private) view registry this plugin reads. */
export interface ViewRegistryLike {
  typeByExtension?: Record<string, string>;
}

/** The owner of an extension, or null when nobody owns it (or the registry cannot be read). */
export function ownerOfExtension(registry: ViewRegistryLike | null | undefined, extension: string): Owner | null {
  try {
    const type = registry?.typeByExtension?.[extension];
    return typeof type === "string" && type !== "" ? describeOwner(type) : null;
  } catch {
    return null;
  }
}

/** One notice for the extensions one owner keeps. Each extension is named exactly once. */
export function refusalNotice(owner: Owner, extensions: readonly string[]): string {
  const list = extensions.map((e) => `.${e}`).join(", ");
  const one = extensions.length === 1;
  return `VS Code Workbench: ${owner.name} already opens ${list} files, so ${one ? "that extension stays" : "those extensions stay"} with it. Turn that plugin off to open ${one ? "it" : "them"} in Code tabs.`;
}
