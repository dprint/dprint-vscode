import * as vscode from "vscode";
import type { ApprovedConfigPaths } from "../ApprovedConfigPaths";
import { getDprintConfig } from "../config";
import { type Environment, RealEnvironment } from "../environment";
import { type ConfigDiscovery, DprintExecutable, type EditorInfo } from "../executable/DprintExecutable";
import { Logger } from "../logger";
import { hasPluginForFile } from "../pluginFiles";
import { ObjectDisposedError } from "../utils";
import { createEditorService, type EditorService } from "./editor-service";
import { getUtf8ByteRange } from "./editor-service/byteRange";
import { expandToLines, getRangeFormatEdit } from "./rangeFormat";

export interface FolderServiceOptions {
  approvedPaths: ApprovedConfigPaths;
  /** Directory to run dprint in. */
  cwd: vscode.Uri;
  configUri: vscode.Uri | undefined;
  /** Whether to use a dprint executable found in node_modules. Defaults to true. */
  resolveNpmExecutable?: boolean;
  /** The cli's config discovery mode. Defaults to the cli's default. */
  configDiscovery?: ConfigDiscovery;
  /** Whether to show a notification on errors. Defaults to only when there's a config file. */
  notifyOnError?: boolean;
  logger: Logger;
}

/** The file dprint formats a document as. */
export interface FormatFile {
  /**
   * The file path to format the document's text as, which differs from the document's
   * for documents that aren't on the file system (ex. untitled documents and notebook cells).
   */
  filePath: string;
  /** The notebook file's path when the document is a notebook cell. */
  notebookPath?: string;
}

/** Represents an instance of dprint for a single directory. */
export class FolderService implements vscode.DocumentFormattingEditProvider {
  readonly #approvedPaths: ApprovedConfigPaths;
  readonly #logger: Logger;
  readonly #environment: Environment;
  readonly #cwd: vscode.Uri;
  readonly #configUri: vscode.Uri | undefined;
  readonly #resolveNpmExecutable: boolean;
  readonly #configDiscovery: ConfigDiscovery | undefined;
  readonly #notifyOnError: boolean;
  #disposed = false;

  #editorService: EditorService | undefined;
  #editorInfo: EditorInfo | undefined;
  #dprintExecutable: DprintExecutable | undefined;

  constructor(opts: FolderServiceOptions) {
    this.#approvedPaths = opts.approvedPaths;
    this.#logger = opts.logger;
    this.#cwd = opts.cwd;
    this.#configUri = opts.configUri;
    this.#resolveNpmExecutable = opts.resolveNpmExecutable ?? true;
    this.#configDiscovery = opts.configDiscovery;
    this.#notifyOnError = opts.notifyOnError ?? opts.configUri != null;
    this.#environment = new RealEnvironment(this.#logger);
  }

