import * as path from "node:path";
import type { Environment } from "../environment";
import type { Logger } from "../logger";

// note: this file should not import "vscode" so that it can be unit tested

export type NpmLogger = Pick<Logger, "logDebug" | "logWarn" | "logError">;

export async function tryResolveNpmExecutable(
  dir: string,
  env: Environment,
  logger: NpmLogger,
) {
  try {
    const packageName = await getDprintPackageName(env);
    const nodeModulesExec = await tryResolveInNodeModules(dir, packageName, env, logger);
    if (nodeModulesExec == null) {
      return undefined;
    }

    if (env.platform() === "win32" && env.isWritableFileSystem()) {
      // On windows we want to copy the dprint executable to a temporary directory and run
      // it from there so that if someone goes to delete their node_modules folder it won't
      // stop them from doing so because the dprint executable is in use by us.
      const tempDir = path.join(env.tmpdir(), "dprint");
      await env.mkdir(tempDir);
      const tempFile = path.join(tempDir, `${packageName}-${nodeModulesExec.version}.exe`);
      if (await env.fileExists(tempFile)) {
        return tempFile;
      }
      logger.logDebug("Copying npm executable at", nodeModulesExec.path, "to", tempFile);
      await env.atomicCopyFile(nodeModulesExec.path, tempFile);
      return tempFile;
    } else {
      return nodeModulesExec.path;
    }
  } catch (err) {
    logger.logError("Error resolving npm executable", err);
    return undefined;
  }
}

interface NpmExecutable {
  version: string;
  path: string;
}

async function tryResolveInNodeModules(
  dir: string,
  packageName: string,
  env: Environment,
  logger: NpmLogger,
): Promise<NpmExecutable | undefined> {
  const nodeModulesDir = path.join(dir, "node_modules");
  const hoistedExec = await tryResolvePlatformPackage(
    path.join(nodeModulesDir, "@dprint", packageName),
    env,
    logger,
  );
  if (hoistedExec != null) {
    return hoistedExec;
  }

  const dprintPackageExec = await tryResolveFromDprintPackage(nodeModulesDir, packageName, env, logger);
  if (dprintPackageExec != null) {
    return dprintPackageExec;
  }

  // check the ancestors for a node_modules directory
  const parentDir = path.dirname(dir);
  if (parentDir !== dir) {
    return tryResolveInNodeModules(parentDir, packageName, env, logger);
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
  packageName: string,
  env: Environment,
  logger: NpmLogger,
): Promise<NpmExecutable | undefined> {
  const realDprintPackagePath = await env.realPath(path.join(nodeModulesDir, "dprint"));
  if (realDprintPackagePath == null) {
    return undefined;
  }
  const candidates = [
    // nested install (ex. node_modules/dprint/node_modules/@dprint/<package>)
    path.join(realDprintPackagePath, "node_modules", "@dprint", packageName),
    // sibling install (ex. pnpm's node_modules/.pnpm/dprint@<version>/node_modules/@dprint/<package>)
    path.join(realDprintPackagePath, "..", "@dprint", packageName),
  ];
  for (const candidate of candidates) {
    const exec = await tryResolvePlatformPackage(candidate, env, logger);
    if (exec != null) {
      logger.logDebug("Resolved npm executable via real path of dprint package at", realDprintPackagePath);
      return exec;
    }
  }
  return undefined;
}

async function tryResolvePlatformPackage(
  packagePath: string,
  env: Environment,
  logger: NpmLogger,
): Promise<NpmExecutable | undefined> {
  const npmExecutablePath = path.join(packagePath, getDprintExeName(env));
  if (!await env.fileExists(npmExecutablePath)) {
    return undefined;
  }
  const pkgJsonPath = path.join(packagePath, "package.json");
  const packageJsonText = await env.readTextFile(pkgJsonPath);
  if (packageJsonText == null) {
    return undefined;
  }
  try {
    return {
      version: JSON.parse(packageJsonText).version,
      path: npmExecutablePath,
    };
  } catch (err) {
    logger.logWarn("Failed resolving package.json", pkgJsonPath, " - Error:", err);
    return undefined;
  }
}

function getDprintExeName(env: Environment) {
  return env.platform() === "win32" ? "dprint.exe" : "dprint";
}

async function getDprintPackageName(env: Environment) {
  const platform = env.platform();
  if (platform === "linux") {
    return `${platform}-${env.arch()}-${await env.getLinuxFamily()}`;
  } else {
    return `${platform}-${env.arch()}`;
  }
}
