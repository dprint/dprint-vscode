import * as vscode from "vscode";
import type { ApprovedConfigPaths } from "../ApprovedConfigPaths";
import { ancestorDirsContainConfigFile, discoverWorkspaceConfigFiles } from "../configFile";
import { isPathWithin, resolveLooseFolderCwd } from "../configPaths";
import { type Environment, RealEnvironment } from "../environment";
import type { EditorInfo } from "../executable/DprintExecutable";
import { Logger } from "../logger";
import { ObjectDisposedError } from "../utils";
import { FolderService } from "./FolderService";

export type FolderInfos = ReadonlyArray<Readonly<FolderInfo>>;

export interface FolderInfo {
  uri: vscode.Uri;
  editorInfo: EditorInfo;
}

export interface WorkspaceServiceOptions {
  approvedPaths: ApprovedConfigPaths;
  logger: Logger;
}

/**
 * Handles creating dprint instances for each workspace folder and, lazily,
 * for files outside of those (ex. files outside the workspace or in a
 * workspace folder without a config file).
 */
export class WorkspaceService implements vscode.DocumentFormattingEditProvider {
  readonly #approvedPaths: ApprovedConfigPaths;
  readonly #logger: Logger;
  readonly #environment: Environment;
  readonly #folders: FolderService[] = [];
  /** Folders for files outside the workspace folders, keyed by their cwd. */
  readonly #looseFolders = new Map<string, Promise<FolderService | undefined>>();

  #disposed = false;
  #generation = 0;
  #workspaceInitialization: Promise<unknown> | undefined;
  #hasNotifiedNoConfig = false;

  constructor(opts: WorkspaceServiceOptions) {
    this.#approvedPaths = opts.approvedPaths;
    this.#logger = opts.logger;
    this.#environment = new RealEnvironment(opts.logger);
  }

  dispose() {
    this.#clearFolders();
    this.#disposed = true;
  }

