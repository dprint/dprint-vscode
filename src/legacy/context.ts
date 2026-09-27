import * as vscode from "vscode";
import type { ApprovedConfigPaths } from "../ApprovedConfigPaths";
import type { ConfigJsonSchemaProvider } from "../ConfigJsonSchemaProvider";
import type { ExtensionBackend } from "../ExtensionBackend";
import type { Logger } from "../logger";
import { ActivatedDisposables, ObjectDisposedError } from "../utils";
import { WorkspaceService } from "./WorkspaceService";

export function activateLegacy(
  logger: Logger,
  approvedPaths: ApprovedConfigPaths,
  configSchemaProvider: ConfigJsonSchemaProvider,
): ExtensionBackend {
  const resourceDisposables = new ActivatedDisposables(logger);
  const workspaceService = new WorkspaceService({
    approvedPaths,
    logger,
  });
  resourceDisposables.push(workspaceService);
  resourceDisposables.push(vscode.languages.registerDocumentFormattingEditProvider(
    { scheme: "file" },
    workspaceService,
  ));

  // todo: add an "onDidOpen" for dprint.json and use the appropriate EditorInfo
  // for ConfigJsonSchemaProvider based on the file that's shown
  return {
    isLsp: false,
    async reInitialize() {
      try {
        const folderInfos = await workspaceService.initializeFolders();
        configSchemaProvider.setEditorInfos(folderInfos.map(info => info.editorInfo));
        if (folderInfos.length === 0) {
          logger.logInfo("Configuration file not found.");
        }
      } catch (err) {
        if (!(err instanceof ObjectDisposedError)) {
          logger.logError("Error initializing:", err);
        }
      }
      logger.logDebug("Initialized legacy backend.");
    },
    dispose() {
      resourceDisposables.dispose();
      logger.logDebug("Disposed legacy backend.");
    },
  };
}
