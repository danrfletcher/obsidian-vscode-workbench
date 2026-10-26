/**
 * The recorded spike decision for the hotkey bridge (E12), as the plugin reads it at runtime.
 *
 * `docs/spike-decision.md` records the same value in its header key `hotkey_bridge` (a test keeps the two
 * equal). `yes` installs the key relay in every Code tab; `no` installs nothing and the plugin falls back to the
 * strip and to the hotkey outside the embed. Nothing else in the plugin hard-codes either answer: the relay
 * asks `bridgeEnabled()`, and tests pass the other value in to cover the fallback.
 */
export type HotkeyBridgeDecision = "yes" | "no";

export const HOTKEY_BRIDGE: HotkeyBridgeDecision = "yes";

export function bridgeEnabled(decision: HotkeyBridgeDecision = HOTKEY_BRIDGE): boolean {
  return decision === "yes";
}
