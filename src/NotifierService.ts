import * as vscode from "vscode";
import { Logger } from "./logger";

export interface NotifierServiceOptions {
  outputChannel: vscode.OutputChannel;
  logger: Logger;
  configUri?: vscode.Uri;
}

export class NotifierService {
  readonly #outputChannel: vscode.OutputChannel;
  readonly #logger: Logger;
  readonly #configUri?: vscode.Uri;
  #notificationsEnabled: boolean = false;

  constructor(opts: NotifierServiceOptions) {
    this.#outputChannel = opts.outputChannel;
    this.#logger = opts.logger;
    this.#configUri = opts.configUri;
    if (this.#configUri !== undefined) {
      this.#notificationsEnabled = true;
    }
  }

  logErrorAndFocus(message: string, ...args: any[]) {
    this.#logger.logError(message, ...args);
    if (this.#notificationsEnabled) {
      this.#outputChannel.show();
    }
  }

  showErrorMessageNotification(message: string) {
    if (this.#notificationsEnabled) {
      vscode.window.showErrorMessage(message);
    }
  }

  enableNotifications(value: boolean) {
    this.#notificationsEnabled = value;
  }
}