  get uri() {
    if (this.#configUri != null) {
      return vscode.Uri.joinPath(this.#configUri, "../");
    }
    return this.#cwd;
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
    this.#logger.setDebug(config.verbose);
    this.#setEditorService(undefined);
    this.#dprintExecutable = undefined;

    const dprintExe = await this.#getDprintExecutable();
    const isInstalled = await dprintExe.checkInstalled();
    this.#assertNotDisposed();
    if (!isInstalled) {
      this.#logErrorAndMaybeNotify(
        "Failed initializing dprint.",
        `Error initializing dprint. Ensure it is globally installed on the path (see https://dprint.dev/install) `
          + `or specify a "dprint.path" setting to the executable.`,
      );
      return false;
    }

    try {
      const editorInfo = await dprintExe.getEditorInfo();
      this.#assertNotDisposed();
      this.#editorInfo = editorInfo;

      // don't start up if there's no plugins
      if (editorInfo.plugins.length === 0) {
        return false;
      }

      this.#setEditorService(createEditorService(editorInfo.schemaVersion, this.#logger, dprintExe));
      this.#dprintExecutable = dprintExe;
      this.#logger.logInfo(
        `Initialized dprint ${editorInfo.cliVersion}\n`
          + `  Folder: ${dprintExe.initializationFolderUri.fsPath}\n`
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

      this.#logErrorAndMaybeNotify(
        "Failed initializing dprint.",
        `Error initializing in ${dprintExe.initializationFolderUri.fsPath}:`,
        err,
      );
      return false;
    }
  }

  /** Gets if dprint was started for this folder (it may have exited since and will restart on demand). */
  isRunning() {
    return this.#editorService != null;
  }

  /**
   * Refreshes the plugin information (ex. after the config file changed) without
   * restarting dprint since the running editor service reloads its config itself.
   * Returns false when it's not running or refreshing failed.
   */
  async refreshEditorInfo() {
    if (this.#dprintExecutable == null || this.#editorService == null) {
      return false;
    }
    try {
      const editorInfo = await this.#dprintExecutable.getEditorInfo();
      if (!this.#disposed) {
        this.#editorInfo = editorInfo;
      }
      return true;
    } catch (err) {
      this.#logger.logError("Error refreshing the plugin information:", err);
      return false;
    }
  }

  /** Gets if one of the plugins handles the file based on its file name or extension. */
  hasPluginForFile(filePath: string) {
    return hasPluginForFile(this.#editorInfo?.plugins ?? [], filePath);
  }

  /**
   * Gets if a plugin can format the file. This is stricter than the cli's check,
   * which only checks the config's includes and excludes.
   */
  async canFormatWithPlugin(filePath: string) {
    if (this.#editorService == null || !this.hasPluginForFile(filePath)) {
      return false;
    }
    try {
      return await this.#editorService.canFormat(filePath);
    } catch (err) {
      this.#logger.logError("Error checking if the file can be formatted.", err);
      return false;
    }
  }

  /**
   * Formats the document. The file defaults to the document's and is provided for
   * documents that aren't on the file system (ex. untitled documents).
   */
  provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    _options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
    file: FormatFile = { filePath: document.fileName },
  ) {
    return this.#formatDocument(document, file, undefined, token);
  }

  provideDocumentRangeFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range,
    _options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
    file: FormatFile = { filePath: document.fileName },
  ) {
    return this.#formatDocument(document, file, range, token);
  }

  async #formatDocument(
    document: vscode.TextDocument,
    file: FormatFile,
    range: vscode.Range | undefined,
    token: vscode.CancellationToken,
  ) {
    const filePath = file.filePath;
    if (this.#editorInfo != null && this.#editorInfo.plugins.length === 0) {
      return undefined;
    }

    try {
      if (this.#editorService == null) {
        this.#logger.logWarn("Editor service not ready on format request.");
        return []; // not ready yet
      }

      if (!(await this.#canFormatFile(this.#editorService, file))) {
        this.#logger.logDebug("Response - File not matched:", filePath);
        return undefined;
      }

      const fileText = document.getText();
      const offsetRange = range == null
        ? undefined
        : expandToLines(fileText, { start: document.offsetAt(range.start), end: document.offsetAt(range.end) });
      const byteRange = offsetRange == null
        ? undefined
        : getUtf8ByteRange(fileText, offsetRange.start, offsetRange.end);
      let newText = await this.#editorService.formatText(filePath, fileText, byteRange, token);
      if (newText != null && file.notebookPath != null) {
        // many plugins add a final newline, which doesn't look nice in a notebook
        // cell, so trim it off like the jupyter plugin does
        newText = newText.trimEnd();
        if (newText === fileText) {
          newText = undefined;
        }
      }
      if (newText == null) {
        this.#logger.logDebug("Response - Formatted (No change):", filePath);
        return [];
      }

      if (offsetRange != null) {
        const edit = getRangeFormatEdit(fileText, newText, offsetRange);
        if (edit == null) {
          this.#logger.logDebug("Response - Ignored range format with changes outside the range:", filePath);
          return [];
        }
        const editRange = new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end));
        this.#logger.logDebug("Response - Formatted range:", filePath);
        return [vscode.TextEdit.replace(editRange, edit.newText)];
      }

      const lastLineNumber = document.lineCount - 1;
      const replaceRange = new vscode.Range(0, 0, lastLineNumber, document.lineAt(lastLineNumber).text.length);
      const result = [vscode.TextEdit.replace(replaceRange, newText)];
      this.#logger.logDebug("Response - Formatted:", filePath);
      return result;
    } catch (err: any) {
      this.#logger.logError("Error formatting text.", err);
      return [];
    }
  }

  async #canFormatFile(editorService: EditorService, file: FormatFile) {
    if (file.notebookPath == null) {
      return await editorService.canFormat(file.filePath);
    }
    // The cli formats a notebook's cells when a plugin (the jupyter plugin) formats
    // the notebook, so only format a cell when the notebook would be formatted.
    return this.hasPluginForFile(file.notebookPath)
      && this.hasPluginForFile(file.filePath)
      && await editorService.canFormat(file.notebookPath);
  }

  #setEditorService(newService: EditorService | undefined) {
    this.#editorService?.killAndDispose();
    this.#editorService = newService;
  }

  #getDprintExecutable() {
    const config = this.#getConfig();
    return DprintExecutable.create({
      approvedPaths: this.#approvedPaths,
      pathInfo: config.pathInfo,
      cwd: this.#cwd,
      configUri: this.#configUri,
      resolveNpmExecutable: this.#resolveNpmExecutable,
      // search from the config file's directory so that a project in a sub directory
      // uses the dprint installed in its own node_modules folder
      npmSearchDir: this.uri,
      configDiscovery: this.#configDiscovery,
      ensureStableFormat: config.ensureStableFormat,
      verbose: config.verbose,
      logger: this.#logger,
      environment: this.#environment,
    });
  }

  #getConfig() {
    return getDprintConfig(this.uri);
  }

  #logErrorAndMaybeNotify(notificationMessage: string, message: string, ...args: any[]) {
    if (!this.#notifyOnError) {
      // only log... don't annoy people with notifications in this case
      this.#logger.logError(message, ...args);
    } else {
      this.#logger.logErrorAndNotify(notificationMessage, message, ...args);
    }
  }
}
