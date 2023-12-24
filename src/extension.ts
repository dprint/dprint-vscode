import * as vscode from "vscode";
import { getDprintConfig } from "./config";
import { DPRINT_CONFIG_FILEPATH_GLOB } from "./constants";
import type { ExtensionBackend } from "./ExtensionBackend";
import { activateLegacy } from "./legacy/context";
import { Logger } from "./logger";
import { activateLsp } from "./lsp";

class GlobalPluginState {
  private extensionBackend: ExtensionBackend | undefined;

  constructor(
    public readonly outputChannel: vscode.OutputChannel,
    public readonly logger: Logger,
  ) {
  }

  async changeBackend(backend: ExtensionBackend) {
    try {
      await this.extensionBackend?.dispose();
    } catch (err) {
      this.logger.logWarn("Error disposing backend:", err);
    }
    this.extensionBackend = backend;
  }

  async dispose() {
    await this.extensionBackend?.dispose();
    this.outputChannel.dispose();
  }
}

let globalState: GlobalPluginState | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const globalState = await getAndSetNewGlobalState();
  let backend: ExtensionBackend | undefined = undefined;

  context.subscriptions.push(vscode.commands.registerCommand("dprint.restart", reInitializeBackend));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(reInitializeBackend));

  // reinitialize on configuration file changes
  const fileSystemWatcher = vscode.workspace.createFileSystemWatcher(DPRINT_CONFIG_FILEPATH_GLOB);
  context.subscriptions.push(fileSystemWatcher);
  context.subscriptions.push(fileSystemWatcher.onDidChange(reInitializeBackend));
  context.subscriptions.push(fileSystemWatcher.onDidCreate(reInitializeBackend));
  context.subscriptions.push(fileSystemWatcher.onDidDelete(reInitializeBackend));

  // reinitialize when the vscode configuration changes
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async evt => {
    if (evt.affectsConfiguration("dprint")) {
      try {
        if (isLsp() !== backend?.isLsp) {
          await setupNewBackend();
        }
        await reInitializeBackend();
      } catch (err) {
        globalState.logger.logError("Failed reinitializing:", err);
      }
    }
  }));
  context.subscriptions.push({
    async dispose() {
      await clearGlobalState();
    },
  });

  await reInitializeBackend().then((success) => {
    if (success) {
      globalState.logger.logInfo(`Extension active!`);
    } else {
      globalState.logger.logWarn(`Extension failed to start.`);
    }
  });

  async function reInitializeBackend() {
    try {
      if (backend == null) {
        backend = await setupNewBackend();
      }
      await backend.reInitialize();
      return true;
    } catch (err) {
      backend?.dispose();
      backend = undefined;
      globalState.logger.logError("Error initializing:", err);
      return false;
    }
  }

  async function setupNewBackend() {
    const backend = isLsp()
      ? activateLsp(context, globalState.logger, globalState.outputChannel)
      : activateLegacy(context, globalState.logger, globalState.outputChannel);
    await globalState.changeBackend(backend);
    return backend;
  }
}

// this method is called when your extension is deactivated
export async function deactivate() {
  await clearGlobalState();
}

async function getAndSetNewGlobalState() {
  await clearGlobalState();

  let outputChannel: vscode.OutputChannel | undefined = undefined;
  let logger: Logger | undefined = undefined;
  try {
    outputChannel = vscode.window.createOutputChannel("dprint");
    logger = new Logger(outputChannel);
  } catch (err) {
    outputChannel?.dispose();
    throw err;
  }
  globalState = new GlobalPluginState(outputChannel, logger);
  return globalState;
}

async function clearGlobalState() {
  await globalState?.dispose();
  globalState = undefined;
}

function isLsp() {
  // enable if any folder has this
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (getDprintConfig(folder.uri).experimentalLsp) {
      return true;
    }
  }
  return false;
}
