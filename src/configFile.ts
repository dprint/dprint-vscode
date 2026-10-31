import * as fs from "node:fs";
import * as vscode from "vscode";
import { discoverConfigFiles } from "./configFileDiscovery";
import { DPRINT_CONFIG_FILEPATH_GLOB } from "./constants";
import { Logger } from "./logger";
import { delay } from "./utils";

export function discoverWorkspaceConfigFiles(opts: { logger: Logger }) {
  return discoverConfigFiles<vscode.Uri>({
    hasWorkspaceFolders: () => (vscode.workspace.workspaceFolders?.length ?? 0) > 0,
    findFiles: vscodeFindFiles,
    findRootConfigFile: getWorkspaceConfigFileInRoot,
    delay,
    logger: opts.logger,
  });

  function vscodeFindFiles() {
    // note: this follows a symlink to a directory while vscode's `search.followSymlinks` setting is on, which
    // it is by default (its search runs ripgrep with `--follow`), so a symlink in the workspace to a share may
    // make it read from another machine. The api of the vscode versions this supports (`engines.vscode`) has
    // no option to turn that off (`findFiles2` with `followSymlinks` is a proposed api there, which a published
    // extension can't use), and the spec only asks for it where the editor's api allows it.
    return vscode.workspace.findFiles(
      /* include */ DPRINT_CONFIG_FILEPATH_GLOB,
      /* exclude */ "**/node_modules/**",
    );
  }

  async function getWorkspaceConfigFileInRoot() {
    const dprintConfigFileNames = ["dprint.json", "dprint.jsonc", ".dprint.json", ".dprint.jsonc"];
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) {
      return undefined;
    }
    for (const folder of folders) {
      for (const fileName of dprintConfigFileNames) {
        const uri = vscode.Uri.joinPath(folder.uri, fileName);
        if (await isConfigFile(uri)) {
          return uri;
        }
      }
    }
    return undefined;
  }
}

/**
 * Gets whether there's a config file at the uri, which doesn't follow a symlink to find out (ex. one to
 * a share, which dprint asks about before reading), like the search of the ancestor directories.
 */
async function isConfigFile(uri: vscode.Uri) {
  try {
    if (uri.scheme !== "file") {
      return (await vscode.workspace.fs.stat(uri)).type === vscode.FileType.File;
    }
    return !(await fs.promises.lstat(uri.fsPath)).isDirectory();
  } catch {
    return false; // it doesn't exist
  }
}
