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
    await delay(1_00);
  }
}

export async function findFiles(opts: {
  include: string;
  exclude: string;
  maxResults?: number;
}) {
  // See https://github.com/dprint/dprint-vscode/issues/105 -- for some reason findFiles would
  // return no results on very large projects when called too early on startup
  await waitWorkspaceInitialized();
  // just in case, mitigate chance of findFiles not being ready by waiting a little bit of time
  await delay(250);
  return await vscode.workspace.findFiles(
    opts.include,
    opts.exclude,
    opts.maxResults,
  );
}

export function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
