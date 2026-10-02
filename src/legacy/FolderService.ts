import * as vscode from "vscode";
import type { ApprovedConfigPaths } from "../ApprovedConfigPaths";
import { getDprintConfig } from "../config";
import { type Environment, RealEnvironment } from "../environment";
import { type ConfigDiscovery, DprintExecutable, type EditorInfo } from "../executable/DprintExecutable";
import type { FormatDocumentResult } from "../ExtensionBackend";
import { Logger } from "../logger";
import { hasPluginForFile } from "../pluginFiles";
import { ObjectDisposedError } from "../utils";
import { createEditorService, type EditorService } from "./editor-service";
import { getUtf8ByteRange } from "./editor-service/byteRange";
import { type FormatFile, getCannotFormatReason } from "./formatFile";
import { getMinimalEdits } from "./minimalEdits";
import { trimFormattedCellText } from "./notebookCellText";
import { expandToLines, getRangeFormatEdit, isNoChangeEdit } from "./rangeFormat";

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

    try {
      // resolving the executable may fail (ex. a command in the "dprint.path" setting fails)
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
        `Error initializing in ${this.uri.fsPath}:`,
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
   * documents that aren't on the file system (ex. untitled documents and notebook cells).
   */
  async provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    _options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
    file: FormatFile = { filePath: document.fileName },
  ) {
    return getProviderEdits(await this.formatDocument(document, file, undefined, token));
  }

  async provideDocumentRangeFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range,
    _options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
    file: FormatFile = { filePath: document.fileName },
  ) {
    return getProviderEdits(await this.formatDocument(document, file, range, token));
  }

  /**
   * Formats the document, or only the range when provided, as the file. Unlike the formatting
   * provider methods, this says why the document wasn't formatted when that's the case.
   */
  async formatDocument(
    document: vscode.TextDocument,
    file: FormatFile,
    range: vscode.Range | undefined,
    token: vscode.CancellationToken,
  ): Promise<FormatDocumentResult> {
    const filePath = file.filePath;
    if (this.#editorInfo != null && this.#editorInfo.plugins.length === 0) {
      return { notFormattedReason: "noPlugins" };
    }

    try {
      if (this.#editorService == null) {
        this.#logger.logWarn("Editor service not ready on format request.");
        return { notFormattedReason: "failed" }; // not ready yet
      }

      const editorService = this.#editorService;
      const cannotFormatReason = await getCannotFormatReason(file, {
        hasPluginForFile: filePath => this.hasPluginForFile(filePath),
        canFormat: filePath => editorService.canFormat(filePath),
      });
      if (cannotFormatReason != null) {
        this.#logger.logDebug(
          cannotFormatReason === "notMatched" ? "Response - File not matched:" : "Response - No plugin for the cell:",
          filePath,
        );
        return { notFormattedReason: cannotFormatReason };
      }

      const fileText = document.getText();
      const offsetRange = range == null
        ? undefined
        : expandToLines(fileText, { start: document.offsetAt(range.start), end: document.offsetAt(range.end) });
      const byteRange = offsetRange == null
        ? undefined
        : getUtf8ByteRange(fileText, offsetRange.start, offsetRange.end);
      let newText = await editorService.formatText(filePath, fileText, byteRange, token);
      // The cli responds the same way for a file that's already formatted as for one without a
      // plugin. A file without a plugin based on its name may still have been formatted because
      // of the config's associations or shebangs, which aren't known here, so this reason says that.
      if (newText == null && !this.hasPluginForFile(filePath)) {
        this.#logger.logDebug("Response - No change and no plugin for the file name:", filePath);
        return { notFormattedReason: "noPlugin" };
      }
      if (newText != null && file.notebookPath != null) {
        newText = trimFormattedCellText(fileText, newText, offsetRange);
        if (newText === fileText) {
          newText = undefined;
        }
      }
      if (newText == null) {
        this.#logger.logDebug("Response - Formatted (No change):", filePath);
        return { edits: [] };
      }

      if (offsetRange != null) {
        const edit = getRangeFormatEdit(fileText, newText, offsetRange);
        if (edit == null) {
          this.#logger.logDebug("Response - Ignored range format with changes outside the range:", filePath);
          return { edits: [] };
        }
        if (isNoChangeEdit(fileText, edit)) {
          this.#logger.logDebug("Response - Formatted (No change):", filePath);
          return { edits: [] };
        }
        const editRange = new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end));
        this.#logger.logDebug("Response - Formatted range:", filePath);
        return { edits: [vscode.TextEdit.replace(editRange, edit.newText)] };
      }

      // only edit what changed instead of replacing the whole document in order
      // to keep the cursors, selections, and folded regions in place
      const edits = getMinimalEdits(fileText, newText).map(edit =>
        vscode.TextEdit.replace(
          new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
          edit.newText,
        )
      );
      if (edits.length === 0) {
        this.#logger.logDebug("Response - Formatted (No change):", filePath);
        return { edits };
      }
      this.#logger.logDebug("Response - Formatted:", filePath);
      return { edits };
    } catch (err: any) {
      this.#logger.logError("Error formatting text.", err);
      return { notFormattedReason: "failed" };
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

/**
 * Gets what a formatting provider returns for the result, which is no edits
 * when formatting failed and undefined when dprint doesn't format the file.
 */
function getProviderEdits(result: FormatDocumentResult) {
  if (result.edits != null) {
    return result.edits;
  }
  return result.notFormattedReason === "failed" ? [] : undefined;
}
