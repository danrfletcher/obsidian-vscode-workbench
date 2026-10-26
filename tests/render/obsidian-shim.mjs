/**
 * A browser stand-in for the parts of the `obsidian` module the plugin's Notice and Modal use. It builds the
 * same DOM Obsidian 1.14 builds (checked in its app.js): `div.notice-container > div.notice >
 * div.notice-message`, and `div.modal-container.mod-dim > div.modal-bg + div.modal > (close button,
 * div.modal-header > div.modal-title, div.modal-content)`. Obsidian's own app.css is then applied to it,
 * so the page is laid out the way the app lays it out.
 */
function addHelpers() {
  const proto = HTMLElement.prototype;
  proto.createEl = function (tag, o = {}) {
    const opts = typeof o === "string" ? { cls: o } : o;
    const el = document.createElement(tag);
    if (opts.cls) el.className = Array.isArray(opts.cls) ? opts.cls.join(" ") : opts.cls;
    if (opts.text !== undefined) el.textContent = opts.text;
    this.appendChild(el);
    return el;
  };
  proto.createDiv = function (o = {}) {
    return this.createEl("div", o);
  };
  proto.empty = function () {
    this.replaceChildren();
  };
}
addHelpers();

export class Notice {
  constructor(message, timeout = 4000) {
    let container = document.querySelector(".notice-container");
    if (!container) {
      container = document.createElement("div");
      container.className = "notice-container";
      document.body.appendChild(container);
    }
    this.containerEl = container.createDiv("notice");
    this.messageEl = this.containerEl.createDiv({ cls: "notice-message", text: message });
    this.timeout = timeout;
  }
}

export class Modal {
  constructor(app) {
    this.app = app;
    this.containerEl = document.createElement("div");
    this.containerEl.className = "modal-container mod-dim";
    this.containerEl.createDiv("modal-bg");
    this.modalEl = this.containerEl.createDiv("modal");
    this.modalEl.createDiv("modal-close-button");
    this.headerEl = this.modalEl.createDiv("modal-header");
    this.titleEl = this.headerEl.createDiv("modal-title");
    this.contentEl = this.modalEl.createDiv("modal-content");
  }
  open() {
    document.body.appendChild(this.containerEl);
    this.onOpen();
  }
  close() {
    this.containerEl.remove();
    this.onClose();
  }
  onOpen() {}
  onClose() {}
}
