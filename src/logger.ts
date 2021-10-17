import * as vscode from "vscode";

export class Logger {
  readonly #outputChannel: vscode.OutputChannel;
  #verbose = false;
  #enableNotifications = false;

  constructor() {
    this.#outputChannel = vscode.window.createOutputChannel("dprint");
  }

  dispose() {
    this.#outputChannel.dispose();
  }

  setVerbose(enabled: boolean) {
    this.#verbose = enabled;
  }

  log(message: string, ...args: any[]) {
    this.#outputChannel.appendLine(getFormattedArgs(message, args));
  }

  logVerbose(message: string, ...args: any[]) {
    if (this.#verbose) {
      this.#outputChannel.appendLine(getFormattedMessageWithLevel("verbose", message, args));
    }
  }

  logInfo(message: string, ...args: any[]) {
    this.#outputChannel.appendLine(getFormattedMessageWithLevel("info", message, args));
  }

  logWarn(message: string, ...args: any[]) {
    this.#outputChannel.appendLine(getFormattedMessageWithLevel("warn", message, args));
  }

  logError(message: string, ...args: any[]) {
    this.#outputChannel.appendLine(getFormattedMessageWithLevel("error", message, args));
  }

  logErrorAndFocus(message: string, ...args: any[]) {
    this.logError(message, ...args);

    this.#getShowNotifications().then(shouldShow => {
      if (shouldShow) {
        this.#outputChannel.show();
      }
    });
  }

  showErrorMessageNotification(message: string) {
    this.#getShowNotifications().then(shouldShow => {
      if (shouldShow) {
        vscode.window.showErrorMessage(message);
      }
    });
  }

  enableNotifications(value: boolean) {
    this.#enableNotifications = value;
  }

  async #getShowNotifications() {
    if (this.#enableNotifications) {
      return true;
    }

    try {
      const result = await vscode.workspace.findFiles("**/{dprint,.dprint,.dprintrc}.json");
      if (result.length > 0) {
        this.#enableNotifications = true;
        return true;
      } else {
        return false;
      }
    } catch (err) {
      this.logError("Error globbing for config file.", err);
      return false;
    }
  }
}

function getFormattedMessageWithLevel(level: "verbose" | "info" | "warn" | "error", message: string, args: any[]) {
  return `[${level.toUpperCase()}] ${getFormattedArgs(message, args)}`;
}

function getFormattedArgs(message: string, args: any[]) {
  for (const arg of args) {
    message += " " + arg;
  }
  return message;
}
