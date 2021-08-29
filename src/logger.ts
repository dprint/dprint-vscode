import * as vscode from "vscode";

export class Logger {
  readonly #outputChannel: vscode.OutputChannel;
  #verbose = false;

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
      this.#outputChannel.appendLine(getFormattedMessageWithLevel("debug", message, args));
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
    this.#outputChannel.show();
  }
}

function getFormattedMessageWithLevel(level: "debug" | "info" | "warn" | "error", message: string, args: any[]) {
  return `[${level.toUpperCase()}] ${getFormattedArgs(message, args)}`;
}

function getFormattedArgs(message: string, args: any[]) {
  for (const arg of args) {
    message += " " + arg;
  }
  return message;
}
