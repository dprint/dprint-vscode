import * as vscode from "vscode";
export * from "./ActivatedDisposables.js";
export * from "./shellExpand.js";
export * from "./TextDownloader.js";

export class ObjectDisposedError extends Error {}

export async function waitWorkspaceInitialized() {
  while (vscode.workspace.workspaceFolders == null || vscode.workspace.workspaceFolders.length === 0) {
    await delay(100);
  }
}

export function delay(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}
