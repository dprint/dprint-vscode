import * as vscode from "vscode";
import { ExtensionBackend } from "../ExtensionBackend";
import { Logger } from "../logger";
import { HttpsTextDownloader, ObjectDisposedError } from "../utils";
import { ConfigJsonSchemaProvider } from "./ConfigJsonSchemaProvider";
import { FolderInfos, WorkspaceService } from "./WorkspaceService";

export function activateLegacy(
  context: vscode.ExtensionContext,
  logger: Logger,
  outputChannel: vscode.OutputChannel,
): ExtensionBackend {
  const subscriptions: vscode.Disposable[] = [];
  let formattingSubscription: vscode.Disposable | undefined = undefined;
  const workspaceService = new WorkspaceService({
    outputChannel,
  });
  subscriptions.push(workspaceService);

  // todo: add an "onDidOpen" for dprint.json and use the appropriate EditorInfo
  // for ConfigJsonSchemaProvider based on the file that's shown
  const configSchemaProvider = new ConfigJsonSchemaProvider(logger, new HttpsTextDownloader());
  subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(ConfigJsonSchemaProvider.scheme, configSchemaProvider),
  );

  return {
    isLsp: false,
    async reInitialize() {
      setFormattingSubscription(undefined);
      try {
        const folderInfos = await workspaceService.initializeFolders();
        configSchemaProvider.setFolderInfos(folderInfos);
        trySetFormattingSubscriptionFromFolderInfos(folderInfos);
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
      setFormattingSubscription(undefined);
      for (const subscription of subscriptions) {
        try {
          subscription.dispose();
        } catch {
          // ignore
        }
      }
      subscriptions.length = 0; // clear
      logger.logDebug("Disposed legacy backend.");
    },
  };

  function trySetFormattingSubscriptionFromFolderInfos(allFolderInfos: FolderInfos) {
    const formattingPatterns = getFormattingPatterns();

    if (formattingPatterns.length === 0) {
      return;
    }

    setFormattingSubscription(
      vscode.languages.registerDocumentFormattingEditProvider(
        formattingPatterns.map(pattern => ({ scheme: "file", pattern })),
        {
          async provideDocumentFormattingEdits(document, options, token) {
            return workspaceService.provideDocumentFormattingEdits(document, options, token);
          },
        },
      ),
    );

    function getFormattingPatterns() {
      const patterns: vscode.RelativePattern[] = [];
      for (const folderInfo of allFolderInfos) {
        if (folderInfo.editorInfo.plugins.length > 0) {
          // Match against all files and let the dprint CLI say if it can format a file or not.
          // This is necessary because by using the "associations" feature, a user may pattern
          // match against any file path then format that file using a certain plugin. Additionally,
          // we can't use the "includes" and "excludes" patterns from the config file because we
          // want to ensure consistent path matching behaviour... so don't want to rely on vscode's
          // pattern matching being the same.
          const pattern = new vscode.RelativePattern(folderInfo.uri, `**/*`);
          patterns.push(pattern);
        }
      }
      return patterns;
    }
  }

  function setFormattingSubscription(newSubscription: vscode.Disposable | undefined) {
    clear();
    setNew();

    function clear() {
      if (formattingSubscription == null) {
        return;
      }
      const subscriptionIndex = context.subscriptions.indexOf(formattingSubscription);
      if (subscriptionIndex >= 0) {
        context.subscriptions.splice(subscriptionIndex, 1);
      }

      formattingSubscription.dispose();
      formattingSubscription = undefined;
    }

    function setNew() {
      formattingSubscription = newSubscription;
      if (newSubscription != null) {
        context.subscriptions.push(newSubscription);
      }
    }
  }
}
