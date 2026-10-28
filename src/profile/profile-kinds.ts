/**
 * The kinds of file a VS Code profile keeps, as the mirror reads them. In its own module so the settings section
 * can use the list without pulling in the file-system code of `mirrored-profile.ts`.
 */
export const PROFILE_KINDS = ["extensions", "settings", "keybindings"] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];
