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
  // now try to find the files
  return await attemptFindFiles();

  async function attemptFindFiles() {
    const foundFiles = await vscodeFindFiles();
    if (foundFiles.length === 0) {
      return await attemptFindViaFallback();
    } else {
      return foundFiles;
    }
  }

  async function attemptFindViaFallback() {
    // retry trying to find a config file a few times if there's one found in the root directory
    const rootConfigFile = await getWorkspaceConfigFileInRoot();
    if (rootConfigFile == null) {
      return [];
    }
    if (opts.maxResults === 1) {
      // only searching for one config file, so exit fast
      return [rootConfigFile];
    }
    let retryCount = 0;
    while (retryCount++ < 4) {
      logger.logDebug("Found config file in root with fs API. Waiting a bit then retrying...");
      await delay(1_000);
      const foundFiles = await vscodeFindFiles();
      if (foundFiles.length > 0) {
        logger.logDebug("Found config file after retrying.");
        return foundFiles;
      }
    }

    // we don't glob for files because it's potentially incredibly slow in very large
    // projects
    logger.logWarn(
      "Gave up trying to find config file. Using only root discovered via file system API. "
        + "Maybe you have the dprint config file excluded from vscode? "
        + "Don't do that because then vscode hides the file from the extension and the "
        + "extension otherwise doesn't use the file system APIs to find config files.",
    );
    return [rootConfigFile];
  }

  function vscodeFindFiles() {
    return vscode.workspace.findFiles(
      /* include */ DPRINT_CONFIG_FILEPATH_GLOB,
      /* exclude */ "**/node_modules/**",
      opts?.maxResults,
    );
  }

  async function getWorkspaceConfigFileInRoot() {
    const dprintConfigFileNames = ["dprint.json", "dprint.jsonc", ".dprint.json", ".dprint.jsonc"];
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) {
      return undefined;
    }
    for (const folder of folders) {
      for (const fileName of dprintConfigFileNames) {
        const uri = vscode.Uri.joinPath(folder.uri, fileName);
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.type === vscode.FileType.File) {
            return uri;
          }
        } catch {
          // does not exist
        }
      }
    }
    return undefined;
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
