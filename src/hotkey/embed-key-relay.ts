/**
 * The host side of the hotkey bridge: takes the action names the workbench page reports (hotkey-bridge.ts) and
 * hands them to the plugin.
 *
 * What it accepts: a message from the server's own origin (`http://127.0.0.1:<port>`) whose shape is exactly
 * `{ v: 1, action }` with a known action name. Anything else (another origin, a missing or unknown action, extra
 * junk, a non-object) is ignored without throwing, and nothing is ever logged: no key, no text, no token.
 *
 * Two channels, one parser:
 *  - a `<webview>` (the shipped embed) reports with a prefixed `console-message`; the origin is the page the
 *    webview is showing (`getURL()`), checked at the moment of the message. The console cannot say which frame
 *    logged a line, so the line must also carry the nonce the host wrote into this load's script; a line from
 *    any other code in the page (an extension webview, say) has none and is ignored;
 *  - an `<iframe>` reports with `postMessage` to the Obsidian window; the origin is the event's own, and the
 *    sender must be one of the frames attached here.
 *
 * Nothing here opens a listener on a socket, loads a script from outside, or sends anything out of the process.
 * The decision constant (E12) is asked when the relay is installed: with `no` nothing is installed, no frame is
 * given a script, and the plugin runs on the strip and the hotkey outside the embed.
 */
import {
  BRIDGE_ACTION_NAMES,
  KEY_MESSAGE_PREFIX,
  buildRelayScript,
  configSignature,
  type BridgeAction,
  type ChordConfig,
} from "./hotkey-bridge";
import { bridgeEnabled, type HotkeyBridgeDecision } from "./decision";

/** `http://127.0.0.1:<port>` of a URL or origin string; null for anything else (another host, another scheme, junk). */
export function loopbackOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || u.port === "") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** The action a message asks for, or null when it is not a well-formed bridge message. */
export function parseKeyMessage(raw: unknown): BridgeAction | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    if (!raw.startsWith(KEY_MESSAGE_PREFIX)) return null;
    try {
      value = JSON.parse(raw.slice(KEY_MESSAGE_PREFIX.length));
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;
  if (m.v !== 1 || typeof m.action !== "string") return null;
  // postMessage carries a marker so unrelated messages on the window are not mistaken for ours.
  if (!(typeof raw === "string") && m.vscw !== 1) return null;
  return (BRIDGE_ACTION_NAMES as readonly string[]).includes(m.action) ? (m.action as BridgeAction) : null;
}

/** A message is taken only from the server's own loopback origin. */
export function acceptKeyMessage(origin: unknown, allowedOrigin: string | null, raw: unknown): BridgeAction | null {
  const from = loopbackOrigin(origin);
  if (!from || !allowedOrigin || from !== loopbackOrigin(allowedOrigin)) return null;
  return parseKeyMessage(raw);
}

/** The part of a `<webview>` / `<iframe>` element the relay uses. */
export interface RelayFrame {
  addEventListener(type: string, cb: (ev: any) => void): void;
  removeEventListener?(type: string, cb: (ev: any) => void): void;
  /** webview: the address of the page now shown. May throw before the first load. */
  getURL?(): string;
  /** webview: run a script in the page. */
  executeJavaScript?(code: string): Promise<unknown>;
  /** iframe: its window, to tell which frame a message came from. */
  contentWindow?: unknown;
  isConnected?: boolean;
  blur?(): void;
  focus?(): void;
}

export interface RelayWindow {
  addEventListener(type: "message", cb: (ev: any) => void): void;
  removeEventListener?(type: "message", cb: (ev: any) => void): void;
}

export interface RelayDeps {
  decision?: () => HotkeyBridgeDecision;
  window: RelayWindow;
  /** The server's address (`http://127.0.0.1:<port>`), or null while none runs. */
  serverOrigin(): string | null;
  /** The chords to watch for now (read from Obsidian's hotkey settings). */
  chords(): ChordConfig;
  /** A bridged action arrived from `frame`. Errors thrown here are contained. */
  onAction(action: BridgeAction, frame: RelayFrame): void;
}

interface Attached {
  frame: RelayFrame;
  /** Signature of the chord list last given to the page; null until a script has been run. */
  pushed: string | null;
  /** Secret of the current page load, written into its script; null until the page is given one (R6). */
  nonce: string | null;
  off: () => void;
}

/** A fresh unguessable token for one page load. */
function newNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The `n` of a console line from the page script, or null when the line has none. */
function lineNonce(message: string): string | null {
  try {
    const n = (JSON.parse(message.slice(KEY_MESSAGE_PREFIX.length)) as { n?: unknown } | null)?.n;
    return typeof n === "string" ? n : null;
  } catch {
    return null;
  }
}

