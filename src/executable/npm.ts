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
      return await copyToTempDir(nodeModulesExec, packageName, env, logger);
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

/** Copies to the temp directory that are in progress, keyed by the temp file's path. */
const pendingTempCopies = new Map<string, Promise<void>>();

async function copyToTempDir(
  exec: NpmExecutable,
  packageName: string,
  env: Environment,
  logger: NpmLogger,
) {
  const tempDir = path.join(env.tmpdir(), "dprint");
  await env.mkdir(tempDir);
  const tempFile = path.join(tempDir, `${packageName}-${exec.version}.exe`);
  if (await env.fileExists(tempFile)) {
    return tempFile;
  }
  // Folders resolve their executable in parallel, so share the copy between them. Otherwise
  // each folder makes its own copy and a later one can fail to move its copy over the
  // executable an earlier one created and is now running.
  let pendingCopy = pendingTempCopies.get(tempFile);
  if (pendingCopy == null) {
    logger.logDebug("Copying npm executable at", exec.path, "to", tempFile);
    pendingCopy = copyUnlessExists(exec.path, tempFile, env, logger)
      .finally(() => pendingTempCopies.delete(tempFile));
    pendingTempCopies.set(tempFile, pendingCopy);
  }
  await pendingCopy;
  return tempFile;
}

async function copyUnlessExists(from: string, to: string, env: Environment, logger: NpmLogger) {
  try {
    await env.atomicCopyFile(from, to);
  } catch (err) {
    // Something else (ex. another window) may have made the copy in the meantime and be
    // running it, which can prevent replacing it. Note that VS Code retries a rename that
    // fails for that reason for about a minute on Windows, so this is only reached after that.
    if (!await env.fileExists(to)) {
      throw err;
    }
    logger.logDebug("Using npm executable at", to, "that was created while copying to it. Copy error:", err);
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
