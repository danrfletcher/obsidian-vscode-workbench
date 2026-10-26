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
  detached = false;
  async setViewState(s: { type: string; state?: unknown }): Promise<void> {
    this.viewState = s;
  }
  detach(): void {
    this.detached = true;
  }
}

/** A tiny DOM node: enough for the modals and the settings tab to be driven in tests. */
export class FakeNode {
  children: FakeNode[] = [];
  text = "";
  cls?: string;
  disabled = false;
  style: Record<string, string> = {};
  private listeners: Record<string, Array<() => void>> = {};
  constructor(public tag: string) {}
  createEl(tag: string, o: { text?: string; cls?: string } = {}): FakeNode {
    const n = new FakeNode(tag);
    n.text = o.text ?? "";
    n.cls = o.cls;
    this.children.push(n);
    return n;
  }
  createDiv(o: { text?: string; cls?: string } = {}): FakeNode {
    return this.createEl("div", o);
  }
  removed = false;
  remove(): void {
    this.removed = true;
  }
  empty(): void {
    this.children = [];
  }
  addEventListener(name: string, fn: () => void): void {
    (this.listeners[name] ??= []).push(fn);
  }
  click(): void {
    for (const fn of this.listeners.click ?? []) fn();
  }
  /** Every node below this one, depth first. */
  all(): FakeNode[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  buttons(): FakeNode[] {
    return this.all().filter((n) => n.tag === "button");
  }
  /** All text below this node, joined. */
  textContent(): string {
    return [this.text, ...this.children.map((c) => c.textContent())].filter(Boolean).join("\n");
  }
}

export class Modal {
  static opened: Modal[] = [];
  static reset(): void {
    Modal.opened = [];
  }
  contentEl = new FakeNode("div");
  closed = false;
  constructor(public app: unknown) {}
  open(): void {
    Modal.opened.push(this);
    this.onOpen();
  }
  /** Escape and clicking away also end up here. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }
  onOpen(): void {}
  onClose(): void {}
}

export class Setting {
  static all: Setting[] = [];
  static reset(): void {
    Setting.all = [];
  }
  name = "";
  desc = "";
  button: { text: string; disabled: boolean; handler: (() => unknown) | null } | null = null;
  constructor(public containerEl: unknown) {
    Setting.all.push(this);
  }
  setName(n: string): this {
    this.name = n;
    return this;
  }
  setDesc(d: string): this {
    this.desc = d;
    return this;
  }
  addButton(cb: (b: unknown) => unknown): this {
    const b = {
      text: "",
      disabled: false,
      handler: null as (() => unknown) | null,
      setButtonText(t: string) {
        b.text = t;
        return b;
      },
      setDisabled(v: boolean) {
        b.disabled = v;
        return b;
      },
      onClick(fn: () => unknown) {
        b.handler = fn;
        return b;
      },
    };
    cb(b);
    this.button = b;
    return this;
  }
}

export class PluginSettingTab {
  containerEl = new FakeNode("div");
  constructor(public app: unknown, public plugin: unknown) {}
}

export class Tasks {
  fns: Array<() => Promise<unknown>> = [];
  add(fn: () => Promise<unknown>): void {
    this.fns.push(fn);
  }
  async runAll(): Promise<void> {
    await Promise.all(this.fns.map((f) => f()));
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
    on(name: string, cb: (...args: any[]) => void): { name: string; cb: (...args: any[]) => void };
  };
}

export class Plugin {
  static ribbon: Array<{ icon: string; title: string }> = [];
  static commands: Array<{ id: string; name: string; callback: () => void }> = [];
  static views: string[] = [];
  static events: Array<{ name: string; cb: (...args: any[]) => void }> = [];
  static settingTabs: unknown[] = [];
  static reset(): void {
    Plugin.ribbon = [];
    Plugin.commands = [];
    Plugin.views = [];
    Plugin.events = [];
    Plugin.settingTabs = [];
  }

  constructor(public app: MockApp, public manifest: { id: string; dir?: string }) {}
  pluginData: unknown = null;
  async loadData(): Promise<unknown> {
    return this.pluginData;
  }
  /** Like the real one: what is saved is what the next loadData returns (a JSON round trip, as data.json is). */
  async saveData(data: unknown): Promise<void> {
    this.pluginData = JSON.parse(JSON.stringify(data));
  }
  addSettingTab(tab: unknown): void {
    Plugin.settingTabs.push(tab);
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
  registerEvent(e: { name: string; cb: (...args: any[]) => void }): void {
    Plugin.events.push(e);
  }
  registerDomEvent(el: unknown, name: string, cb: () => void): void {
    (el as { addEventListener?: (n: string, f: () => void) => void } | null)?.addEventListener?.(name, cb);
  }
}
