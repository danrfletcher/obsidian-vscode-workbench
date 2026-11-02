/**
 * The "New terminal at folder" entry of Obsidian's file explorer menu (G8). The only thing the plugin draws for this feature is
 * this menu item (F1). Obsidian-free (duck-typed), so the rules are tested with a fake menu.
 *
 *  - Only the file explorer's own right-click menu: the `file-menu` event also fires for the tab header, the editor's "more options"
 *    and link menus, whose `source` is something else.
 *  - One folder only: this is the single-item `file-menu`. A multi-selection fires `files-menu`, which nothing here listens to.
 *  - A folder acts on itself, a file on its parent folder, and the vault root is the folder `""`.
 */

export const NEW_TERMINAL_TITLE = "New terminal at folder";
export const NEW_TERMINAL_ICON = "terminal";
/** The `source` Obsidian gives `file-menu` for a right-click in the file explorer. */
export const FILE_EXPLORER_SOURCE = "file-explorer-context-menu";

/** The part of a `TAbstractFile` this reads. A `TFolder` has `isRoot`; a `TFile` has a `parent` folder. */
export interface MenuTarget {
  path: string;
  isRoot?: () => boolean;
  parent?: MenuTarget | null;
}

export interface MenuItemLike {
  setTitle(title: string): MenuItemLike;
  setIcon(icon: string): MenuItemLike;
  onClick(callback: () => unknown): MenuItemLike;
}

export interface MenuLike {
  addItem(callback: (item: MenuItemLike) => unknown): unknown;
}

/** The folder the item acts on, as a vault path (`""` for the vault root). */
export function folderPathOf(target: MenuTarget): string {
  const folder = typeof target.isRoot === "function" ? target : (target.parent ?? null);
  if (!folder) return "";
  if (typeof folder.isRoot === "function" && folder.isRoot()) return "";
  return folder.path === "/" ? "" : folder.path;
}

/**
 * Add the item when the menu is the file explorer's. `open` gets the folder's vault path when the item is chosen; what it returns
 * is handed back to the menu's click (a promise Obsidian ignores and a test can wait for).
 * Returns whether the item was added.
 */
export function addNewTerminalItem(menu: MenuLike, target: MenuTarget, source: string, open: (folder: string) => unknown): boolean {
  if (source !== FILE_EXPLORER_SOURCE) return false;
  // Read when the menu is built: a folder renamed or deleted afterwards is the opener's business (it falls back to the vault root).
  const folder = folderPathOf(target);
  menu.addItem((item) => item.setTitle(NEW_TERMINAL_TITLE).setIcon(NEW_TERMINAL_ICON).onClick(() => open(folder)));
  return true;
}
