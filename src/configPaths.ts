import * as path from "node:path";
import { DPRINT_CONFIG_FILE_NAMES } from "./constants";
import type { Environment } from "./environment";

// note: this file should not import "vscode" so that it can be unit tested

const GLOBAL_CONFIG_FILE_NAMES = ["dprint.jsonc", "dprint.json"];

export interface ResolveLooseFolderConfigOptions {
  /** Whether to fall back to the global config file. */
  useGlobalConfig: boolean;
}

export interface LooseFolderConfig {
  /** The directory to run dprint in. */
  cwd: string;
  /** The config file the cli will use. */
  configFilePath: string;
  /** Whether the config file is the global config file. */
  isGlobalConfig: boolean;
}

/**
 * Resolves the config file to use and the directory to run dprint in to format
 * a file that's not in a workspace folder with a config file, or undefined when
 * there's no config file to use.
 */
export async function resolveLooseFolderConfig(
  env: Environment,
  filePath: string,
  options: ResolveLooseFolderConfigOptions,
): Promise<LooseFolderConfig | undefined> {
  const configFilePath = await findConfigFileInAncestorDirectories(env, path.dirname(filePath));
  if (configFilePath != null) {
    // run in the config file's directory so the cli resolves the config
    // with the same base path as when running it from the command line
    return { cwd: path.dirname(configFilePath), configFilePath, isGlobalConfig: false };
  }
  const globalConfigFilePath = options.useGlobalConfig ? await findGlobalConfigFile(env) : undefined;
  if (globalConfigFilePath != null) {
    // the cli uses the global config file with its cwd as the base path, so run
    // it at the file system root to allow formatting any file on that drive
    return { cwd: path.parse(filePath).root, configFilePath: globalConfigFilePath, isGlobalConfig: true };
  }
  return undefined;
}

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
  if (configFilePaths.some(configFilePath => path.relative(folderPath, path.dirname(configFilePath)) === "")) {
    return undefined;
  }
  return findConfigFileInAncestorDirectories(env, path.dirname(folderPath));
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
 * Finds the user's global config file. This mirrors how the dprint CLI
 * resolves the global config file.
 */
export async function findGlobalConfigFile(env: Environment) {
  const globalConfigDir = await resolveGlobalConfigDir(env);
  if (globalConfigDir == null) {
    return undefined;
  }
  for (const configFileName of GLOBAL_CONFIG_FILE_NAMES) {
    const configFilePath = path.join(globalConfigDir, configFileName);
    if (await env.fileExists(configFilePath)) {
      return configFilePath;
    }
  }
  return undefined;
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

async function resolveGlobalConfigDir(env: Environment) {
  const dprintConfigDir = getNonEmptyEnvVar(env, "DPRINT_CONFIG_DIR");
  if (dprintConfigDir != null) {
    // The cli resolves a relative directory against its cwd, which differs from
    // the extension's, so don't guess where it is in that case.
    return path.isAbsolute(dprintConfigDir) ? dprintConfigDir : undefined;
  }
  const systemConfigDir = await resolveSystemConfigDir(env);
  return systemConfigDir == null ? undefined : path.join(systemConfigDir, "dprint");
}

async function resolveSystemConfigDir(env: Environment) {
  switch (env.platform()) {
    case "darwin":
      return resolveMacSystemConfigDir(env);
    case "win32":
      // the cli uses the roaming app data known folder, which this environment variable points to
      return getNonEmptyEnvVar(env, "APPDATA");
    default: {
      // the cli only uses XDG_CONFIG_HOME on linux when it's an absolute path
      const xdgConfigHome = getNonEmptyEnvVar(env, "XDG_CONFIG_HOME");
      if (xdgConfigHome != null && path.isAbsolute(xdgConfigHome)) {
        return xdgConfigHome;
      }
      const homeDir = env.homeDir();
      return homeDir == null ? undefined : path.join(homeDir, ".config");
    }
  }
}

async function resolveMacSystemConfigDir(env: Environment) {
  const xdgConfigHome = getNonEmptyEnvVar(env, "XDG_CONFIG_HOME");
  if (xdgConfigHome != null) {
    return xdgConfigHome;
  }
  const homeDir = env.homeDir();
  if (homeDir == null) {
    return undefined;
  }
  // use the system config directory when a dprint directory already exists in it
  const systemConfigDir = path.join(homeDir, "Library", "Application Support");
  if (await env.fileExists(path.join(systemConfigDir, "dprint"))) {
    return systemConfigDir;
  }
  return path.join(homeDir, ".config");
}

function getNonEmptyEnvVar(env: Environment, name: string) {
  const value = env.envVar(name);
  return value == null || value.length === 0 ? undefined : value;
}
