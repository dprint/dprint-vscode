import * as path from "node:path";
import {
  DOT_CONFIG_DIR_NAME,
  DOT_CONFIG_FILE_NAMES,
  DPRINT_CONFIG_FILE_NAMES,
  isCaseInsensitivePlatform,
} from "./constants";
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
  options: FindConfigFileOptions = {},
) {
  // the config file in the folder is used instead
  if (configFilePaths.some(configFilePath => path.relative(folderPath, getConfigFileDir(env, configFilePath)) === "")) {
    return undefined;
  }
  // the folder may be the root of a share (ex. `/net/host`), above which isn't looked in
  const parentPath = getSearchParent(env, folderPath);
  return parentPath == null ? undefined : findConfigFileInAncestorDirectories(env, parentPath, options);
}

/** How the config file of a directory is found. */
export interface FindConfigFileOptions {
  /**
   * Whether a symlink is followed, which is for an older dprint that reads a config file without the user
   * allowing one on another machine anyway, so it's found like the CLI finds it (ex. in a symlinked `.config`
   * directory, and not a symlink that points to nothing).
   */
  followSymlinks?: boolean;
}

/**
 * Removes the config files the cli doesn't use because there's another config file
 * for the same directory that it uses instead (ex. a `.config/dprint.json` when
 * there's a `dprint.json` beside the `.config` directory) or because it doesn't
 * search for the config file's name in a `.config` directory (ex. `.config/.dprint.json`).
 *
 * @param configFilePaths - The config files found in the folder.
 */
export function filterUnusedConfigFiles(env: Environment, configFilePaths: readonly string[]) {
  const bestConfigFileByDir = new Map<string, { configFilePath: string; rank: number }>();
  for (const configFilePath of configFilePaths) {
    const rank = getConfigFileRank(env, configFilePath);
    const dirPath = getConfigFileDir(env, configFilePath);
    const best = bestConfigFileByDir.get(dirPath);
    if (rank != null && (best == null || rank < best.rank)) {
      bestConfigFileByDir.set(dirPath, { configFilePath, rank });
    }
  }
  const usedConfigFilePaths = new Set(Array.from(bestConfigFileByDir.values(), best => best.configFilePath));
  return configFilePaths.filter(configFilePath => usedConfigFilePaths.has(configFilePath));
}

/**
 * Removes the config files that are in a cache directory within the folder, such
 * as the config files of the packages Cargo copies into its target directory. Cache
 * directories are identified by a CACHEDIR.TAG file (https://bford.info/cachedir/),
 * which is looked up without following a symlink (one isn't a cache tag).
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
      isCacheDir = env.pathKind(path.join(dirPath, "CACHEDIR.TAG")).then(kind => kind === "file");
      isCacheDirByPath.set(dirPath, isCacheDir);
    }
    return isCacheDir;
  }
}

/**
 * Finds the config file in the provided directory or its closest ancestor
 * directory. This mirrors how the dprint CLI discovers config files.
 */