  #assertNotDisposed() {
    if (this.#disposed) {
      throw new ObjectDisposedError();
    }
  }

  async provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ) {
    const folder = await this.#getFolderForDocument(document);
    if (folder == null || token.isCancellationRequested) {
      return [];
    }
    return folder.provideDocumentFormattingEdits(document, options, token);
  }

  async provideDocumentRangeFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range,
    options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ) {
    const folder = await this.#getFolderForDocument(document);
    if (folder == null || token.isCancellationRequested) {
      return [];
    }
    return folder.provideDocumentRangeFormattingEdits(document, range, options, token);
  }

  initializeFolders(): Promise<FolderInfos> {
    const initialization: Promise<FolderInfos> = this.#initializeFolders().finally(() => {
      if (this.#workspaceInitialization === initialization) {
        this.#workspaceInitialization = undefined;
      }
    });
    this.#workspaceInitialization = initialization;
    return initialization;
  }

  async #getFolderForDocument(document: vscode.TextDocument) {
    // wait for the latest workspace folder initialization so a file in one doesn't get a loose folder
    while (this.#workspaceInitialization != null) {
      await this.#workspaceInitialization.catch(() => {/* ignore */});
    }
    if (this.#disposed) {
      return undefined;
    }
    return this.#getFolderForUri(document.uri) ?? await this.#getLooseFolderForUri(document.uri);
  }

  #getFolderForUri(uri: vscode.Uri) {
    let bestMatch: FolderService | undefined;
    for (const folder of this.#folders) {
      if (isPathWithin(folder.uri.fsPath, uri.fsPath)) {
        if (bestMatch == null || isPathWithin(bestMatch.uri.fsPath, folder.uri.fsPath)) {
          bestMatch = folder;
        }
      }
    }
    return bestMatch;
  }

  /**
   * Gets a folder for a file not in a workspace folder with a config file. It uses
   * the file's closest ancestor config file or otherwise the global config file.
   */
  async #getLooseFolderForUri(uri: vscode.Uri) {
    const generation = this.#generation;
    const cwd = await resolveLooseFolderCwd(this.#environment, uri.fsPath);
    if (this.#disposed || generation !== this.#generation) {
      return undefined;
    }
    if (cwd == null) {
      this.#logger.logInfo("Configuration file not found for:", uri.fsPath);
      this.#notifyNoConfig();
      return undefined;
    }

    let folder = this.#looseFolders.get(cwd);
    if (folder == null) {
      // failures are stored too so they're not retried on every format until a restart
      folder = this.#initializeLooseFolder(cwd, generation);
      this.#looseFolders.set(cwd, folder);
    }
    return folder;
  }

  async #initializeLooseFolder(cwd: string, generation: number) {
    const folder = new FolderService({
      approvedPaths: this.#approvedPaths,
      cwd: vscode.Uri.file(cwd),
      configUri: undefined,
      // don't run executables from arbitrary node_modules folders outside the workspace
      resolveNpmExecutable: false,
      // the user chose dprint to format this file, so tell them when it fails
      notifyOnError: true,
      logger: this.#logger,
    });
    try {
      if (!(await folder.initialize())) {
        if (folder.getEditorInfo()?.plugins.length === 0) {
          this.#logger.logWarn("No plugins found in the configuration file used in:", cwd);
        }
        folder.dispose();
        return undefined;
      }
    } catch (err) {
      folder.dispose();
      if (!(err instanceof ObjectDisposedError)) {
        this.#logger.logError("Error initializing:", err);
      }
      return undefined;
    }
    if (this.#disposed || generation !== this.#generation) {
      folder.dispose();
      return undefined;
    }
    return folder;
  }

  #notifyNoConfig() {
    // only notify once per session to not annoy people
    if (this.#hasNotifiedNoConfig) {
      return;
    }
    this.#hasNotifiedNoConfig = true;
    vscode.window.showInformationMessage(
      "No dprint configuration file found. Run \"dprint init\" in your project "
        + "or \"dprint init --global\" to create a global one.",
    );
  }

  #clearFolders() {
    this.#generation++;
    for (const folder of this.#folders) {
      folder.dispose();
    }
    this.#folders.length = 0; // clear
    for (const folder of this.#looseFolders.values()) {
      folder.then(f => f?.dispose());
    }
    this.#looseFolders.clear();
  }

  async #initializeFolders(): Promise<FolderInfos> {
    this.#assertNotDisposed();

    this.#clearFolders();
    const generation = this.#generation;
    if (vscode.workspace.workspaceFolders == null) {
      return [];
    }

    const configFiles = await discoverWorkspaceConfigFiles({
      logger: this.#logger,
    });
    this.#assertNotDisposed();
    this.#assertCurrentGeneration(generation);

    // Initialize the workspace folders with each sub configuration that's found.
    for (const folder of vscode.workspace.workspaceFolders) {
      const subConfigUris = configFiles.filter(c => isPathWithin(folder.uri.fsPath, c.fsPath));
      for (const subConfigUri of subConfigUris) {
        this.#folders.push(this.#createWorkspaceFolderService(folder, subConfigUri));
      }

      // if the current workspace folder hasn't been added, then ensure
      // it's added to the list of folders in order to allow someone
      // formatting when the current open workspace is in a sub directory
      // of a workspace
      if (
        !this.#folders.some(f => areDirectoryUrisEqual(f.uri, folder.uri))
        && ancestorDirsContainConfigFile(folder.uri)
      ) {
        this.#folders.push(this.#createWorkspaceFolderService(folder, undefined));
      }
    }

    // now initialize in parallel
    const initializedFolders = await Promise.all(this.#folders.map(async f => {
      if (await f.initialize()) {
        return f;
      } else {
        return undefined;
      }
    }));

    this.#assertNotDisposed();
    this.#assertCurrentGeneration(generation);

    const allEditorInfos: FolderInfo[] = [];
    for (const folder of initializedFolders) {
      if (folder != null) {
        const editorInfo = folder.getEditorInfo();
        if (editorInfo != null) {
          allEditorInfos.push({ uri: folder.uri, editorInfo: editorInfo });
        }
      }
    }
    return allEditorInfos;
  }

  #assertCurrentGeneration(generation: number) {
    if (generation !== this.#generation) {
      // superseded by a newer initialization
      throw new ObjectDisposedError();
    }
  }

  #createWorkspaceFolderService(folder: vscode.WorkspaceFolder, configUri: vscode.Uri | undefined) {
    return new FolderService({
      approvedPaths: this.#approvedPaths,
      // It's important that we always use the workspace folder as the
      // cwd for the process instead of possibly the sub directory because
      // we don't want the dprint process to hold a resource lock on a
      // sub directory. That would give the user a bad experience where
      // they can't delete the sub directory.
      cwd: folder.uri,
      configUri,
      logger: this.#logger,
    });
  }
}

function areDirectoryUrisEqual(a: vscode.Uri, b: vscode.Uri) {
  function standarizeUri(uri: vscode.Uri) {
    const text = uri.toString();
    if (text.endsWith("/")) {
      return text;
    } else {
      // for some reason, vscode workspace directory uris don't have a trailing slash
      return `${text}/`;
    }
  }

  return standarizeUri(a) === standarizeUri(b);
}
