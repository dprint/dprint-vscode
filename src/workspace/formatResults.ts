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
  /** The message that was shown by config file. */
  readonly #messages = new Map<string, string>();

  /** Gets if the error of the config file should be shown, which remembers that it was. */
  shouldShow(configKey: string, message: string) {
    if (this.#messages.get(configKey) === message) {
      return false;
    }
    this.#messages.set(configKey, message);
    return true;
  }

  /** Forgets the errors that were shown (ex. a config file changed), so they're shown again. */
  clear() {
    this.#messages.clear();
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
