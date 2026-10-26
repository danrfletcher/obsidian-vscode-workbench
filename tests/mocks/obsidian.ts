/** Minimal stand-in for the `obsidian` module: just what src/ touches. */
export class Notice {
  static messages: string[] = [];
  constructor(public message: string, _timeout?: number) {
    Notice.messages.push(message);
  }
  static reset(): void {
    Notice.messages = [];
  }
}

export class TFile {
  extension: string;
  constructor(public path: string) {
    this.extension = path.split(".").pop() ?? "";
  }
}

export class FileSystemAdapter {
  constructor(private base: string) {}
  getBasePath(): string {
    return this.base;
  }
}

export class WorkspaceLeaf {
  viewState: { type?: string; state?: unknown } | null = null;
  async setViewState(s: { type: string; state?: unknown }): Promise<void> {
    this.viewState = s;
  }
}

export class ItemView {
  contentEl: any = {};
  constructor(public leaf: WorkspaceLeaf) {}
  async setState(_state: unknown, _result: unknown): Promise<void> {}
}

export type ViewStateResult = Record<string, unknown>;

export interface MockApp {
  vault: { adapter: unknown; configDir: string; getAbstractFileByPath(p: string): unknown };
  workspace: {
    activeFile: TFile | null;
    leaves: WorkspaceLeaf[];
    getActiveFile(): TFile | null;
    getLeaf(kind: string): WorkspaceLeaf;
    revealLeaf(l: WorkspaceLeaf): Promise<void>;
    detachLeavesOfType(t: string): void;
    on(name: string, cb: () => void): { name: string; cb: () => void };
  };
}

export class Plugin {
  static ribbon: Array<{ icon: string; title: string }> = [];
  static commands: Array<{ id: string; name: string; callback: () => void }> = [];
  static views: string[] = [];
  static events: Array<{ name: string; cb: () => void }> = [];
  static reset(): void {
    Plugin.ribbon = [];
    Plugin.commands = [];
    Plugin.views = [];
    Plugin.events = [];
  }

  constructor(public app: MockApp, public manifest: { id: string; dir?: string }) {}
  pluginData: unknown = null;
  async loadData(): Promise<unknown> {
    return this.pluginData;
  }
  addRibbonIcon(icon: string, title: string, _cb: () => void): HTMLElement {
    Plugin.ribbon.push({ icon, title });
    return {} as HTMLElement;
  }
  addCommand(c: { id: string; name: string; callback: () => void }): void {
    Plugin.commands.push(c);
  }
  registerView(type: string, _creator: unknown): void {
    Plugin.views.push(type);
  }
  registerEvent(e: { name: string; cb: () => void }): void {
    Plugin.events.push(e);
  }
  registerDomEvent(_el: unknown, _name: string, _cb: () => void): void {}
}
