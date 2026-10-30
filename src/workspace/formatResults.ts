import type { FormatDocumentResult } from "../ExtensionBackend";
import type { NotFormattedReason as ExtensionNotFormattedReason } from "../globalConfigCommand";
import type { FormatFailedReason, NotFormattedReason } from "./messages";

// note: this file should not import "vscode" so that it can be unit tested

/** Gets the result for a file that dprint didn't format. */
export function getFormatDocumentResult(
  reason: NotFormattedReason,
  message: string | undefined,
  isNotebookCell: boolean,
): FormatDocumentResult {
  let notFormattedReason: ExtensionNotFormattedReason;
  switch (reason) {
    case "noConfigFile":
    case "globalConfigNotAllowed":
      notFormattedReason = "noConfigFile";
      break;
    case "noPlugin":
      notFormattedReason = isNotebookCell ? "noCellPlugin" : "noPlugin";
      break;
    case "configDiagnostics":
    case "configError":
      // formatting failed, which dprint shows the user
      notFormattedReason = "failed";
      break;
    default:
      // dprint's message says why (ex. what needs to be approved or that range formatting isn't
      // supported), which includes the reasons that are newer than the extension
      notFormattedReason = "notMatched";
      break;
  }
  return { notFormattedReason, notFormattedMessage: message };
}

/**
 * The errors of the config files that the user was shown, which are only shown once for a config
 * file until they change because the editor formats without the user doing anything in between
 * (ex. on save).
 */
export class ShownConfigErrors {
  /** The message that was shown by the path of a config file the extension knows about. */
  readonly #messages = new Map<string, string>();
  /** The messages that were shown of the config files the extension doesn't know about (ex. the global one). */
  readonly #otherMessages = new Set<string>();

  /**
   * Gets if the error of the config file should be shown, which remembers that it was.
   *
   * @param configFilePath - The config file the extension knows the file is formatted with, if any.
   */
  shouldShow(configFilePath: string | undefined, message: string) {
    if (configFilePath == null) {
      const isShown = this.#otherMessages.has(message);
      this.#otherMessages.add(message);
      return !isShown;
    }
    if (this.#messages.get(configFilePath) === message) {
      return false;
    }
    this.#messages.set(configFilePath, message);
    return true;
  }

  /** Forgets the errors that were shown for the config file (ex. it changed), so they're shown again. */
  forget(configFilePath: string) {
    this.#messages.delete(configFilePath);
    // it may be one of the others
    this.#otherMessages.clear();
  }
}

/**
 * Gets if a format that failed is because a plugin couldn't format the file (usually a
 * syntax error), as opposed to a plugin failing, which includes the reasons that are newer
 * than the extension.
 */
export function isFormatError(reason: FormatFailedReason) {
  return reason === "formatError";
}

/**
 * Gets what a formatting provider returns for the result, which is no edits
 * when formatting failed and undefined when dprint doesn't format the file.
 */
export function getProviderEdits(result: FormatDocumentResult) {
  if (result.edits != null) {
    return result.edits;
  }
  return result.notFormattedReason === "failed" ? [] : undefined;
}
