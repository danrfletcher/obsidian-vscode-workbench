/**
 * Registers vault extensions against the Code tab view type (G7's counterpart
 * for files that have an extension). Rules:
 *
 *  - `md`, `canvas`, `base`, binaries and excluded extensions are never passed
 *    to the registration call, whatever the scan finds (F6);
 *  - an extension another plugin already owns is refused for that extension
 *    only, with one notice per extension per session naming the owner (E7, F8);
 *  - each extension is registered on its own inside a guard, so one that throws
 *    can neither stop the rest nor leave a half-registered set;
 *  - nothing here unregisters or edits anyone else's registration.
 */
import { refusalNotice, type Owner } from "./coexistence";
import { isRegistrable } from "./text-file-rules";

export interface RegistryHost {
  /** Obsidian's `Plugin.registerExtensions`. Throws when the extension is already owned. */
  registerExtensions(extensions: string[], viewType: string): void;
  /** Who owns this extension right now (read-only lookup), or null. */
  ownerOf(extension: string): Owner | null;
  notice(message: string): void;
  log(message: string, ...args: unknown[]): void;
}

export interface RegisterOutcome {
  /** Newly registered in this call. */
  registered: string[];
  /** Refused because another plugin owns them: extension, owner name. */
  refused: Array<{ extension: string; owner: string }>;
  /** Skipped without a notice: Obsidian's own views, and extensions this plugin never registers. */
  ignored: string[];
}

export class ExtensionRegistry {
  private readonly ours = new Set<string>();
  private readonly refused = new Map<string, Owner>();
  private readonly ignoredCore = new Set<string>();
  private readonly noticed = new Set<string>();

  constructor(
    private readonly host: RegistryHost,
    private readonly viewType: string,
  ) {}

  /** Every extension this plugin has registered, sorted. */
  get registered(): string[] {
    return [...this.ours].sort();
  }

  /** True when this extension needs no further work (registered, refused or Obsidian's own). */
  isSettled(extension: string): boolean {
    return this.ours.has(extension) || this.refused.has(extension) || this.ignoredCore.has(extension);
  }

  register(extensions: Iterable<string>, excluded: readonly string[] = []): RegisterOutcome {
    const outcome: RegisterOutcome = { registered: [], refused: [], ignored: [] };
    const toNotice = new Map<string, { owner: Owner; extensions: string[] }>();

    for (const raw of new Set([...extensions].map((e) => e.toLowerCase()))) {
      if (!isRegistrable(raw, excluded)) {
        outcome.ignored.push(raw);
        continue;
      }
      if (this.ours.has(raw) || this.ignoredCore.has(raw)) continue;

      const owner = this.lookup(raw);
      if (owner) {
        this.refuse(raw, owner, outcome, toNotice);
        continue;
      }
      try {
        this.host.registerExtensions([raw], this.viewType);
        this.ours.add(raw);
        this.refused.delete(raw);
        outcome.registered.push(raw);
      } catch (e) {
        // Someone registered it between the lookup and the call, or the lookup could not see the owner.
        const late = this.lookup(raw) ?? { viewType: "", name: "another plugin", core: false };
        this.host.log(`VS Code Workbench: could not register .${raw}:`, e instanceof Error ? e.message : e);
        this.refuse(raw, late, outcome, toNotice);
      }
    }

    for (const { owner, extensions: list } of toNotice.values()) this.host.notice(refusalNotice(owner, list));
    return outcome;
  }

  private lookup(extension: string): Owner | null {
    const owner = this.host.ownerOf(extension);
    if (owner?.viewType === this.viewType) return null; // already ours (a reload that kept the registration)
    return owner;
  }

  private refuse(
    extension: string,
    owner: Owner,
    outcome: RegisterOutcome,
    toNotice: Map<string, { owner: Owner; extensions: string[] }>,
  ): void {
    if (owner.core) {
      // Obsidian's own viewer (svg, say): not a plugin clash, and not something to take over or to nag about.
      this.ignoredCore.add(extension);
      outcome.ignored.push(extension);
      this.host.log(`VS Code Workbench: .${extension} is opened by Obsidian itself (${owner.viewType}); left alone.`);
      return;
    }
    this.refused.set(extension, owner);
    outcome.refused.push({ extension, owner: owner.name });
    if (this.noticed.has(extension)) return; // once per extension per session
    this.noticed.add(extension);
    const group = toNotice.get(owner.name) ?? { owner, extensions: [] };
    group.extensions.push(extension);
    toNotice.set(owner.name, group);
  }
}
