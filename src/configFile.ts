import { existsSync } from "fs";
import { dirname, join } from "path";
import type * as vscode from "vscode";
import { DPRINT_CONFIG_FILE_NAMES } from "./constants";

export function ancestorDirsContainConfigFile(dirUri: vscode.Uri): boolean {
  for (const ancestorDirectoryPath of enumerateAncestorDirectories(dirUri.fsPath)) {
    if (directoryContainsConfigurationFile(ancestorDirectoryPath)) {
      return true;
    }
  }
  return false;

  function* enumerateAncestorDirectories(path: string): Iterable<string> {
    let currentPath = path;
    while (true) {
      const ancestorDirectoryPath = dirname(currentPath);
      if (ancestorDirectoryPath === currentPath) {
        break;
      }
      yield ancestorDirectoryPath;
      currentPath = ancestorDirectoryPath;
    }
  }

  function directoryContainsConfigurationFile(path: string): boolean {
    for (const configFileName of DPRINT_CONFIG_FILE_NAMES) {
      const configFilePath = join(path, configFileName);
      try {
        if (existsSync(configFilePath)) {
          return true;
        }
      } catch {
        // Continue to next path.
      }
    }
    return false;
  }
}
