import * as vscode from "vscode";
import { DPRINT_CONFIG_FILEPATH_GLOB } from "./constants";
import type { ExtensionBackend } from "./ExtensionBackend";
import { activateLegacy } from "./legacy/context";
import { Logger } from "./logger";

class GlobalPluginState {
  constructor(
    private readonly outputChannel: vscode.OutputChannel,
    private readonly extensionBackend: ExtensionBackend,
  ) {
  }

  dispose() {
    this.extensionBackend.dispose();
    this.outputChannel.dispose();
  }
}

let globalState: GlobalPluginState | undefined;

export function activate(context: vscode.ExtensionContext) {
  const { logger, backend } = getAndSetNewGlobalState(context);

  context.subscriptions.push(vscode.commands.registerCommand("dprint.restart", reInitializeEditorService));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(reInitializeEditorService));

  // reinitialize on configuration file changes
  const fileSystemWatcher = vscode.workspace.createFileSystemWatcher(DPRINT_CONFIG_FILEPATH_GLOB);
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
  context.subscriptions.push({
    dispose() {
      clearGlobalState();
    },
  });

  return reInitializeEditorService().then(() => {
    logger.logInfo(`Extension active!`);
  });

  async function reInitializeEditorService() {
    backend.reInitialize();
  }
}

// this method is called when your extension is deactivated
export function deactivate() {
  clearGlobalState();
}

function getAndSetNewGlobalState(context: vscode.ExtensionContext) {
  clearGlobalState();

  let outputChannel: vscode.OutputChannel | undefined = undefined;
  let logger: Logger | undefined = undefined;
  let backend: ExtensionBackend | undefined = undefined;
  try {
    outputChannel = vscode.window.createOutputChannel("dprint");
    logger = new Logger(outputChannel);
    backend = activateLegacy(context, logger, outputChannel);
  } catch (err) {
    outputChannel?.dispose();
    throw err;
  }
  globalState = new GlobalPluginState(outputChannel, backend);
  return { logger, backend };
}

function clearGlobalState() {
  globalState?.dispose();
  globalState = undefined;
}
