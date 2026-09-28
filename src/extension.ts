import * as vscode from "vscode";
import { ApprovedConfigPaths } from "./ApprovedConfigPaths";
import { getCombinedDprintConfig } from "./config";
import { ConfigJsonSchemaProvider } from "./ConfigJsonSchemaProvider";
import { DPRINT_CONFIG_FILEPATH_GLOB } from "./constants";
import type { ExtensionBackend } from "./ExtensionBackend";
import { activateLegacy } from "./legacy/context";
import { Logger } from "./logger";
import { activateLsp } from "./lsp";
import { HttpsTextDownloader } from "./utils";

class GlobalPluginState {
  constructor(
    public readonly outputChannel: vscode.OutputChannel,
    public readonly logger: Logger,
    public readonly extensionBackend: ExtensionBackend,
    public readonly configSchemaProvider: ConfigJsonSchemaProvider,
    public readonly configSchemaRegistration: vscode.Disposable,
  ) {
  }

  async dispose() {
    try {
      await this.extensionBackend?.dispose();
    } catch {
      // ignore
    }
    this.configSchemaRegistration.dispose();
    this.configSchemaProvider.dispose();
    this.outputChannel.dispose();
  }
}

let globalState: GlobalPluginState | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const globalState = await getAndSetNewGlobalState(context);
  const backend = globalState.extensionBackend;
  const logger = globalState.logger;
  let backendInitialization = Promise.resolve(true);

  // reinitialize on workspace folder changes
  context.subscriptions.push(vscode.commands.registerCommand("dprint.restart", reInitializeBackend));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(reInitializeBackend));

  // reinitialize when a configuration file is created or deleted and let the backend handle changes
  const fileSystemWatcher = vscode.workspace.createFileSystemWatcher(DPRINT_CONFIG_FILEPATH_GLOB);
  context.subscriptions.push(fileSystemWatcher);
  context.subscriptions.push(fileSystemWatcher.onDidChange(async () => {
    try {
      await backend.onConfigFileChanged();
    } catch (err) {
      logger.logError("Error handling configuration file change:", err);
    }
  }));
  context.subscriptions.push(fileSystemWatcher.onDidCreate(reInitializeBackend));
  context.subscriptions.push(fileSystemWatcher.onDidDelete(reInitializeBackend));

  // reinitialize when the vscode configuration changes
  let hasShownLspWarning = false;
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async evt => {
    if (evt.affectsConfiguration("dprint")) {
      if (isLsp() !== backend?.isLsp && !hasShownLspWarning) {
        // I tried really hard to not have to reload, but having everything clean up
        // properly was a pain and I think there might be stuff going on in the
        // vscode-languageclient that I don't know about. So, just prompt the user
        // to reload the vscode window when they change this option.
        // https://stackoverflow.com/a/47189404/188246
        const action = "Reload";
        vscode.window.showInformationMessage(
          "Changing dprint.experimentalLsp requires reloading the vscode window.",
          action,
        ).then(selectedAction => {
          if (selectedAction === action) {
            vscode.commands.executeCommand("workbench.action.reloadWindow");
          }
        });

        hasShownLspWarning = true;
      } else {
        hasShownLspWarning = false;
        await reInitializeBackend();
      }
    }
  }));

  context.subscriptions.push({
    async dispose() {
      await clearGlobalState();
    },
  });

  reInitializeBackend().then(success => {
    if (success) {
      logger.logInfo("Extension active!");
    } else {
      logger.logWarn("Extension failed to start.");
    }
  });

  async function reInitializeBackend() {
    backendInitialization = backendInitialization.then(async () => {
      try {
        await backend.reInitialize();
        return true;
      } catch (err) {
        logger.logError("Error initializing:", err);
        return false;
      }
    });
    return backendInitialization;
  }
}

// this method is called when your extension is deactivated
export async function deactivate() {
  await clearGlobalState();
}

async function getAndSetNewGlobalState(context: vscode.ExtensionContext) {
  await clearGlobalState();

  let outputChannel: vscode.OutputChannel | undefined = undefined;
  let logger: Logger | undefined = undefined;
  let backend: ExtensionBackend | undefined = undefined;
  let configSchemaProvider: ConfigJsonSchemaProvider | undefined;
  let configSchemaRegistration: vscode.Disposable | undefined;
  try {
    outputChannel = vscode.window.createOutputChannel("dprint");
    logger = new Logger(outputChannel);
    const approvedPaths = new ApprovedConfigPaths(context);
    configSchemaProvider = new ConfigJsonSchemaProvider(logger, new HttpsTextDownloader());
    configSchemaRegistration = vscode.workspace.registerTextDocumentContentProvider(
      ConfigJsonSchemaProvider.scheme,
      configSchemaProvider,
    );
    backend = isLsp()
      ? activateLsp(logger, approvedPaths)
      : activateLegacy(logger, approvedPaths, configSchemaProvider);
  } catch (err) {
    configSchemaRegistration?.dispose();
    configSchemaProvider?.dispose();
    outputChannel?.dispose();
    throw err;
  }
  globalState = new GlobalPluginState(outputChannel, logger, backend, configSchemaProvider, configSchemaRegistration);
  return globalState;
}

async function clearGlobalState() {
  await globalState?.dispose();
  globalState = undefined;
}

function isLsp() {
  return getCombinedDprintConfig(vscode.workspace.workspaceFolders ?? []).experimentalLsp;
}
