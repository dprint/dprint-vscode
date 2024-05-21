import * as vscode from "vscode";

export interface EditorService {
  killAndDispose(): void;
  canFormat(filePath: string): Promise<boolean>;
  formatText(filePath: string, fileText: string, token: vscode.CancellationToken): Promise<string | undefined>;
}
