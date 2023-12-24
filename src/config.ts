import * as vscode from "vscode";
import { shellExpand } from "./utils";

export function getDprintConfig(scope: vscode.Uri) {
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
