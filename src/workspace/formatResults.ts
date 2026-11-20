import type { FormatDocumentResult } from "../ExtensionBackend";
import type { NotFormattedReason as ExtensionNotFormattedReason } from "../globalConfigCommand";
import type { ConfigFileIdentifier, NotFormattedReason } from "./messages";

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
 * (ex. on save). A config file is identified by its uri and the directory it's used for, which
 * dprint provides.
 */
export class ShownConfigErrors {
  /** The message that was shown by the key of a config file. */
  readonly #messages = new Map<string, string>();
  /** The messages that were shown without a config file. */
  readonly #otherMessages = new Set<string>();

  /** Gets if the error of the config file should be shown, which remembers that it was. */
  shouldShow(configFile: ConfigFileIdentifier | undefined, message: string) {
    if (configFile == null) {
      const isShown = this.#otherMessages.has(message);
      this.#otherMessages.add(message);
      return !isShown;
    }
    const key = getConfigFileKey(configFile);
    if (this.#messages.get(key) === message) {
      return false;
    }
    this.#messages.set(key, message);
    return true;
  }

  /** Forgets every error that was shown (ex. every config file may have changed), so they're shown again. */
  clear() {
    this.#messages.clear();
    this.#otherMessages.clear();
  }

  /**
   * Forgets the errors that were shown for the config file (ex. it changed), so they're shown again,
   * which is for each directory it's used for without a `dirUri`.
   */
  forget(configFile: ConfigFileIdentifier) {
    const prefix = getConfigFileKey({ uri: configFile.uri, dirUri: "" });
    for (const key of [...this.#messages.keys()]) {
      if (configFile.dirUri == null ? key.startsWith(prefix) : key === getConfigFileKey(configFile)) {
        this.#messages.delete(key);
      }
    }
  }
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

function getConfigFileKey(configFile: ConfigFileIdentifier) {
  return `${configFile.uri}\n${configFile.dirUri ?? ""}`;
}
