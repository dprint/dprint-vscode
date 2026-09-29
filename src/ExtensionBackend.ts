import type * as vscode from "vscode";

export interface ExtensionBackend extends vscode.Disposable {
  readonly isLsp: boolean;
  reInitialize(): Promise<void>;
  /** Called when a config file's contents change (not when one is created or deleted). */
  onConfigFileChanged(): Promise<void>;
}
