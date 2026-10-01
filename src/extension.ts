import * as vscode from "vscode";
import { ApprovedConfigPaths } from "./ApprovedConfigPaths";
import { AncestorConfigFileCache } from "./configPaths";
import { DPRINT_CONFIG_FILEPATH_GLOB, NOTEBOOK_CELL_SCHEME } from "./constants";
import { RealEnvironment } from "./environment";
import type { ExtensionBackend } from "./ExtensionBackend";
import { canFormatWithGlobalConfig, getNotFormattedMessage, type NotFormattedReason } from "./globalConfigCommand";
import { activateLegacy } from "./legacy/context";
import { Logger } from "./logger";

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
  const environment = new RealEnvironment(logger);
  const ancestorConfigFileCache = new AncestorConfigFileCache(environment);
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
  // untitled documents are formatted as a file in the first workspace folder
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(updateCanFormatWithGlobalConfig));

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
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async evt => {
    if (evt.affectsConfiguration("dprint")) {
      await reInitializeBackend();
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
      value = await canFormatDocumentWithGlobalConfig(vscode.window.activeTextEditor?.document);
    } catch (err) {
      logger.logError("Error checking if a document may be formatted with the global configuration file:", err);
    }
    // ignore when superseded by a newer update
    if (updateId === canFormatWithGlobalConfigUpdateId) {
      await vscode.commands.executeCommand("setContext", CAN_FORMAT_WITH_GLOBAL_CONFIG_CONTEXT_KEY, value);
    }
  }

  /** Gets if the command would format the document using the global config file. */
  function canFormatDocumentWithGlobalConfig(document: vscode.TextDocument | undefined) {
    if (document == null) {
      return false;
    }
    const notebook = document.uri.scheme === NOTEBOOK_CELL_SCHEME
      ? vscode.workspace.notebookDocuments.find(notebook => notebook.getCells().some(c => c.document === document))
      : undefined;
    return canFormatWithGlobalConfig({
      scheme: document.uri.scheme,
      fsPath: document.uri.fsPath,
      notebook: notebook == null ? undefined : { scheme: notebook.uri.scheme, fsPath: notebook.uri.fsPath },
    }, {
      untitledDirPath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? environment.homeDir(),
      isRemote: vscode.env.remoteName != null,
      findAncestorConfigFile: dirPath => ancestorConfigFileCache.find(dirPath),
    });
  }

  /**
   * Formats the active document or its selection using the global config file. The user
   * explicitly ran the command, so this always says why when the document wasn't formatted
   * except for when it's already formatted.
   */
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
      const result = await backend.provideGlobalConfigFormattingEdits(document, range, options, tokenSource.token);
      if (result.edits == null) {
        showNotFormattedMessage(result.notFormattedReason);
        return;
      }
      // the edits don't apply to the document anymore when it changed while formatting
      if (result.edits.length === 0 || document.version !== version) {
        return;
      }
      const workspaceEdit = new vscode.WorkspaceEdit();
      workspaceEdit.set(document.uri, result.edits);
      if (!(await vscode.workspace.applyEdit(workspaceEdit))) {
        logger.logError("Failed applying the edits of formatting with the global configuration file.");
        showNotFormattedMessage("failed");
      }
    } catch (err) {
      logger.logError("Error formatting with the global configuration file:", err);
      showNotFormattedMessage("failed");
    } finally {
      tokenSource.dispose();
    }
  }

  function showNotFormattedMessage(reason: NotFormattedReason) {
    const message = getNotFormattedMessage(reason);
    if (reason !== "failed") {
      vscode.window.showInformationMessage(message);
      return;
    }
    // the details were logged
    const buttonText = "Go to output";
    vscode.window.showWarningMessage(message, buttonText).then(selection => {
      if (selection === buttonText) {
        globalState.outputChannel.show();
      }
    });
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
    // The extension formats using dprint's editor service (`dprint editor-service`). There
    // used to be an experimental backend that used dprint's language server (`dprint lsp`)
    // instead, but it was removed because a language server isn't a good fit here:
    // - It needs a copy of every open document that's kept up to date as the user types
    //   because a format request doesn't have the document's text, whereas the editor
    //   service is only sent a document's text when formatting it.
    // - What the extension does on top of formatting (ex. a dprint process per config
    //   file, only being a formatter for the files of folders with a config file, untitled
    //   documents, notebook cells, and the global config file) is done with vscode's api,
    //   so the language server needed its own way of doing each of those.
    // - It required bundling a language client, which made the extension much larger.
    backend = activateLegacy(logger, approvedPaths);
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
