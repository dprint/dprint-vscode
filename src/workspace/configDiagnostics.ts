import type { ConfigDiagnostic, TextRange } from "./messages";

// note: this file should not import "vscode" so that it can be unit tested

/** Where a diagnostic is shown when dprint doesn't know where its problem is in the config file. */
const START_OF_FILE: TextRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

/** Gets the text of a config file problem in the same form the cli logs it. */
export function getConfigDiagnosticMessage(diagnostic: ConfigDiagnostic) {
  let message = diagnostic.pluginName == null
    ? diagnostic.message
    : `[${diagnostic.pluginName}]: ${diagnostic.message}`;
  if (diagnostic.propertyName != null) {
    message += ` (${diagnostic.propertyName})`;
  }
  return message;
}

/** Gets where to show a config file problem, which is the start of the file when that's not known. */
export function getConfigDiagnosticRange(diagnostic: ConfigDiagnostic) {
  return diagnostic.range ?? START_OF_FILE;
}
