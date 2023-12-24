import * as vscode from "vscode";
import { shellExpand } from "./utils";

export interface DprintExtensionConfig {
  path: string | undefined;
  verbose: boolean;
  experimentalLsp: boolean;
}

export function getCombinedDprintConfig(folders: readonly vscode.WorkspaceFolder[]) {
  const combinedConfig: DprintExtensionConfig = {
    path: undefined,
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
    if (config.path != null) {
      combinedConfig.path = config.path;
    }
  }

  return combinedConfig;
}

export function getDprintConfig(scope: vscode.Uri): DprintExtensionConfig {
  const config = vscode.workspace.getConfiguration("dprint", scope);
  return {
    path: getPath(),
    verbose: getBool("verbose"),
    experimentalLsp: getBool("experimentalLsp"),
  };

  function getPath() {
    const path = getRawPath();
    return path == null ? undefined : shellExpand(path);

    function getRawPath() {
      const path = config.get("path");
      return typeof path === "string" && path.trim().length > 0 ? path.trim() : undefined;
    }
  }

  function getBool(name: string) {
    const verbose = config.get(name);
    return verbose === true;
  }
}
