import * as path from "node:path";
import * as vscode from "vscode";
import { ApprovedConfigPaths } from "./ApprovedConfigPaths";
import { getCombinedDprintConfig, getDprintConfig } from "./config";
import { AncestorConfigFileCache } from "./configPaths";
import { DPRINT_CONFIG_FILEPATH_GLOB, FILE_SCHEME } from "./constants";
import { RealEnvironment } from "./environment";
import type { ExtensionBackend } from "./ExtensionBackend";
import { activateLegacy } from "./legacy/context";
import { Logger } from "./logger";
import { activateLsp } from "./lsp";

/** The context key for if the commands to format using the global config file are shown. */
const CAN_FORMAT_WITH_GLOBAL_CONFIG_CONTEXT_KEY = "dprint.canFormatWithGlobalConfig";

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

  // reinitialize on workspace folder changes
  context.subscriptions.push(vscode.commands.registerCommand("dprint.restart", reInitializeBackend));
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dprint.formatWithGlobalConfig",
      () => formatWithGlobalConfig({ selection: false }),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dprint.formatSelectionWithGlobalConfig",
      () => formatWithGlobalConfig({ selection: true }),
    ),
  );

  // only show the commands to format using the global config file for files it would be used for
  // cached so that changing the active editor doesn't always hit the file system
  const ancestorConfigFileCache = new AncestorConfigFileCache(new RealEnvironment(logger));
  let canFormatWithGlobalConfigUpdateId = 0;
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateCanFormatWithGlobalConfig));
  // config files outside the workspace aren't watched, so check again after the user comes back to the window
  context.subscriptions.push(vscode.window.onDidChangeWindowState(state => {
    if (state.focused) {
      onConfigFilesMaybeChanged();
    }
  }));
  updateCanFormatWithGlobalConfig();
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
  context.subscriptions.push(fileSystemWatcher.onDidCreate(onConfigFilesMaybeChanged));
  context.subscriptions.push(fileSystemWatcher.onDidDelete(onConfigFilesMaybeChanged));

  // reinitialize when the vscode configuration changes
  let hasShownLspWarning = false;
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async evt => {
    if (evt.affectsConfiguration("dprint")) {
      updateCanFormatWithGlobalConfig();
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
    try {
      await backend.reInitialize();
      return true;
    } catch (err) {
      logger.logError("Error initializing:", err);
      return false;
    }
  }

  function onConfigFilesMaybeChanged() {
    ancestorConfigFileCache.clear();
    updateCanFormatWithGlobalConfig();
  }

  async function updateCanFormatWithGlobalConfig() {
    const updateId = ++canFormatWithGlobalConfigUpdateId;
    let value = false;
    try {
      value = await canFormatWithGlobalConfig(vscode.window.activeTextEditor?.document);
    } catch (err) {
      logger.logError("Error checking if a document may be formatted with the global configuration file:", err);
    }
    // ignore when superseded by a newer update
    if (updateId === canFormatWithGlobalConfigUpdateId) {
      await vscode.commands.executeCommand("setContext", CAN_FORMAT_WITH_GLOBAL_CONFIG_CONTEXT_KEY, value);
    }
  }

  /**
   * Gets if the command would format the document using the global config file, which is
   * when the document has no config file in an ancestor directory. It's not necessary
   * when the user enabled always using the global config file.
   */
  async function canFormatWithGlobalConfig(document: vscode.TextDocument | undefined) {
    if (document == null || document.uri.scheme !== FILE_SCHEME || getDprintConfig(document.uri).useGlobalConfig) {
      return false;
    }
    const dirPath = path.dirname(document.uri.fsPath);
    return await ancestorConfigFileCache.find(dirPath) == null;
  }

  /** Formats the active document or its selection using the global config file. */
  async function formatWithGlobalConfig(opts: { selection: boolean }) {
    const editor = vscode.window.activeTextEditor;
    if (editor == null || opts.selection && editor.selection.isEmpty) {
      return;
    }
    const range = opts.selection ? editor.selection : undefined;
    const tokenSource = new vscode.CancellationTokenSource();
    try {
      const document = editor.document;
      const version = document.version;
      const options: vscode.FormattingOptions = {
        tabSize: typeof editor.options.tabSize === "number" ? editor.options.tabSize : 4,
        insertSpaces: editor.options.insertSpaces !== false,
      };
      const edits = await backend.provideGlobalConfigFormattingEdits(document, range, options, tokenSource.token);
      // the edits don't apply to the document anymore when it changed while formatting
      if (edits == null || edits.length === 0 || document.version !== version) {
        return;
      }
      const workspaceEdit = new vscode.WorkspaceEdit();
      workspaceEdit.set(document.uri, edits);
      await vscode.workspace.applyEdit(workspaceEdit);
    } catch (err) {
      logger.logError("Error formatting with the global configuration file:", err);
    } finally {
      tokenSource.dispose();
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
    const approvedPaths = new ApprovedConfigPaths(context);
    backend = isLsp()
      ? activateLsp(logger, approvedPaths)
      : activateLegacy(logger, approvedPaths);
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
