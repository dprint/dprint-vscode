import * as path from "node:path";
import { DPRINT_CONFIG_FILE_NAMES } from "./constants";
import type { Environment } from "./environment";

// note: this file should not import "vscode" so that it can be unit tested

const GLOBAL_CONFIG_FILE_NAMES = ["dprint.jsonc", "dprint.json"];

export interface ResolveLooseFolderCwdOptions {
  /** Whether to fall back to the global config file. */
  useGlobalConfig: boolean;
}

export interface LooseFolderCwd {
  cwd: string;
  /** Whether the cli will use the global config file in the cwd. */
  isGlobalConfig: boolean;
}

/**
 * Resolves the directory to run dprint in to format a file that's not in a
 * workspace folder with a config file, or undefined when there's no config
 * file to use.
 */
export async function resolveLooseFolderCwd(
  env: Environment,
  filePath: string,
  options: ResolveLooseFolderCwdOptions,
): Promise<LooseFolderCwd | undefined> {
  const configFilePath = await findConfigFileInAncestorDirectories(env, path.dirname(filePath));
  if (configFilePath != null) {
    // run in the config file's directory so the cli resolves the config
    // with the same base path as when running it from the command line
    return { cwd: path.dirname(configFilePath), isGlobalConfig: false };
  }
  if (options.useGlobalConfig && await findGlobalConfigFile(env) != null) {
    // the cli uses the global config file with its cwd as the base path, so run
    // it at the file system root to allow formatting any file on that drive
    return { cwd: path.parse(filePath).root, isGlobalConfig: true };
  }
  return undefined;
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
    return dprintConfigDir;
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