export async function findConfigFileInAncestorDirectories(
  env: Environment,
  dirPath: string,
  options: FindConfigFileOptions = {},
) {
  let currentPath = dirPath;
  while (true) {
    // a `.config` directory is searched as part of its parent directory, which is next
    if (!isDotConfigDir(env, currentPath)) {
      const configFilePath = await findConfigFileInDir(env, currentPath, options);
      if (configFilePath != null) {
        return configFilePath;
      }
    }

    const parentPath = getSearchParent(env, currentPath);
    if (parentPath == null) {
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
  readonly #options: FindConfigFileOptions;
  readonly #configFilePathsByDir = new Map<string, Promise<string | undefined>>();

  constructor(env: Environment, options: FindConfigFileOptions = {}) {
    this.#env = env;
    this.#options = options;
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
    // a `.config` directory is searched as part of its parent directory, which is next
    if (!isDotConfigDir(this.#env, dirPath)) {
      const configFilePath = await findConfigFileInDir(this.#env, dirPath, this.#options);
      if (configFilePath != null) {
        return configFilePath;
      }
    }
    const parentPath = getSearchParent(this.#env, dirPath);
    return parentPath == null ? undefined : this.find(parentPath);
  }
}

/**
 * Gets the directory a config file applies to, which is the directory it's in
 * except for a config file in a `.config` directory, which applies to the parent
 * of that directory. This mirrors the dprint CLI.
 */
export function getConfigFileDir(env: Environment, configFilePath: string) {
  const dirPath = path.dirname(configFilePath);
  return isDotConfigFile(env, configFilePath) ? path.dirname(dirPath) : dirPath;
}

/**
 * Gets if the directory is a `.config` directory, which the dprint CLI treats as
 * part of its parent directory. The exception is the home directory's `.config`,
 * which is where the user's configuration goes (ex. `XDG_CONFIG_HOME`) and so is
 * an ordinary directory.
 */
export function isDotConfigDir(env: Environment, dirPath: string) {
  const parentPath = path.dirname(dirPath);
  return toFileNameKey(env, path.basename(dirPath)) === DOT_CONFIG_DIR_NAME && parentPath !== dirPath
    && !isHomeDir(env, parentPath);
}

/**
 * Gets the names of the files to watch in each directory for the config files in ancestor directories
 * of the workspace folders: the config file names in the directory a config file applies to, and the
 * ones of its `.config` directory, which is watched on its own because a watcher of a directory
 * doesn't watch its subdirectories. The home directory's `.config` isn't one (see `isDotConfigDir`).
 */
export function getAncestorConfigFileNamesByDir(
  env: Environment,
  configFiles: Iterable<
    { configFilePath: string; names?: { configFileNames: readonly string[]; dotConfigFileNames: readonly string[] } }
  >,
) {
  const fileNamesByDir = new Map<string, readonly string[]>();
  for (const { configFilePath, names } of configFiles) {
    // the names that dprint looks up, which an older dprint doesn't say
    const configFileNames = names?.configFileNames ?? DPRINT_CONFIG_FILE_NAMES;
    const dotConfigFileNames = names?.dotConfigFileNames ?? DOT_CONFIG_FILE_NAMES;
    const dirPath = getConfigFileDir(env, configFilePath);
    const dotConfigDirPath = path.join(dirPath, DOT_CONFIG_DIR_NAME);
    if (isDotConfigDir(env, dotConfigDirPath)) {
      // creating or deleting the `.config` directory is a change of the directory
      fileNamesByDir.set(dirPath, [...configFileNames, DOT_CONFIG_DIR_NAME]);
      fileNamesByDir.set(dotConfigDirPath, dotConfigFileNames);
    } else {
      fileNamesByDir.set(dirPath, configFileNames);
    }
  }
  return fileNamesByDir;
}

/**
 * Gets what to do for a change of a file that a config file in an ancestor directory is watched for:
 * find the config files again when one was created or deleted (including a `.config` directory),
 * tell dprint when one changed, and nothing when a `.config` directory itself changed.
 */
export function getAncestorConfigFileChangeAction(
  env: Environment,
  filePath: string,
  change: "created" | "changed" | "deleted",
): "findAgain" | "configFileChanged" | undefined {
  if (change !== "changed") {
    return "findAgain";
  }
  return toFileNameKey(env, path.basename(filePath)) === DOT_CONFIG_DIR_NAME ? undefined : "configFileChanged";
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

/**
 * Finds the config file the dprint CLI uses in the directory. A symlink isn't followed unless the
 * options say to, because it may point to another machine, which dprint only reads once the user
 * allows it. So a symlink that points to nothing is still found, which dprint then says is missing,
 * while the CLI would look further up for one. It looks for the extension's names, not the ones a dprint
 * process says it looks up (`ServerCapability.configFileNames`), because it decides which one to start.
 */
async function findConfigFileInDir(env: Environment, dirPath: string, options: FindConfigFileOptions) {
  const exists = async (filePath: string) =>
    options.followSymlinks ? await env.fileExists(filePath) : await env.pathKind(filePath) != null;
  for (const configFileName of DPRINT_CONFIG_FILE_NAMES) {
    const configFilePath = path.join(dirPath, configFileName);
    if (await exists(configFilePath)) {
      return configFilePath;
    }
  }
  // only look in the `.config` directory when there is one, which most directories don't have
  // (a symlinked one is only looked in when following symlinks, and dprint still finds it for the
  // documents it's asked about)
  const dotConfigDirPath = path.join(dirPath, DOT_CONFIG_DIR_NAME);
  const isDir = async () =>
    options.followSymlinks ? await env.fileExists(dotConfigDirPath) : await env.pathKind(dotConfigDirPath) === "dir";
  if (isDotConfigDir(env, dotConfigDirPath) && await isDir()) {
    for (const configFileName of DOT_CONFIG_FILE_NAMES) {
      const configFilePath = path.join(dotConfigDirPath, configFileName);
      if (await exists(configFilePath)) {
        return configFilePath;
      }
    }
  }
  return undefined;
}

/**
 * Gets the directory to look in for a config file after the directory, which is undefined at the root
 * of the file system and at the root of a network share like dprint does, because what's above it
 * isn't on the share (ex. `/net/host/dprint.json` is looked for, but not `/net/dprint.json`, which
 * the automounter would look up as a host named `dprint.json`). The root of a UNC path on Windows
 * (`\\server\share\`) is a root of the file system.
 *
 * Note that this only knows the shares in `/net` (and where macOS has it on the data volume), not the
 * root of a share that an automounter mounts elsewhere (ex. `/home/me` when `/home` is an `autofs`
 * directory), which the server stops at too. That's an accepted limitation of this search.
 */
function getSearchParent(env: Environment, dirPath: string) {
  const parentPath = path.dirname(dirPath);
  if (parentPath === dirPath) {
    return undefined;
  }
  // the directory of a host in `/net` (or where macOS has it on the data volume), whose case doesn't matter
  if (env.platform() !== "win32" && /^\/(System\/Volumes\/Data\/)?net\/[^/]+\/?$/i.test(dirPath)) {
    return undefined;
  }
  return parentPath;
}

/**
 * Gets where the config file is in the order the dprint CLI searches a directory
 * for its config file, or undefined when it's not a name the CLI searches for.
 */
function getConfigFileRank(env: Environment, configFilePath: string) {
  const fileName = toFileNameKey(env, path.basename(configFilePath));
  if (isDotConfigDir(env, path.dirname(configFilePath))) {
    const index = DOT_CONFIG_FILE_NAMES.indexOf(fileName);
    return index === -1 ? undefined : DPRINT_CONFIG_FILE_NAMES.length + index;
  }
  const index = DPRINT_CONFIG_FILE_NAMES.indexOf(fileName);
  return index === -1 ? undefined : index;
}

function isDotConfigFile(env: Environment, configFilePath: string) {
  return DOT_CONFIG_FILE_NAMES.includes(toFileNameKey(env, path.basename(configFilePath)))
    && isDotConfigDir(env, path.dirname(configFilePath));
}

/**
 * Gets a file name to compare with the names dprint looks up, which is without its case on a case
 * insensitive file system (Windows and macOS by default), where dprint finds them in another case too.
 */
function toFileNameKey(env: Environment, fileName: string) {
  return isCaseInsensitivePlatform(env.platform()) ? fileName.toLowerCase() : fileName;
}

function isHomeDir(env: Environment, dirPath: string) {
  const homeDir = env.homeDir();
  // without its case on a case insensitive file system (ex. `/users/david` on macOS), like dprint compares it
  return homeDir != null && toFileNameKey(env, path.resolve(homeDir)) === toFileNameKey(env, path.resolve(dirPath));
}