export class EmbedKeyRelay {
  private installed = false;
  private readonly frames = new Set<Attached>();
  private readonly onWindowMessage = (ev: { origin?: unknown; data?: unknown; source?: unknown }) => {
    const from = [...this.frames].find((a) => a.frame.contentWindow !== undefined && a.frame.contentWindow === ev?.source);
    if (!from) return; // not one of our frames
    this.deliver(ev.origin, ev.data, from.frame);
  };

  constructor(private readonly deps: RelayDeps) {}

  /** The decision allows the relay and it is installed. */
  get active(): boolean {
    return this.installed;
  }

  /** How many frames are being watched. */
  get attachedCount(): number {
    return this.frames.size;
  }

  /** Install per the recorded decision. Returns whether the relay is active; with `no` nothing is installed. */
  install(): boolean {
    if (this.installed) return true;
    if (!bridgeEnabled(this.deps.decision?.())) return false;
    this.deps.window.addEventListener("message", this.onWindowMessage);
    this.installed = true;
    return true;
  }

  /**
   * Watch one Code tab's frame: give its page the chord script on every load (a reload or a server restart
   * starts a fresh page, so the script is written again) and listen for what it reports. Returns the function
   * that stops watching. Does nothing, and gives nothing to the page, when the relay is not installed.
   */
  attach(frame: RelayFrame): () => void {
    if (!this.installed) return () => undefined;
    const entry: Attached = { frame, pushed: null, nonce: null, off: () => undefined };
    const onReady = () => {
      entry.pushed = null; // a new page has no script yet
      entry.nonce = null; // and gets its own secret
      this.push(entry);
    };
    const onConsole = (ev: { message?: unknown }) => {
      const message = ev?.message;
      if (typeof message !== "string" || !message.startsWith(KEY_MESSAGE_PREFIX)) return; // cheap exit for the page's other logging
      // Any code in the page can log a line with our prefix; only the script we wrote knows this load's nonce (R6).
      if (entry.nonce === null || lineNonce(message) !== entry.nonce) return;
      this.deliver(this.originOf(frame), message, frame);
    };
    frame.addEventListener("dom-ready", onReady);
    frame.addEventListener("console-message", onConsole);
    entry.off = () => {
      frame.removeEventListener?.("dom-ready", onReady);
      frame.removeEventListener?.("console-message", onConsole);
      this.frames.delete(entry);
    };
    this.frames.add(entry);
    return entry.off;
  }

  /** Give every watched page the current chords if they changed since it last got them (a rebinding). */
  sync(): void {
    if (!this.installed) return;
    for (const a of [...this.frames]) {
      if (a.frame.isConnected === false) {
        a.off(); // its tab is gone
        continue;
      }
      this.push(a);
    }
  }

  dispose(): void {
    if (this.installed) this.deps.window.removeEventListener?.("message", this.onWindowMessage);
    this.installed = false;
    for (const a of [...this.frames]) a.off();
  }

  /** Accept or ignore one message: the one entry point for both channels. */
  deliver(origin: unknown, raw: unknown, frame: RelayFrame): BridgeAction | null {
    if (!this.installed) return null;
    const action = acceptKeyMessage(origin, this.deps.serverOrigin(), raw);
    if (!action) return null;
    try {
      this.deps.onAction(action, frame);
    } catch {
      /* a failing action never breaks the page's key handling; nothing is logged (no key content) */
    }
    return action;
  }

  private originOf(frame: RelayFrame): string | null {
    try {
      return loopbackOrigin(frame.getURL?.());
    } catch {
      return null; // no page has loaded yet
    }
  }

  private push(a: Attached): void {
    const run = a.frame.executeJavaScript;
    if (typeof run !== "function") return; // an iframe cannot be scripted from here
    // Not before the page is up: a webview that has not fired dom-ready rejects. getURL throws until then.
    if (this.originOf(a.frame) === null) return;
    let config: ChordConfig;
    try {
      config = this.deps.chords();
    } catch {
      return;
    }
    const signature = configSignature(config);
    if (a.pushed === signature) return;
    a.pushed = signature;
    // One secret per page load: a re-push to the same page (a rebinding) reuses it, because the page keeps the first.
    if (a.nonce === null) a.nonce = newNonce();
    try {
      run.call(a.frame, buildRelayScript(config, a.nonce)).catch(() => {
        if (a.pushed === signature) a.pushed = null; // try again on the next sync
      });
    } catch {
      a.pushed = null;
    }
  }
}
