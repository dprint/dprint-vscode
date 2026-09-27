import * as vscode from "vscode";
import type { Environment } from "../environment";
import type { Logger } from "../logger";
import { tryResolveInNodeModules } from "./npmResolve";

export async function tryResolveNpmExecutable(
  dir: vscode.Uri,
  env: Environment,
  logger: Logger,
) {
  try {
    const packageName = await getDprintPackageName(env);
    const nodeModulesExec = await tryResolveInNodeModules(dir.fsPath, {
      packageName,
      exeName: getDprintExeName(env),
      fs: {
        fileExists: path => env.fileExists(vscode.Uri.file(path)),
        readTextFile: path => env.readTextFile(vscode.Uri.file(path)),
        realPath: async path => (await env.realPath(vscode.Uri.file(path)))?.fsPath,
      },
      logger,
    });
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
