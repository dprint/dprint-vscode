import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import { DPRINT_CONFIG_FILE_NAMES, DPRINT_CONFIG_FILEPATH_GLOB } from "./constants";
import { Logger } from "./logger";
import { delay, waitWorkspaceInitialized } from "./utils";

export async function discoverWorkspaceConfigFiles(opts: { maxResults?: number; logger: Logger }) {
  const logger = opts.logger;
  // See https://github.com/dprint/dprint-vscode/issues/105 -- for some reason findFiles would
  // return no results on very large projects when called too early on startup
  await waitWorkspaceInitialized();
  // just in case, mitigate more by waiting a little bit of time
  await delay(250);
  let foundFiles = await vscodeFindFiles();
  let retryCount = 0;
  // retry trying to find a config file a bunch of times if there's one found in the root directory
  while (foundFiles.length === 0 && await workspaceHasConfigFileInRoot() && ++retryCount < 30) {
    logger.logDebug("Found config file in root with fs API. Waiting 1 second then retrying...");
    await delay(1_000);
    foundFiles = await vscodeFindFiles();
  }

  if (retryCount > 0) {
    if (foundFiles.length) {
      logger.logDebug("Gave up trying to find config file.");
    } else {
      logger.logDebug("Found config file after retrying.");
    }
  }

  return foundFiles;

  function vscodeFindFiles() {
    return vscode.workspace.findFiles(
      /* include */ DPRINT_CONFIG_FILEPATH_GLOB,
      /* exclude */ "**/node_modules/**",
      opts?.maxResults,
    );
  }

  async function workspaceHasConfigFileInRoot() {
    const dprintConfigFileNames = ["dprint.json", "dprint.jsonc", ".dprint.json", ".dprint.jsonc"];
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) {
      return false;
    }
    for (const folder of folders) {
      for (const fileName of dprintConfigFileNames) {
        const uri = vscode.Uri.joinPath(folder.uri, fileName);
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.type === vscode.FileType.File) {
            return true;
          }
        } catch {
          // does not exist
        }
      }
    }
    return false;
  }
}

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
