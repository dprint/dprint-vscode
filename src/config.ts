import * as vscode from "vscode";
import { shellExpand } from "./utils";

export interface DprintExtensionConfigPathInfo {
  path: string;
  isFromWorkspace: boolean;
}

export interface DprintExtensionConfig {
  pathInfo: DprintExtensionConfigPathInfo | undefined;
  verbose: boolean;
  useGlobalConfig: boolean;
  ensureStableFormat: boolean;
}

export function getDprintConfig(scope: vscode.Uri): DprintExtensionConfig {
  const config = vscode.workspace.getConfiguration("dprint", scope);
  const pathInfo = getPathInfo();
  return {
    pathInfo,
    verbose: getBool("verbose"),
    useGlobalConfig: getBool("useGlobalConfig"),
    ensureStableFormat: getBool("ensureStableFormat"),
  };

  function getPathInfo(): DprintExtensionConfigPathInfo | undefined {
    const inspection = config.inspect<string>("path");

    const rawPath = config.get("path");
    if (typeof rawPath === "string" && rawPath.trim().length > 0) {
      // check if path is set in workspace or folder settings (not global/user)
      const workspaceValue = inspection?.workspaceValue;
      const folderValue = inspection?.workspaceFolderValue;
      const isFromWorkspace = (typeof workspaceValue === "string" && workspaceValue.trim().length > 0)
        || (typeof folderValue === "string" && folderValue.trim().length > 0);
      return {
        path: shellExpand(rawPath.trim()),
        isFromWorkspace,
      };
    } else {
      return undefined;
    }
  }

  function getBool(name: string) {
    const verbose = config.get(name);
    return verbose === true;
  }
}
