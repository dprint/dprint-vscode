import * as vscode from "vscode";
import type { ApprovedConfigPaths } from "../ApprovedConfigPaths";
import { getDprintConfig } from "../config";
import { type Environment, RealEnvironment } from "../environment";
import { DprintExecutable, type EditorInfo } from "../executable/DprintExecutable";
import { Logger } from "../logger";
import { ObjectDisposedError } from "../utils";
import { createEditorService, type EditorService } from "./editor-service";
import { getUtf8ByteRange } from "./editor-service/byteRange";
import { expandToLines, getRangeFormatEdit } from "./rangeFormat";

export interface FolderServiceOptions {
  approvedPaths: ApprovedConfigPaths;
  scopeUri: vscode.Uri;
  cwd: vscode.Uri;
  configUri: vscode.Uri | undefined;
  configDiscovery?: "global";
  resolveNpmExecutable?: boolean;
  logger: Logger;
}

/** Represents an instance of dprint for a single workspace folder */
export class FolderService implements vscode.DocumentFormattingEditProvider {
  readonly #approvedPaths: ApprovedConfigPaths;
  readonly #logger: Logger;
  readonly #environment: Environment;
  readonly #scopeUri: vscode.Uri;
  readonly #cwd: vscode.Uri;
  readonly #configUri: vscode.Uri | undefined;
  readonly #configDiscovery: "global" | undefined;
  readonly #resolveNpmExecutable: boolean;
  #disposed = false;

  #editorService: EditorService | undefined;
  #editorInfo: EditorInfo | undefined;

  constructor(opts: FolderServiceOptions) {
    this.#approvedPaths = opts.approvedPaths;
    this.#logger = opts.logger;
    this.#scopeUri = opts.scopeUri;
    this.#cwd = opts.cwd;
    this.#configUri = opts.configUri;
    this.#configDiscovery = opts.configDiscovery;
    this.#resolveNpmExecutable = opts.resolveNpmExecutable ?? true;
    this.#environment = new RealEnvironment(this.#logger);
  }

  get uri() {
    if (this.#configUri != null) {
      return vscode.Uri.joinPath(this.#configUri, "../");
    }
    return this.#scopeUri;
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

  provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    _options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ) {
    return this.#formatDocument(document, undefined, token);
  }

  provideDocumentRangeFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range,
    _options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ) {
    return this.#formatDocument(document, range, token);
  }

  async #formatDocument(
    document: vscode.TextDocument,
    range: vscode.Range | undefined,
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
        this.#logger.logDebug("Response - File not matched:", document.fileName);
        return undefined;
      }

      const fileText = document.getText();
      const offsetRange = range == null
        ? undefined
        : expandToLines(fileText, { start: document.offsetAt(range.start), end: document.offsetAt(range.end) });
      const byteRange = offsetRange == null
        ? undefined
        : getUtf8ByteRange(fileText, offsetRange.start, offsetRange.end);
      const newText = await this.#editorService.formatText(document.fileName, fileText, byteRange, token);
      if (newText == null) {
        this.#logger.logDebug("Response - Formatted (No change):", document.fileName);
        return [];
      }

      if (offsetRange != null) {
        const edit = getRangeFormatEdit(fileText, newText, offsetRange);
        if (edit == null) {
          this.#logger.logDebug("Response - Ignored range format with changes outside the range:", document.fileName);
          return [];
        }
        const editRange = new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end));
        this.#logger.logDebug("Response - Formatted range:", document.fileName);
        return [vscode.TextEdit.replace(editRange, edit.newText)];
      }

      const lastLineNumber = document.lineCount - 1;
      const replaceRange = new vscode.Range(0, 0, lastLineNumber, document.lineAt(lastLineNumber).text.length);
      const result = [vscode.TextEdit.replace(replaceRange, newText)];
      this.#logger.logDebug("Response - Formatted:", document.fileName);
      return result;
    } catch (err: any) {
      this.#logger.logError("Error formatting text.", err);
      return [];
    }
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
      // It's important that workspace services use the workspace folder as the
      // cwd for the process instead of possibly the sub directory because
      // we don't want the dprint process to hold a resource lock on a
      // sub directory. That would give the user a bad experience where
      // they can't delete the sub directory.
      cwd: this.#cwd,
      configUri: this.#configUri,
      configDiscovery: this.#configDiscovery,
      resolveNpmExecutable: this.#resolveNpmExecutable,
      verbose: config.verbose,
      logger: this.#logger,
      environment: this.#environment,
    });
  }

  #getConfig() {
    return getDprintConfig(this.uri);
  }

  #logErrorAndMaybeNotify(notificationMessage: string, message: string, ...args: any[]) {
    if (this.#configUri == null) {
      // only log... don't annoy people with notifications in this case
      this.#logger.logError(message, ...args);
    } else {
      this.#logger.logErrorAndNotify(notificationMessage, message, ...args);
    }
  }
}
