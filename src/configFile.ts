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
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.type === vscode.FileType.File) {
            return uri;
          }
        } catch {
          // does not exist
        }
      }
    }
    return undefined;
  }
}
