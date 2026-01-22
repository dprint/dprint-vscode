import * as vscode from "vscode";
export * from "./ActivatedDisposables.js";
export * from "./TextDownloader.js";

export class ObjectDisposedError extends Error {}

/** For now, only expands ~/ to env.HOME */
export function shellExpand(path: string, env: { [prop: string]: string | undefined } = process.env) {
  if (path.startsWith("~/")) {
    const home = env.HOME ?? "";
    path = path.replace("~/", home + "/");
  }
  return path;
}

export async function waitWorkspaceInitialized() {
  while (vscode.workspace.workspaceFolders == null || vscode.workspace.workspaceFolders.length === 0) {
    await delay(100);
  }
}

export function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function windowsQuoteArg(arg: string) {
  return `"${arg.replace(/"/g, "\"\"")}"`;
}

export function useShellForCmd(cmd: string) {
  // use shell on windows to support cmd/bat files
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd);
}
