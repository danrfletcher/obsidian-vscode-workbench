/**
 * The drawer's height and open state, kept per device in the plugin's `data.json`
 * (G9). `data.json` can sync between machines, so the state sits under a device id
 * that is generated once per device and kept in this device's own local storage,
 * never in `data.json`. Everything read from the file is untrusted: a missing,
 * corrupt or out-of-range value falls back to the default and is clamped.
 */
import { randomUUID } from "node:crypto";
import { DEFAULT_HEIGHT, clampHeight } from "./drawer-geometry";

export interface DrawerState {
  height: number;
  open: boolean;
}

/** The key in `data.json` that holds `{ [deviceId]: { height, open } }`. */
export const DRAWER_KEY = "drawer";
/** The key under which a device keeps its own id in Obsidian's per-device local storage. */
export const DEVICE_ID_KEY = "obsidian-vscode-workbench:device-id";

const DEVICE_ID = /^[A-Za-z0-9-]{8,64}$/;

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The state this device stored, clamped to a window `windowHeight` px high. An unknown device gets the default (closed). */
export function readDrawerState(data: unknown, deviceId: string, windowHeight: number): DrawerState {
  const all = isObject(data) ? data[DRAWER_KEY] : undefined;
  const mine = isObject(all) && has(all, deviceId) ? all[deviceId] : undefined;
  const raw = isObject(mine) ? mine : {};
  const height = typeof raw.height === "number" && Number.isFinite(raw.height) && raw.height > 0 ? raw.height : DEFAULT_HEIGHT;
  return { height: clampHeight(height, windowHeight), open: raw.open === true };
}

/** `data` with this device's state replaced and every other device's kept. Does not modify `data`. */
export function withDrawerState(data: Record<string, unknown>, deviceId: string, state: DrawerState): Record<string, unknown> {
  const all = isObject(data[DRAWER_KEY]) ? (data[DRAWER_KEY] as Record<string, unknown>) : {};
  return { ...data, [DRAWER_KEY]: { ...all, [deviceId]: { height: state.height, open: state.open } } };
}

/** Where this device keeps its id (Obsidian's `loadLocalStorage` / `saveLocalStorage`). */
export interface DeviceIdStore {
  get(): unknown;
  set(id: string): void;
}

/** This device's id: the stored one if it is well formed, else a new one that is stored. */
export function deviceId(store: DeviceIdStore, make: () => string = randomUUID): string {
  const existing = store.get();
  if (typeof existing === "string" && DEVICE_ID.test(existing)) return existing;
  const id = make();
  try {
    store.set(id);
  } catch {
    /* the id then lasts until the plugin reloads */
  }
  return id;
}
