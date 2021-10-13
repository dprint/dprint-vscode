import * as vscode from "vscode";
import { ConfigJsonSchemaProvider } from "./ConfigJsonSchemaProvider";
import { createEditorService, EditorService } from "./editor-service";
import { DprintExecutable, PluginInfo } from "./executable";
import { Logger } from "./logger";

let editorService: EditorService | undefined = undefined;

export function activate(context: vscode.ExtensionContext) {
  let formattingSubscription: vscode.Disposable | undefined = undefined;

  const logger = new Logger();
  const configSchemaProvider = new ConfigJsonSchemaProvider(logger);
  context.subscriptions.push(logger);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(ConfigJsonSchemaProvider.scheme, configSchemaProvider),
  );

  const editProvider: vscode.DocumentFormattingEditProvider = {
    async provideDocumentFormattingEdits(document, options, token) {
      try {
        if (editorService == null) {
          logger.logWarn("Editor service not ready on format request.");
          return []; // not ready yet
        }

        if (!(await editorService.canFormat(document.fileName))) {
          logger.logVerbose("File not matched:", document.fileName);
          return [];
        }

        const newText = await editorService.formatText(document.fileName, document.getText(), token);
        const lastLineNumber = document.lineCount - 1;
        const replaceRange = new vscode.Range(
          0,
          0,
          lastLineNumber,
          document.lineAt(lastLineNumber).text.length,
        );
        const result = [vscode.TextEdit.replace(replaceRange, newText)];
        logger.logVerbose("Formatted:", document.fileName);
        return result;
      } catch (err: any) {
        // It seems there's no way to auto-dismiss notifications,
        // so this uses the Progress API to achieve that.
        vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: "Error formatting text",
        }, (progress) => {
          progress.report({ message: err.toString(), increment: 100 });
          return new Promise(resolve => setTimeout(resolve, 6000));
        });
        logger.logError("Error formatting text.", err);
        return [];
      }
    },
  };

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
      logger.setVerbose(getConfig().verbose);
    }
  }));

  // update state from current config
  logger.setVerbose(getConfig().verbose);

  return reInitializeEditorService().then(() => {
    logger.logInfo(`Extension active!`);
  });

  async function reInitializeEditorService() {
    logger.logInfo("Initializing...");
    setEditorService(undefined);
    setFormattingSubscription(undefined);

    const dprintExe = getDprintExecutable();
    const isInstalled = await dprintExe.checkInstalled();
    if (!isInstalled) {
      vscode.window.showErrorMessage(
        `Error initializing dprint. Ensure it is globally installed on the path (see https://dprint.dev/install) `
          + `or specify a "dprint.path" setting for this vscode extension.`,
      );
      return;
    }

    try {
      const editorInfo = await dprintExe.getEditorInfo();
      configSchemaProvider.setEditorInfo(editorInfo);
      const documentSelectors = getDocumentSelectors(editorInfo.plugins);
      setEditorService(createEditorService(editorInfo.schemaVersion, logger, dprintExe));
      setFormattingSubscription(vscode.languages.registerDocumentFormattingEditProvider(
        documentSelectors,
        editProvider,
      ));

      logger.logInfo(`Initialized - dprint ${editorInfo.cliVersion}`);
      logger.logVerbose(`cmd: ${dprintExe.cmdPath}`);
      logger.logVerbose(`dir: ${dprintExe.workspaceFolder}`);
    } catch (err) {
      vscode.window.showErrorMessage(`Error initializing dprint. ${err}`);
      logger.logErrorAndFocus("Error initializing.", err);

      // clear
      setEditorService(undefined);
      setFormattingSubscription(undefined);
    }

    function getDocumentSelectors(pluginInfos: PluginInfo[]): vscode.DocumentFilter[] {
      const fileExtensions = getFileExtensions();
      const fileExtensionsText = Array.from(fileExtensions.values()).join(",");
      logger.logInfo(`Supporting file extensions ${fileExtensionsText}`);

      if (fileExtensionsText.length > 0) {
        return [{
          scheme: "file",
          pattern: `**/*.{${fileExtensionsText}}`,
        }];
      } else {
        return [];
      }

      function getFileExtensions() {
        const fileExtensions = new Set();
        for (const pluginInfo of pluginInfos) {
          for (const fileExtension of pluginInfo.fileExtensions) {
            fileExtensions.add(fileExtension);
          }
        }
        return fileExtensions;
      }
    }
  }

  async function setFormattingSubscription(newSubscription: vscode.Disposable | undefined) {
    clearFormattingSubscription();

    formattingSubscription = newSubscription;
    if (newSubscription != null) {
      context.subscriptions.push(newSubscription);
    }

    function clearFormattingSubscription() {
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
  }

  function getDprintExecutable() {
    const config = getConfig();
    return new DprintExecutable(logger, {
      cmdPath: config.path,
      // todo: support multiple workspace folders
      workspaceFolder: vscode.workspace.rootPath!,
      verbose: config.verbose,
    });
  }

  function getConfig() {
    const config = vscode.workspace.getConfiguration("dprint");
    return {
      path: getPath(),
      verbose: getVerbose(),
    };

    function getPath() {
      const path = config.get("path");
      return typeof path === "string" && path.trim().length > 0 ? path.trim() : undefined;
    }

    function getVerbose() {
      const verbose = config.get("verbose");
      return verbose === true;
    }
  }
}

// this method is called when your extension is deactivated
export function deactivate() {
  setEditorService(undefined);
}

async function setEditorService(newService: EditorService | undefined) {
  editorService?.kill();
  editorService = newService;
}
