import type * as vscode from "vscode";

export interface ExtensionBackend extends vscode.Disposable {
  readonly isLsp: boolean;
  reInitialize(): Promise<void>;
  /** Called when a config file's contents change (not when one is created or deleted). */
  onConfigFileChanged(): Promise<void>;
  /**
   * Gets the edits for formatting the document, or only the range when provided, using
   * the global config file when the document doesn't have a config file in an ancestor
   * directory. This is for explicitly formatting using the global config file when the
   * user hasn't enabled always using it.
   */
  provideGlobalConfigFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range | undefined,
    options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.TextEdit[] | undefined>;
}
