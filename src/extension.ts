import * as vscode from "vscode";
import { ConfigJsonSchemaProvider } from "./ConfigJsonSchemaProvider";
import { EditorInfo } from "./executable";
import { Logger } from "./logger";
import { HttpsTextDownloader } from "./TextDownloader";
import { ObjectDisposedError } from "./utils";
import { FolderInfo, FolderInfos, WorkspaceService } from "./WorkspaceService";

class GlobalPluginState {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly outputChannel: vscode.OutputChannel,
  ) {
  }

  dispose() {
    this.outputChannel.dispose();
    this.workspaceService.dispose();
  }
}

let globalState: GlobalPluginState | undefined;

export function activate(context: vscode.ExtensionContext) {
  const { outputChannel, workspaceService } = getAndSetNewGlobalState(context);
  let formattingSubscription: vscode.Disposable | undefined = undefined;
  const logger = new Logger(outputChannel);

  // todo: add an "onDidOpen" for dprint.json and use the appropriate EditorInfo
  // for ConfigJsonSchemaProvider based on the file that's shown
  const configSchemaProvider = new ConfigJsonSchemaProvider(logger, new HttpsTextDownloader());
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(ConfigJsonSchemaProvider.scheme, configSchemaProvider),
  );

  context.subscriptions.push(vscode.commands.registerCommand("dprint.reset", reInitializeEditorService));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(reInitializeEditorService));

  // reinitialize on configuration file changes
  const fileSystemWatcher = vscode.workspace.createFileSystemWatcher("**/{dprint,.dprint,.dprintrc}.json");
  context.subscriptions.push(fileSystemWatcher);
  context.subscriptions.push(fileSystemWatcher.onDidChange(reInitializeEditorService));
  context.subscriptions.push(fileSystemWatcher.onDidCreate(reInitializeEditorService));
  context.subscriptions.push(fileSystemWatcher.onDidDelete(reInitializeEditorService));

  // reinitialize when the vscode configuration changes
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(evt => {
    if (evt.affectsConfiguration("dprint")) {
      reInitializeEditorService();
    }
  }));

  return reInitializeEditorService().then(() => {
    logger.logInfo(`Extension active!`);
  });

  async function reInitializeEditorService() {
    setFormattingSubscription(undefined);

    try {
      const folderInfos = await workspaceService.initializeFolders();
      configSchemaProvider.setFolderInfos(folderInfos);
      trySetFormattingSubscriptionFromFolderInfos(folderInfos);
    } catch (err) {
      if (!(err instanceof ObjectDisposedError)) {
        logger.logError("Error initializing:", err);
      }
    }
  }

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
        const extensions = getFileExtensions(folderInfo.editorInfo);
        if (extensions.size > 0) {
          const extensionsText = Array.from(extensions.values()).join(",");
          const pattern = new vscode.RelativePattern(folderInfo.folder, `**/*.{${extensionsText}}`);
          logger.logInfo("Matching pattern:", pattern.pattern, `(${pattern.base})`);
          patterns.push(pattern);
        }
      }
      return patterns;
    }

    function getFileExtensions(editorInfo: EditorInfo) {
      const fileExtensions = new Set();
      for (const pluginInfo of editorInfo.plugins) {
        for (const fileExtension of pluginInfo.fileExtensions) {
          fileExtensions.add(fileExtension);
        }
      }
      return fileExtensions;
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

// this method is called when your extension is deactivated
export function deactivate() {
  clearGlobalState();
}

function getAndSetNewGlobalState(context: vscode.ExtensionContext) {
  clearGlobalState();

  let outputChannel: vscode.OutputChannel | undefined = undefined;
  let workspaceService: WorkspaceService | undefined = undefined;
  try {
    outputChannel = vscode.window.createOutputChannel("dprint");
    workspaceService = new WorkspaceService({
      outputChannel,
    });
  } catch (err) {
    outputChannel?.dispose();
    workspaceService?.dispose();
    throw err;
  }
  globalState = new GlobalPluginState(workspaceService, outputChannel);
  context.subscriptions.push(globalState);
  return { workspaceService, outputChannel };
}

function clearGlobalState() {
  globalState?.dispose();
  globalState = undefined;
}
