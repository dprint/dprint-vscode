import * as vscode from "vscode";
import type { Environment } from "../environment";
import type { Logger } from "../logger";

// todo: I'd write unit tests for these using the Environment, but setting up
// unit tests seems like a huge pain... so I'm just manually testing this for now

export async function tryResolveNpmExecutable(
  dir: vscode.Uri,
  env: Environment,
  logger: Logger,
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
      const tempDir = vscode.Uri.joinPath(vscode.Uri.file(env.tmpdir()), "dprint");
      await env.mkdir(tempDir);
      const tempFile = vscode.Uri.joinPath(tempDir, `${packageName}-${nodeModulesExec.version}.exe`);
      if (await env.fileExists(tempFile)) {
        return tempFile.fsPath;
      }
      logger.logDebug("Copying npm executable at", nodeModulesExec.path, "to", tempFile.fsPath);
      await env.atomicCopyFile(vscode.Uri.file(nodeModulesExec.path), tempFile);
      return tempFile.fsPath;
    } else {
      return nodeModulesExec.path;
    }
  } catch (err) {
    logger.logError("Error resolving npm executable", err);
    return undefined;
  }
}

async function tryResolveInNodeModules(
  dir: vscode.Uri,
  packageName: string,
  env: Environment,
  logger: Logger,
): Promise<{ version: string; path: string } | undefined> {
  const packagePath = vscode.Uri.joinPath(dir, "node_modules", "@dprint", packageName);
  const npmExecutablePath = vscode.Uri.joinPath(packagePath, getDprintExeName(env));

  const exists = await env.fileExists(npmExecutablePath);
  if (exists) {
    const pkgJsonPath = vscode.Uri.joinPath(packagePath, "package.json");
    const packageJsonText = await env.readTextFile(pkgJsonPath);
    if (packageJsonText != null) {
      try {
        return {
          version: JSON.parse(packageJsonText).version,
          path: npmExecutablePath.fsPath,
        };
      } catch (err) {
        logger.logWarn("Failed resolving package.json", pkgJsonPath, " - Error:", err);
      }
    }
  }
  // check the ancestors for a node_modules directory
  const parentDir = vscode.Uri.joinPath(dir, "../");
  if (parentDir.fsPath !== dir.fsPath) {
    return tryResolveInNodeModules(parentDir, packageName, env, logger);
  }
  return undefined;
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
