import * as vscode from "vscode";
import { ApprovedConfigPaths } from "./ApprovedConfigPaths";
import { activateBackend } from "./backend";
import type { ReInitializeOptions } from "./BackendSwitcher";
import { AncestorConfigFileCache } from "./configPaths";
import { getConfigFilePathGlob, NOTEBOOK_CELL_SCHEME } from "./constants";
import { RealEnvironment } from "./environment";
import type { ConfigFileChangeType, ExtensionBackend } from "./ExtensionBackend";
import { canFormatWithGlobalConfig, getNotFormattedMessage, type NotFormattedReason } from "./globalConfigCommand";
import { Logger } from "./logger";
import { toPlainNotificationText } from "./workspace/approvals";

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

  // dprint starts its plugins again, which is for when one stopped responding or changed
  context.subscriptions.push(
    vscode.commands.registerCommand("dprint.restart", () => reInitializeBackend({ restart: true })),
  );
  context.subscriptions.push(vscode.commands.registerCommand("dprint.approve", async () => {
    try {
      await backend.approve();
    } catch (err) {
      logger.logError("Error approving:", err);
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("dprint.showDecisions", async () => {
    try {
      await backend.showDecisions();
    } catch (err) {
      logger.logError("Error showing the approval decisions:", err);
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("dprint.forgetDecisions", async () => {
    try {
      await backend.forgetDecisions();
    } catch (err) {
      logger.logError("Error forgetting the approval decisions:", err);
    }
  }));
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
  // for an older dprint, which reads a symlinked config file anyway
  const followingAncestorConfigFileCache = new AncestorConfigFileCache(environment, { followSymlinks: true });
  let canFormatWithGlobalConfigUpdateId = 0;
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateCanFormatWithGlobalConfig));
  // config files outside the workspace aren't watched, so check again after the user comes back to the window
  context.subscriptions.push(vscode.window.onDidChangeWindowState(state => {
    if (state.focused) {
      onConfigFilesMaybeChanged();
    }
  }));
  if (backend.onDidChangeConfig != null) {
    context.subscriptions.push(backend.onDidChangeConfig(updateCanFormatWithGlobalConfig));
  }
  updateCanFormatWithGlobalConfig();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => reInitializeBackend()));
  // untitled documents are formatted as a file in the first workspace folder
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(updateCanFormatWithGlobalConfig));

  // reinitialize when a configuration file is created or deleted and let the backend handle changes (the
  // watcher uses the extension's names rather than dprint's `configFileGlobs`, because it starts before dprint does)
  const fileSystemWatcher = vscode.workspace.createFileSystemWatcher(getConfigFilePathGlob(process.platform));
  context.subscriptions.push(fileSystemWatcher);
  const onConfigFileChanged = async (uri: vscode.Uri, type: ConfigFileChangeType) => {
    try {
      await backend.onConfigFileChanged(uri, type);
    } catch (err) {
      logger.logError("Error handling configuration file change:", err);
    }
  };
  context.subscriptions.push(fileSystemWatcher.onDidChange(uri => onConfigFileChanged(uri, "changed")));
  context.subscriptions.push(fileSystemWatcher.onDidCreate(async uri => {
    await onConfigFileChanged(uri, "created");
    await reInitializeBackend();
  }));
  context.subscriptions.push(fileSystemWatcher.onDidDelete(async uri => {
    await onConfigFileChanged(uri, "deleted");
    await reInitializeBackend();
  }));
  context.subscriptions.push(fileSystemWatcher.onDidCreate(onConfigFilesMaybeChanged));
  context.subscriptions.push(fileSystemWatcher.onDidDelete(onConfigFilesMaybeChanged));

  // reinitialize when the vscode configuration changes
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async evt => {
    if (backend.affectsInitialization(evt)) {
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

  async function reInitializeBackend(options?: ReInitializeOptions) {
    try {
      await backend.reInitialize(options);
      return true;
    } catch (err) {
      logger.logError("Error initializing:", err);
      return false;
    }
  }

  function onConfigFilesMaybeChanged() {
    ancestorConfigFileCache.clear();
    followingAncestorConfigFileCache.clear();
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
  async function canFormatDocumentWithGlobalConfig(document: vscode.TextDocument | undefined) {
    if (document == null) {
      return false;
    }
    // dprint knows which config file it formats the document with
    const canFormat = await backend.canFormatWithGlobalConfig(document);
    if (canFormat != null) {
      return canFormat;
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
      findAncestorConfigFile: dirPath =>
        (backend.followsConfigFileSymlinks ? followingAncestorConfigFileCache : ancestorConfigFileCache).find(dirPath),
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
        showNotFormattedMessage(result.notFormattedReason, result.notFormattedMessage);
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

  function showNotFormattedMessage(reason: NotFormattedReason, message = getNotFormattedMessage(reason)) {
    // it may be dprint's message, which has text from a config file
    const text = toPlainNotificationText(message);
    if (reason !== "failed") {
      vscode.window.showInformationMessage(text);
      return;
    }
    // the details were logged
    const buttonText = "Go to output";
    vscode.window.showWarningMessage(text, buttonText).then(selection => {
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
    // The extension formats using the `dprint/*` methods of dprint's language server
    // (`dprint lsp`) for editor extensions, or dprint's editor service (`dprint editor-service`)
    // for older versions of dprint. It doesn't use a language client because:
    // - The text document methods need a copy of every open document that's kept up to
    //   date as the user types, whereas the `dprint/*` methods are only sent a document's
    //   text when formatting it.
    // - What the extension does on top of formatting (ex. only being a formatter for the
    //   files of folders with a config file, untitled documents, notebook cells, the global
    //   config file, and asking the user to approve what a config file needs) is done with
    //   vscode's api.
    // - A language client is much larger than the JSON-RPC connection it's built on.
    backend = activateBackend(logger, approvedPaths, context);
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
