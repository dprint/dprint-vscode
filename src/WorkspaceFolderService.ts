import * as vscode from "vscode";
import { createEditorService, EditorService } from "./editor-service";
import { DprintExecutable, EditorInfo } from "./executable";
import { Logger, Notifier } from "./logger";
import { ObjectDisposedError } from "./utils";

export interface WorkspaceServiceOptions {
  folder: vscode.WorkspaceFolder;
  outputChannel: vscode.OutputChannel;
}

export class WorkspaceFolderService implements vscode.DocumentFormattingEditProvider {
  readonly #logger: Logger;
  readonly #folder: vscode.WorkspaceFolder;
  #notifier: Notifier;
  #disposed = false;

  #editorService: EditorService | undefined;
  #editorInfo: EditorInfo | undefined;

  constructor(opts: WorkspaceServiceOptions) {
    this.#logger = new Logger(opts.outputChannel);
    this.#folder = opts.folder;
    this.#notifier = new Notifier(opts.outputChannel, this.#logger);
  }

  get folder() {
    return this.#folder;
  }

  dispose() {
    this.#setEditorService(undefined);
    this.#disposed = true;
  }

  #assertNotDisposed() {
    if (this.#disposed) {
      throw new ObjectDisposedError();
    }
  }

  getEditorInfo(): Readonly<EditorInfo> | undefined {
    return this.#editorInfo;
  }

  async initialize() {
    this.#assertNotDisposed();
    const config = this.#getConfig();
    this.#logger.setVerbose(config.verbose);
    this.#setEditorService(undefined);
    const dprintExe = this.#getDprintExecutable();
    const isInstalled = await dprintExe.checkInstalled();
    this.#assertNotDisposed();
    if (!isInstalled) {
      this.#notifier.showErrorMessageNotification(
        `Error initializing dprint. Ensure it is globally installed on the path (see https://dprint.dev/install) `
          + `or specify a "dprint.path" setting to the executable.`,
      );
      return false;
    }

    try {
      const editorInfo = await dprintExe.getEditorInfo();
      this.#assertNotDisposed();
      this.#editorInfo = editorInfo;
      this.#notifier.enableNotifications(editorInfo.plugins.length > 0);

      // don't start up if there's no plugins
      if (editorInfo.plugins.length === 0) {
        return false;
      }

      this.#setEditorService(createEditorService(editorInfo.schemaVersion, this.#logger, dprintExe));

      this.#logger.logInfo(
        `Initialized dprint ${editorInfo.cliVersion}\n`
          + `  Folder: ${dprintExe.workspaceFolder}\n`
          + `  Command: ${dprintExe.cmdPath}`,
      );
      return true;
    } catch (err) {
      // clear
      this.#setEditorService(undefined);
      this.#editorInfo = undefined;

      if (err instanceof ObjectDisposedError) {
        throw err;
      }

      this.#notifier.showErrorMessageNotification(`Error initializing dprint. ${err}`);
      this.#notifier.logErrorAndFocus(`Error initializing in ${dprintExe.workspaceFolder}:`, err);
      return false;
    }
  }

  async provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    _options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ) {
    if (this.#editorInfo != null && this.#editorInfo.plugins.length === 0) {
      return undefined;
    }

    try {
      if (this.#editorService == null) {
        this.#logger.logWarn("Editor service not ready on format request.");
        return []; // not ready yet
      }

      if (!(await this.#editorService.canFormat(document.fileName))) {
        this.#logger.logVerbose("File not matched:", document.fileName);
        return [];
      }

      const newText = await this.#editorService.formatText(document.fileName, document.getText(), token);
      const lastLineNumber = document.lineCount - 1;
      const replaceRange = new vscode.Range(
        0,
        0,
        lastLineNumber,
        document.lineAt(lastLineNumber).text.length,
      );
      const result = [vscode.TextEdit.replace(replaceRange, newText)];
      this.#logger.logVerbose("Formatted:", document.fileName);
      return result;
    } catch (err: any) {
      this.#logger.logError("Error formatting text.", err);
      return [];
    }
  }

  #setEditorService(newService: EditorService | undefined) {
    this.#editorService?.kill();
    this.#editorService = newService;
  }

  #getDprintExecutable() {
    const config = this.#getConfig();
    return new DprintExecutable(this.#logger, {
      cmdPath: config.path,
      workspaceFolder: this.#folder.uri.fsPath,
      verbose: config.verbose,
    });
  }

  #getConfig() {
    const config = vscode.workspace.getConfiguration("dprint", this.#folder);
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
