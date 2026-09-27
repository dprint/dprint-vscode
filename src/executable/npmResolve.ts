import * as path from "node:path";
import type { Logger } from "../logger";

// note: this file should not import "vscode" so that it can be unit tested

export interface NpmExecutable {
  version: string;
  path: string;
}

/** File system operations used to resolve the npm executable. */
export interface NpmResolveFileSystem {
  fileExists(path: string): Promise<boolean>;
  readTextFile(path: string): Promise<string | undefined>;
  realPath(path: string): Promise<string | undefined>;
}

export type NpmResolveLogger = Pick<Logger, "logDebug" | "logWarn">;

export interface NpmResolveOptions {
  packageName: string;
  exeName: string;
  fs: NpmResolveFileSystem;
  logger: NpmResolveLogger;
}

/**
 * Searches the node_modules folder of the provided directory and its
 * ancestors for the dprint platform package's executable.
 */
export async function tryResolveInNodeModules(
  dir: string,
  options: NpmResolveOptions,
): Promise<NpmExecutable | undefined> {
  const nodeModulesDir = path.join(dir, "node_modules");
  const hoistedExec = await tryResolvePlatformPackage(
    path.join(nodeModulesDir, "@dprint", options.packageName),
    options,
  );
  if (hoistedExec != null) {
    return hoistedExec;
  }

  const dprintPackageExec = await tryResolveFromDprintPackage(nodeModulesDir, options);
  if (dprintPackageExec != null) {
    return dprintPackageExec;
  }

  // check the ancestors for a node_modules directory
  const parentDir = path.dirname(dir);
  if (parentDir !== dir) {
    return tryResolveInNodeModules(parentDir, options);
  }
  return undefined;
}

/**
 * Resolves the platform package relative to the real location of the `dprint` package.
 *
 * This handles package managers that don't hoist the platform package to the
 * top level node_modules folder (ex. pnpm symlinks `node_modules/dprint` into
 * `node_modules/.pnpm/dprint@<version>/node_modules/dprint` and places the
 * platform package beside it).
 */
async function tryResolveFromDprintPackage(
  nodeModulesDir: string,
  options: NpmResolveOptions,
): Promise<NpmExecutable | undefined> {
  const realDprintPackagePath = await options.fs.realPath(path.join(nodeModulesDir, "dprint"));
  if (realDprintPackagePath == null) {
    return undefined;
  }
  const candidates = [
    // nested install (ex. node_modules/dprint/node_modules/@dprint/<package>)
    path.join(realDprintPackagePath, "node_modules", "@dprint", options.packageName),
    // sibling install (ex. pnpm's node_modules/.pnpm/dprint@<version>/node_modules/@dprint/<package>)
    path.join(realDprintPackagePath, "..", "@dprint", options.packageName),
  ];
  for (const candidate of candidates) {
    const exec = await tryResolvePlatformPackage(candidate, options);
    if (exec != null) {
      options.logger.logDebug("Resolved npm executable via real path of dprint package at", realDprintPackagePath);
      return exec;
    }
  }
  return undefined;
}

async function tryResolvePlatformPackage(
  packagePath: string,
  options: NpmResolveOptions,
): Promise<NpmExecutable | undefined> {
  const npmExecutablePath = path.join(packagePath, options.exeName);
  if (!await options.fs.fileExists(npmExecutablePath)) {
    return undefined;
  }
  const pkgJsonPath = path.join(packagePath, "package.json");
  const packageJsonText = await options.fs.readTextFile(pkgJsonPath);
  if (packageJsonText == null) {
    return undefined;
  }
  try {
    return {
      version: JSON.parse(packageJsonText).version,
      path: npmExecutablePath,
    };
  } catch (err) {
    options.logger.logWarn("Failed resolving package.json", pkgJsonPath, " - Error:", err);
    return undefined;
  }
}
