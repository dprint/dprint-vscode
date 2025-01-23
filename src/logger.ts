import type * as vscode from "vscode";

export class Instant {
  #time: number;

  constructor(time: number) {
    this.#time = time;
  }

  static now() {
    return new Instant(performance.now());
  }

  elapsedMs() {
    return performance.now() - this.#time;
  }
}

export class Logger {
  readonly #outputChannel: vscode.OutputChannel;
  #debug = false;

  static #hasFocused = false;

  constructor(outputChannel: vscode.OutputChannel) {
    this.#outputChannel = outputChannel;
  }

  setDebug(enabled: boolean) {
    this.#debug = enabled;
  }

  log(message: string, ...args: any[]) {
    this.#outputChannel.appendLine(getFormattedArgs(message, args));
  }

  logDebug(message: string, ...args: any[]) {
    if (this.#debug) {
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
    // only focus max one time per session to not annoy people
    if (!Logger.#hasFocused) {
      Logger.#hasFocused = true;
      this.#outputChannel.show();
    }
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
