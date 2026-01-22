import * as vscode from "vscode";
import { shellExpand } from "./utils";

export interface DprintExtensionConfigPathInfo {
  path: string;
  isFromWorkspace: boolean;
}

export interface DprintExtensionConfig {
  pathInfo: DprintExtensionConfigPathInfo | undefined;
  verbose: boolean;
  experimentalLsp: boolean;
}

export function getCombinedDprintConfig(folders: readonly vscode.WorkspaceFolder[]) {
  const combinedConfig: DprintExtensionConfig = {
    pathInfo: undefined,
    verbose: false,
    experimentalLsp: false,
  };

  for (const folder of folders) {
    const config = getDprintConfig(folder.uri);
    if (config.verbose) {
      combinedConfig.verbose = true;
    }
    if (config.experimentalLsp) {
      combinedConfig.experimentalLsp = true;
    }
    if (config.pathInfo != null && combinedConfig.pathInfo == null) {
      combinedConfig.pathInfo = config.pathInfo;
    }
  }

  return combinedConfig;
}

export function getDprintConfig(scope: vscode.Uri): DprintExtensionConfig {
  const config = vscode.workspace.getConfiguration("dprint", scope);
  const pathInfo = getPathInfo();
  return {
    pathInfo,
    verbose: getBool("verbose"),
    experimentalLsp: getBool("experimentalLsp"),
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
