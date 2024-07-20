import * as os from "os";
import * as vscode from "vscode";

export async function tryResolveNpmExecutable(dir: vscode.Uri) {
  const npmExecutablePath = vscode.Uri.joinPath(dir, "node_modules", "dprint", getDprintExeName());

  const exists = await fileExists(npmExecutablePath);
  if (exists) {
    return npmExecutablePath.fsPath;
  } else {
    // check the ancestors for a node_modules directory
    const parentDir = vscode.Uri.joinPath(dir, "../");
    if (parentDir.fsPath !== dir.fsPath) {
      return tryResolveNpmExecutable(parentDir);
    }
    return undefined;
  }
}

async function fileExists(path: vscode.Uri) {
  try {
    await vscode.workspace.fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

function getDprintExeName() {
  return os.platform() === "win32" ? "dprint.exe" : "dprint";
}
