import * as path from "node:path";
import { DPRINT_CONFIG_FILE_NAMES } from "./constants";
import type { Environment } from "./environment";

// note: this file should not import "vscode" so that it can be unit tested

/**
 * Finds the config file in an ancestor directory to use for a workspace folder
 * without a config file directly in it (ex. when opening a descendant directory
 * of a folder with a config file), or undefined when it's not needed or there's none.
 *
 * @param configFilePaths - The config files found in the workspace.
 */
export async function findWorkspaceFolderAncestorConfigFile(
  env: Environment,
  folderPath: string,
  configFilePaths: readonly string[],
) {
  // the config file in the folder is used instead
  if (configFilePaths.some(configFilePath => path.relative(folderPath, getConfigFileDirPath(configFilePath)) === "")) {
    return undefined;
  }
  return findConfigFileInAncestorDirectories(env, path.dirname(folderPath));
}

/** Gets the directory whose files the config file formats, which is the directory it's in unless that's a `.config` directory. */
export function getConfigFileDirPath(configFilePath: string) {
  const dirPath = path.dirname(configFilePath);
  return path.basename(dirPath) === ".config" ? path.dirname(dirPath) : dirPath;
}

/**
 * Removes the config files that are in a cache directory within the folder, such
 * as the config files of the packages Cargo copies into its target directory. Cache
 * directories are identified by a CACHEDIR.TAG file (https://bford.info/cachedir/).
 *
 * @param configFilePaths - The config files found in the folder.
 */
export async function filterCacheDirConfigFiles(
  env: Environment,
  folderPath: string,
  configFilePaths: readonly string[],
) {
  const isCacheDirByPath = new Map<string, Promise<boolean>>();
  const isInCacheDir = await Promise.all(configFilePaths.map(async configFilePath => {
    // the folder itself isn't checked because the user chose to open it
    let currentPath = path.dirname(configFilePath);
    while (path.relative(folderPath, currentPath) !== "" && isPathWithin(folderPath, currentPath)) {
      if (await isCacheDir(currentPath)) {
        return true;
      }
      currentPath = path.dirname(currentPath);
    }
    return false;
  }));
  return configFilePaths.filter((_, i) => !isInCacheDir[i]);

  function isCacheDir(dirPath: string) {
    let isCacheDir = isCacheDirByPath.get(dirPath);
    if (isCacheDir == null) {
      isCacheDir = env.fileExists(path.join(dirPath, "CACHEDIR.TAG"));
      isCacheDirByPath.set(dirPath, isCacheDir);
    }
    return isCacheDir;
  }
}

/**
 * Finds the config file in the provided directory or its closest ancestor
 * directory. This mirrors how the dprint CLI discovers config files.
 */
export async function findConfigFileInAncestorDirectories(env: Environment, dirPath: string) {
  let currentPath = dirPath;
  while (true) {
    for (const configFileName of DPRINT_CONFIG_FILE_NAMES) {
      const configFilePath = path.join(currentPath, configFileName);
      if (await env.fileExists(configFilePath)) {
        return configFilePath;
      }
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return undefined;
    }
    currentPath = parentPath;
  }
}

/**
 * Finds the config file in a directory or its closest ancestor directory like
 * `findConfigFileInAncestorDirectories`, but caches the result for each directory
 * it looks in. This is so that finding the config file for a directory that was
 * already searched, or that shares ancestor directories with one that was, doesn't
 * hit the file system again. The cache needs to be cleared when a config file may
 * have been created or deleted.
 */
export class AncestorConfigFileCache {
  readonly #env: Environment;
  readonly #configFilePathsByDir = new Map<string, Promise<string | undefined>>();

  constructor(env: Environment) {
    this.#env = env;
  }

  find(dirPath: string): Promise<string | undefined> {
    let configFilePath = this.#configFilePathsByDir.get(dirPath);
    if (configFilePath == null) {
      const newConfigFilePath = this.#find(dirPath);
      configFilePath = newConfigFilePath;
      this.#configFilePathsByDir.set(dirPath, newConfigFilePath);
      // don't cache failures
      newConfigFilePath.catch(() => {
        if (this.#configFilePathsByDir.get(dirPath) === newConfigFilePath) {
          this.#configFilePathsByDir.delete(dirPath);
        }
      });
    }
    return configFilePath;
  }

  clear() {
    this.#configFilePathsByDir.clear();
  }

  async #find(dirPath: string): Promise<string | undefined> {
    for (const configFileName of DPRINT_CONFIG_FILE_NAMES) {
      const configFilePath = path.join(dirPath, configFileName);
      if (await this.#env.fileExists(configFilePath)) {
        return configFilePath;
      }
    }
    const parentPath = path.dirname(dirPath);
    return parentPath === dirPath ? undefined : this.find(parentPath);
  }
}

/**
 * Finds the folder that most closely contains the file path. When multiple
 * folders have the same path, the last one wins.
 */
export function findClosestFolder<T>(folders: Iterable<T>, getFolderPath: (folder: T) => string, filePath: string) {
  let bestMatch: T | undefined;
  let bestMatchPath: string | undefined;
  for (const folder of folders) {
    const folderPath = getFolderPath(folder);
    if (isPathWithin(folderPath, filePath) && (bestMatchPath == null || isPathWithin(bestMatchPath, folderPath))) {
      bestMatch = folder;
      bestMatchPath = folderPath;
    }
  }
  return bestMatch;
}

/** Gets if the candidate path is the parent path or a descendant of it. */
export function isPathWithin(parentPath: string, candidatePath: string) {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === ""
    || (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}
