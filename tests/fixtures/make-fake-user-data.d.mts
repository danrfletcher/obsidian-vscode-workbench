export const DEFAULT_LOCATION: string;
export const PROFILES: {
  custom: { name: string; location: string };
  agents: { name: string; location: string; useDefaultFlags: { settings: boolean; keybindings: boolean } };
  deleted: { name: string; location: string };
};
export const BUILD_FOLDERS: string[];
export function vscodeFolderUri(folder: string): string;
export function writeUserData(userDataRoot: string, opts?: { associations?: Record<string, string>; label?: string }): string;
export function makeFakeUserData(
  appSupport: string,
  opts?: { associations?: Record<string, string>; folders?: string[] },
): { appSupport: string; roots: Record<string, string> };
