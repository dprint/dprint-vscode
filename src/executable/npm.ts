import * as vscode from "vscode";
import type { Environment } from "../environment";
import type { Logger } from "../logger";

export async function tryResolveNpmExecutable(
  dir: vscode.Uri,
  env: Environment,
  logger: Logger,
) {
  const packageName = await getDprintPackageName(env);
  const nodeModulesExec = await tryResolveInNodeModules(dir, packageName, env, logger);
  if (nodeModulesExec == null) {
    return undefined;
  }
  if (!env.isWritableFileSystem()) {
    return nodeModulesExec.path;
  }

  const tempDir = vscode.Uri.joinPath(vscode.Uri.file(env.tmpdir()), "dprint");
  await env.mkdir(tempDir);
  const suffix = env.platform() === "win32" ? ".exe" : "";
  const tempFile = vscode.Uri.joinPath(tempDir, `${packageName}-${nodeModulesExec.version}${suffix}`);
  if (await env.fileExists(tempFile)) {
    return tempFile.fsPath;
  }
  logger.logDebug("Copying npm executable at", nodeModulesExec.path, "to", tempFile.fsPath);
  await env.atomicCopyFile(vscode.Uri.file(nodeModulesExec.path), tempFile);
  return tempFile.fsPath;
}

async function tryResolveInNodeModules(
  dir: vscode.Uri,
  packageName: string,
  env: Environment,
  logger: Logger,
) {
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
