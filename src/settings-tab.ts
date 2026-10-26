import { PluginSettingTab, Setting, type App, type Plugin } from "obsidian";
import type { ServerState } from "./server-manager";

export interface SettingsHost {
  restartServer(): Promise<void>;
  serverState(): ServerState;
}

/** The settings tab. PR-2 adds only the "Restart server" button; the rest of the settings arrive in PR-3. */
export class WorkbenchSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: Plugin,
    private readonly host: SettingsHost,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("Restart server")
      .setDesc(
        `Stops the VS Code server and starts a fresh one on a new port with a new secret. Open Code tabs reload, and unsaved changes in them are lost. Server state: ${this.host.serverState()}.`,
      )
      .addButton((button) =>
        button.setButtonText("Restart server").onClick(async () => {
          button.setDisabled(true);
          try {
            await this.host.restartServer();
          } catch {
            // The reason has been shown in a notice; the button works again from the failed state.
          } finally {
            button.setDisabled(false);
            this.display();
          }
        }),
      );
  }
}
