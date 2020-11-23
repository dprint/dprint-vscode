import * as vscode from "vscode";

export interface EditorService {
    kill(): void;
    canFormat(filePath: string): Promise<boolean>;
    formatText(filePath: string, fileText: string, token: vscode.CancellationToken): Promise<string>;
}
