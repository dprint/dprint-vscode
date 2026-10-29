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
