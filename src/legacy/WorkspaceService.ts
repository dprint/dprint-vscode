import * as path from "node:path";
import * as vscode from "vscode";
import type { ApprovedConfigPaths } from "../ApprovedConfigPaths";
import { ancestorDirsContainConfigFile, discoverWorkspaceConfigFiles } from "../configFile";
import { findConfigFileInAncestorDirectoriesPath, getFileSystemRootPath, isPathWithin } from "../configPaths";
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

/** Handles creating dprint instances for each workspace folder. */
export class WorkspaceService implements vscode.DocumentFormattingEditProvider {
  readonly #approvedPaths: ApprovedConfigPaths;
  readonly #logger: Logger;
  readonly #folders: FolderService[] = [];
  readonly #looseFolders = new Map<string, FolderService>();
  readonly #pendingLooseFolders = new Map<string, Promise<FolderService | undefined>>();

  #disposed = false;
  #generation = 0;
  #workspaceInitialization: Promise<FolderInfos> | undefined;

  constructor(opts: WorkspaceServiceOptions) {
    this.#approvedPaths = opts.approvedPaths;
    this.#logger = opts.logger;
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
    if (document.uri.scheme !== "file") {
      return undefined;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    let folder: FolderService | undefined;
    if (workspaceFolder == null) {
      folder = await this.#getLooseFolderForUri(document.uri);
    } else {
      folder = this.#getFolderForUri(document.uri);
      const initialization = this.#workspaceInitialization;
      if (folder == null && initialization != null) {
        await initialization;
        folder = this.#getFolderForUri(document.uri);
      }
    }
    if (token.isCancellationRequested) {
      return [];
    }
    if (folder == null) {
      this.#logger.logErrorAndNotify(
        "dprint could not find a usable configuration for this file.",
        `Unable to initialize dprint for file: ${document.uri.fsPath}`,
      );
      return [];
    }
    return folder.provideDocumentFormattingEdits(document, options, token);
  }

  provideDocumentRangeFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range,
    options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ) {
    const folder = this.#getFolderForUri(document.uri);
    return folder?.provideDocumentRangeFormattingEdits(document, range, options, token);
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

  #clearFolders() {
    this.#generation++;
    this.#pendingLooseFolders.clear();
    for (const folder of this.#folders) {
      folder.dispose();
    }
    this.#folders.length = 0; // clear
    for (const folder of this.#looseFolders.values()) {
      folder.dispose();
    }
    this.#looseFolders.clear();
  }

  async #getLooseFolderForUri(uri: vscode.Uri) {
    this.#assertNotDisposed();
    const configPath = findConfigFileInAncestorDirectoriesPath(path.dirname(uri.fsPath));
    const rootUri = vscode.Uri.file(getFileSystemRootPath(uri.fsPath));
    const configUri = configPath == null ? undefined : vscode.Uri.file(configPath);
    const key = configUri == null ? `global:${rootUri.toString()}` : `config:${configUri.toString()}`;
    const existing = this.#looseFolders.get(key);
    if (existing != null) {
      return existing;
    }

    const pending = this.#pendingLooseFolders.get(key);
    if (pending != null) {
      return pending;
    }

    const initialization = this.#initializeLooseFolder({
      key,
      rootUri,
      configUri,
      generation: this.#generation,
    });
    this.#pendingLooseFolders.set(key, initialization);
    try {
      return await initialization;
    } finally {
      if (this.#pendingLooseFolders.get(key) === initialization) {
        this.#pendingLooseFolders.delete(key);
      }
    }
  }

  async #initializeLooseFolder(opts: {
    key: string;
    rootUri: vscode.Uri;
    configUri: vscode.Uri | undefined;
    generation: number;
  }) {
    const folder = new FolderService({
      approvedPaths: this.#approvedPaths,
      scopeUri: opts.configUri == null ? opts.rootUri : vscode.Uri.joinPath(opts.configUri, "../"),
      cwd: opts.rootUri,
      configUri: opts.configUri,
      configDiscovery: opts.configUri == null ? "global" : undefined,
      resolveNpmExecutable: false,
      logger: this.#logger,
    });
    try {
      const initialized = await folder.initialize();
      this.#assertNotDisposed();
      if (!initialized || opts.generation !== this.#generation) {
        folder.dispose();
        return undefined;
      }
      this.#looseFolders.set(opts.key, folder);
      return folder;
    } catch (err) {
      folder.dispose();
      throw err;
    }
  }

  initializeFolders(): Promise<FolderInfos> {
    const initialization = this.#initializeFolders();
    this.#workspaceInitialization = initialization;
    return initialization.finally(() => {
      if (this.#workspaceInitialization === initialization) {
        this.#workspaceInitialization = undefined;
      }
    });
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
    if (generation !== this.#generation) {
      return [];
    }

    // Initialize the workspace folders with each sub configuration that's found.
    for (const folder of vscode.workspace.workspaceFolders) {
      const subConfigUris = configFiles.filter(c => isPathWithin(folder.uri.fsPath, c.fsPath));
      for (const subConfigUri of subConfigUris) {
        this.#folders.push(
          new FolderService({
            approvedPaths: this.#approvedPaths,
            scopeUri: folder.uri,
            cwd: folder.uri,
            configUri: subConfigUri,
            logger: this.#logger,
          }),
        );
      }

      // if the current workspace folder hasn't been added, then ensure
      // it's added to the list of folders in order to allow someone
      // formatting when the current open workspace is in a sub directory
      // of a workspace
      if (
        !this.#folders.some(f => areDirectoryUrisEqual(f.uri, folder.uri))
        && ancestorDirsContainConfigFile(folder.uri)
      ) {
        this.#folders.push(
          new FolderService({
            approvedPaths: this.#approvedPaths,
            scopeUri: folder.uri,
            cwd: folder.uri,
            configUri: undefined,
            logger: this.#logger,
          }),
        );
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
    if (generation !== this.#generation) {
      return [];
    }

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
