import type * as vscode from "vscode";

export interface ExtensionBackend extends vscode.Disposable {
  readonly isLsp: boolean;
  reInitialize(): Promise<void>;
}
