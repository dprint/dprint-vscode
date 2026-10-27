import type { FormatDocumentResult } from "../ExtensionBackend";
import type { NotFormattedReason as ExtensionNotFormattedReason } from "../globalConfigCommand";
import type { NotFormattedReason } from "./messages";

// note: this file should not import "vscode" so that it can be unit tested

/** Gets the result for a file that dprint didn't format. */
export function getFormatDocumentResult(
  reason: NotFormattedReason,
  message: string | undefined,
  isNotebookCell: boolean,
): FormatDocumentResult {
  let notFormattedReason: ExtensionNotFormattedReason;
  switch (reason) {
    case "unchanged":
      return { edits: [] };
    case "noConfigFile":
    case "globalConfigNotAllowed":
      notFormattedReason = "noConfigFile";
      break;
    case "noPlugin":
      notFormattedReason = isNotebookCell ? "noCellPlugin" : "noPlugin";
      break;
    case "noPlugins":
      notFormattedReason = "noPlugins";
      break;
    case "configDiagnostics":
      // formatting failed, which the editor service shows the user
      notFormattedReason = "failed";
      break;
    case "changedOutsideRange":
      notFormattedReason = "changedOutsideRange";
      break;
    default:
      // includes the reasons that are newer than the extension
      notFormattedReason = "notMatched";
      break;
  }
  return { notFormattedReason, notFormattedMessage: message };
}

/**
 * Gets what a formatting provider returns for the result, which is no edits when
 * dprint formats the file but didn't this time and undefined when it doesn't.
 */
export function getProviderEdits(result: FormatDocumentResult) {
  if (result.edits != null) {
    return result.edits;
  }
  return result.notFormattedReason === "failed" || result.notFormattedReason === "changedOutsideRange"
    ? []
    : undefined;
}
