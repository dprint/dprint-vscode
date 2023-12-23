import * as vscode from "vscode";

export interface ExtensionBackend extends vscode.Disposable {
  reInitialize(): Promise<void>;
}
