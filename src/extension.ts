import { existsSync } from "fs";
import { dirname, join } from "path";
import * as vscode from "vscode";
import { getCombinedDprintConfig } from "./config";
import { DPRINT_CONFIG_FILE_NAMES, DPRINT_CONFIG_FILEPATH_GLOB } from "./constants";
import type { ExtensionBackend } from "./ExtensionBackend";
import { activateLegacy } from "./legacy/context";
import { Logger } from "./logger";
import { activateLsp } from "./lsp";

class GlobalPluginState {
  constructor(
    public readonly outputChannel: vscode.OutputChannel,
    public readonly logger: Logger,
    public readonly extensionBackend: ExtensionBackend,
  ) {
  }

  async dispose() {
    try {
      await this.extensionBackend?.dispose();
    } catch {
      // ignore
    }
    this.outputChannel.dispose();
  }
}

let globalState: GlobalPluginState | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const globalState = await getAndSetNewGlobalState(context);
  const backend = globalState.extensionBackend;
  const logger = globalState.logger;

  context.subscriptions.push(vscode.commands.registerCommand("dprint.restart", reInitializeBackend));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(reInitializeBackend));

  // reinitialize on configuration file changes
  const fileSystemWatcher = vscode.workspace.createFileSystemWatcher(DPRINT_CONFIG_FILEPATH_GLOB);
  context.subscriptions.push(fileSystemWatcher);
  context.subscriptions.push(fileSystemWatcher.onDidChange(reInitializeBackend));
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

  const configFiles = await vscode.workspace.findFiles(
    /* include */ DPRINT_CONFIG_FILEPATH_GLOB,
    /* exclude */ "**/node_modules/**",
    /* maxResults */ 1,
  );
  let configFileExists = configFiles.length > 0;
  if (!configFileExists) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder !== undefined) {
      const rootPath = workspaceFolder.uri.fsPath;
      configFileExists = ancestorDirectoriesContainConfigurationFile(rootPath);
    }
  }

  if (configFileExists) {
    const success = await reInitializeBackend();
    if (success) {
      logger.logInfo("Extension active!");
    } else {
      logger.logWarn("Extension failed to start.");
    }
  } else {
    logger.logInfo("Extension active!");
    logger.logInfo("Waiting for the configuration file to be created.");
  }

  async function reInitializeBackend() {
    try {
      await backend.reInitialize();
      return true;
    } catch (err) {
      logger.logError("Error initializing:", err);
      return false;
    }
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
  try {
    outputChannel = vscode.window.createOutputChannel("dprint");
    logger = new Logger(outputChannel);
    backend = isLsp()
      ? activateLsp(context, logger, outputChannel)
      : activateLegacy(context, logger, outputChannel);
  } catch (err) {
    outputChannel?.dispose();
    throw err;
  }
  globalState = new GlobalPluginState(outputChannel, logger, backend);
  return globalState;
}

async function clearGlobalState() {
  await globalState?.dispose();
  globalState = undefined;
}

function isLsp() {
  return getCombinedDprintConfig(vscode.workspace.workspaceFolders ?? []).experimentalLsp;
}

function ancestorDirectoriesContainConfigurationFile(path: string): boolean {
  for (const ancestorDirectoryPath of enumerateAncestorDirectories(path)) {
    if (directoryContainsConfigurationFile(ancestorDirectoryPath)) {
      return true;
    }
  }
  return false;

  function* enumerateAncestorDirectories(path: string): Iterable<string> {
    let currentPath = path;
    while (true) {
      const ancestorDirectoryPath = dirname(currentPath);
      if (ancestorDirectoryPath === currentPath) {
        break;
      }
      yield ancestorDirectoryPath;
      currentPath = ancestorDirectoryPath;
    }
  }

  function directoryContainsConfigurationFile(path: string): boolean {
    for (const configFileName of DPRINT_CONFIG_FILE_NAMES) {
      const configFilePath = join(path, configFileName);
      try {
        if (existsSync(configFilePath)) {
          return true;
        }
      } catch {
        // Continue to next path.
      }
    }
    return false;
  }
}
