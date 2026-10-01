import type * as vscode from "vscode";
import type { NotFormattedReason } from "./globalConfigCommand";

export interface ExtensionBackend extends vscode.Disposable {
  reInitialize(): Promise<void>;
  /** Called when a config file's contents change (not when one is created or deleted). */
  onConfigFileChanged(): Promise<void>;
  /**
   * Gets the edits for formatting the document, or only the range when provided, using
   * the global config file when the document doesn't have a config file in an ancestor
   * directory. This is for explicitly formatting using the global config file regardless
   * of if the user enabled always using it, so it provides why the document wasn't
   * formatted for the caller to tell the user instead of notifying.
   */
  provideGlobalConfigFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range | undefined,
    options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<FormatDocumentResult>;
}

/** The edits for formatting a document, which are empty when it's already formatted, or why it wasn't formatted. */
export type FormatDocumentResult =
  | { edits: vscode.TextEdit[]; notFormattedReason?: undefined }
  | { edits?: undefined; notFormattedReason: NotFormattedReason };
