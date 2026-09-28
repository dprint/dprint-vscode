import * as path from "node:path";
import * as vscode from "vscode";
import type { ApprovedConfigPaths } from "../ApprovedConfigPaths";
import { getDprintConfig } from "../config";
import { discoverWorkspaceConfigFiles } from "../configFile";
import {
  findClosestFolder,
  findConfigFileInAncestorDirectories,
  findGlobalConfigFile,
  isPathWithin,
  type LooseFolderConfig,
  resolveLooseFolderConfig,
} from "../configPaths";
import { DPRINT_CONFIG_FILE_NAME_GLOB } from "../constants";
import { type Environment, RealEnvironment } from "../environment";
import type { ConfigDiscovery, EditorInfo } from "../executable/DprintExecutable";
import { Logger } from "../logger";
import { ObjectDisposedError } from "../utils";
import { tryRefreshFolders } from "./folderRefresh";
import { FolderService } from "./FolderService";
import { getNoConfigMessage } from "./noConfigMessage";

export type FolderInfos = ReadonlyArray<Readonly<FolderInfo>>;

export interface FolderInfo {
  uri: vscode.Uri;
  editorInfo: EditorInfo;
}

export interface WorkspaceServiceOptions {
  approvedPaths: ApprovedConfigPaths;
  logger: Logger;
  /** Called when a config file in an ancestor directory of a workspace folder is created or deleted. */
  onAncestorConfigFileCreatedOrDeleted: () => void;
  /** Called when the contents of a config file in an ancestor directory of a workspace folder change. */
  onAncestorConfigFileChanged: () => void;
  /** Called when a folder for files not in a workspace folder with a config file changes (ex. its plugins). */
  onLooseFolderChanged: () => void;
}

/**
 * Handles creating dprint instances for each workspace folder and, lazily,
 * for files outside of those (ex. files outside the workspace or in a
 * workspace folder without a config file).
 */
export class WorkspaceService implements vscode.DocumentFormattingEditProvider {
  readonly #approvedPaths: ApprovedConfigPaths;
  readonly #logger: Logger;
  readonly #onAncestorConfigFileCreatedOrDeleted: () => void;
  readonly #onAncestorConfigFileChanged: () => void;
  readonly #onLooseFolderChanged: () => void;
  readonly #environment: Environment;
  readonly #folders: FolderService[] = [];
  /** Folders for files not in a workspace folder with a config file. */
  readonly #looseFolders = new Map<string, LooseFolderEntry>();
  /** Watchers for config files in ancestor directories of workspace folders, keyed by directory. */
  readonly #ancestorConfigFileWatchers = new Map<string, vscode.Disposable>();

  #disposed = false;
  #generation = 0;
  #workspaceInitialization: Promise<unknown> | undefined;
  #hasNotifiedNoConfig = false;

  constructor(opts: WorkspaceServiceOptions) {
    this.#approvedPaths = opts.approvedPaths;
    this.#logger = opts.logger;
    this.#onAncestorConfigFileCreatedOrDeleted = opts.onAncestorConfigFileCreatedOrDeleted;
    this.#onAncestorConfigFileChanged = opts.onAncestorConfigFileChanged;
    this.#onLooseFolderChanged = opts.onLooseFolderChanged;
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
    const folder = await this.#getFolderForUri(document.uri, { notify: true });
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
    const folder = await this.#getFolderForUri(document.uri, { notify: true });
    if (folder == null || token.isCancellationRequested) {
      return [];
    }
    return folder.provideDocumentRangeFormattingEdits(document, range, options, token);
  }

  /**
   * Gets if a plugin can format the file. This starts dprint for the file's config
   * file if necessary, but doesn't notify when there's no config file or it fails.
   */
  async canFormatWithPlugin(uri: vscode.Uri) {
    const folder = await this.#getFolderForUri(uri, { notify: false });
    return folder != null && await folder.canFormatWithPlugin(uri.fsPath);
  }

  /**
   * Refreshes the workspace folders' plugin information after a config file's contents
   * changed without restarting dprint, which reloads its config itself. Returns undefined
   * when the folders need to be reinitialized instead (ex. one isn't running).
   */
  async refreshFolders(): Promise<FolderInfos | undefined> {
    await this.#waitWorkspaceInitialization();
    this.#assertNotDisposed();
    const generation = this.#generation;
    const refreshed = await tryRefreshFolders(this.#folders);
    this.#assertNotDisposed();
    this.#assertCurrentGeneration(generation);
    return refreshed ? getFolderInfos(this.#folders) : undefined;
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

  async #waitWorkspaceInitialization() {
    // wait for the latest one because a newer initialization may start while waiting
    while (this.#workspaceInitialization != null) {
      await this.#workspaceInitialization.catch(() => {/* ignore */});
    }
  }

  async #getFolderForUri(uri: vscode.Uri, options: { notify: boolean }) {
    // wait for the workspace folders so a file in one doesn't get a loose folder
    await this.#waitWorkspaceInitialization();
    if (this.#disposed) {
      return undefined;
    }
    return this.#getWorkspaceFolderForUri(uri) ?? await this.#getLooseFolderForUri(uri, options);
  }

  #getWorkspaceFolderForUri(uri: vscode.Uri) {
    return findClosestFolder(this.#folders, folder => folder.uri.fsPath, uri.fsPath);
  }

  /**
   * Gets a folder for a file not in a workspace folder with a config file. It uses
   * the file's closest ancestor config file or otherwise the global config file.
   */
  async #getLooseFolderForUri(uri: vscode.Uri, options: { notify: boolean }) {
    const generation = this.#generation;
    const { useGlobalConfig } = getDprintConfig(uri);
    const looseConfig = await resolveLooseFolderConfig(this.#environment, uri.fsPath, { useGlobalConfig });
    if (this.#disposed || generation !== this.#generation) {
      return undefined;
    }
    if (looseConfig == null) {
      this.#logger.logInfo("Configuration file not found for:", uri.fsPath);
      if (options.notify) {
        await this.#notifyNoConfig(useGlobalConfig);
      }
      return undefined;
    }

    // include whether it's the global config in the key because a config file at the file
    // system root and the global config file have the same cwd, but run dprint differently
    const key = `${looseConfig.isGlobalConfig ? "global" : "config"}:${looseConfig.cwd}`;
    let entry = this.#looseFolders.get(key);
    if (entry == null) {
      // failures are stored too so they're not retried on every format until the config file changes
      entry = this.#createLooseFolderEntry(key, looseConfig, generation);
      this.#looseFolders.set(key, entry);
    }
    const folder = await entry.folder;
    if (folder == null && options.notify) {
      // these folders don't notify on errors themselves because they may be created
      // without the user formatting (ex. to check if a user data file can be formatted)
      this.#logger.logErrorAndNotify("Failed initializing dprint.", "Failed initializing dprint in:", looseConfig.cwd);
    }
    return folder;
  }

  #createLooseFolderEntry(key: string, looseConfig: LooseFolderConfig, generation: number) {
    // Watch the config files in the config file's directory because config files outside
    // the workspace aren't otherwise watched. Remove the entry so the next format starts
    // dprint again when a config file is created or deleted, or when one changes after
    // dprint failed to start. A running dprint picks up changes to its config file itself,
    // so only refresh its plugin information in that case.
    const configFileWatcher = createConfigFileWatcher(looseConfig.configFilePath);
    const entry: LooseFolderEntry = {
      folder: this.#initializeLooseFolder(looseConfig, generation),
      configFileWatcher,
    };
    const removeEntry = () => {
      if (this.#looseFolders.get(key) === entry) {
        this.#logger.logDebug("Configuration file changed. Restarting dprint on next format in:", looseConfig.cwd);
        this.#looseFolders.delete(key);
        disposeLooseFolderEntry(entry);
        this.#onLooseFolderChanged();
      }
    };
    configFileWatcher.onDidCreate(removeEntry);
    configFileWatcher.onDidChange(async () => {
      const folder = await entry.folder;
      if (folder == null) {
        removeEntry();
      } else if (this.#looseFolders.get(key) === entry) {
        await folder.refreshEditorInfo();
        this.#onLooseFolderChanged();
      }
    });
    configFileWatcher.onDidDelete(removeEntry);
    return entry;
  }

  async #initializeLooseFolder({ cwd, isGlobalConfig }: LooseFolderConfig, generation: number) {
    const folder = new FolderService({
      approvedPaths: this.#approvedPaths,
      cwd: vscode.Uri.file(cwd),
      configUri: undefined,
      // don't run executables from arbitrary node_modules folders outside the workspace
      resolveNpmExecutable: false,
      // the extension resolves the config file itself, so don't let the cli fall back
      // to the global config file (ex. when the config file is deleted while running)
      configDiscovery: isGlobalConfig ? undefined : "ignore-descendants",
      // notified when formatting instead (see #getLooseFolderForUri)
      notifyOnError: false,
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

  async #notifyNoConfig(useGlobalConfig: boolean) {
    // only notify once per session to not annoy people
    if (this.#hasNotifiedNoConfig) {
      return;
    }
    this.#hasNotifiedNoConfig = true;
    const hasGlobalConfig = !useGlobalConfig && await findGlobalConfigFile(this.#environment) != null;
    vscode.window.showInformationMessage(getNoConfigMessage({ useGlobalConfig, hasGlobalConfig }));
  }

  #clearFolders() {
    this.#generation++;
    for (const folder of this.#folders) {
      folder.dispose();
    }
    this.#folders.length = 0; // clear
    for (const entry of this.#looseFolders.values()) {
      disposeLooseFolderEntry(entry);
    }
    this.#looseFolders.clear();
    for (const watcher of this.#ancestorConfigFileWatchers.values()) {
      watcher.dispose();
    }
    this.#ancestorConfigFileWatchers.clear();
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
      if (!this.#folders.some(f => areDirectoryUrisEqual(f.uri, folder.uri))) {
        const ancestorConfigFilePath = await findConfigFileInAncestorDirectories(
          this.#environment,
          path.dirname(folder.uri.fsPath),
        );
        this.#assertNotDisposed();
        this.#assertCurrentGeneration(generation);
        if (ancestorConfigFilePath != null) {
          // the cli finds the ancestor config file itself, but don't let it fall back to the
          // global config file if that one's deleted because the global config file is opt-in
          this.#folders.push(this.#createWorkspaceFolderService(folder, undefined, "ignore-descendants"));
          this.#watchAncestorConfigFile(ancestorConfigFilePath);
        }
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
    return getFolderInfos(initializedFolders);
  }

  #assertCurrentGeneration(generation: number) {
    if (generation !== this.#generation) {
      // superseded by a newer initialization
      throw new ObjectDisposedError();
    }
  }

  #createWorkspaceFolderService(
    folder: vscode.WorkspaceFolder,
    configUri: vscode.Uri | undefined,
    configDiscovery?: ConfigDiscovery,
  ) {
    return new FolderService({
      approvedPaths: this.#approvedPaths,
      // It's important that we always use the workspace folder as the
      // cwd for the process instead of possibly the sub directory because
      // we don't want the dprint process to hold a resource lock on a
      // sub directory. That would give the user a bad experience where
      // they can't delete the sub directory.
      cwd: folder.uri,
      configUri,
      configDiscovery,
      logger: this.#logger,
    });
  }

  #watchAncestorConfigFile(configFilePath: string) {
    const dirPath = path.dirname(configFilePath);
    // config files in workspace folders are already watched by the extension
    const isInWorkspace = vscode.workspace.workspaceFolders?.some(f => isPathWithin(f.uri.fsPath, dirPath)) ?? false;
    if (isInWorkspace || this.#ancestorConfigFileWatchers.has(dirPath)) {
      return;
    }
    const watcher = createConfigFileWatcher(configFilePath);
    const onCreateOrDelete = () => {
      this.#logger.logDebug("Ancestor configuration file created or deleted in:", dirPath);
      this.#onAncestorConfigFileCreatedOrDeleted();
    };
    watcher.onDidCreate(onCreateOrDelete);
    watcher.onDidChange(() => {
      this.#logger.logDebug("Ancestor configuration file changed in:", dirPath);
      this.#onAncestorConfigFileChanged();
    });
    watcher.onDidDelete(onCreateOrDelete);
    this.#ancestorConfigFileWatchers.set(dirPath, watcher);
  }
}

function getFolderInfos(folders: ReadonlyArray<FolderService | undefined>): FolderInfos {
  const folderInfos: FolderInfo[] = [];
  for (const folder of folders) {
    const editorInfo = folder?.getEditorInfo();
    if (folder != null && editorInfo != null) {
      folderInfos.push({ uri: folder.uri, editorInfo });
    }
  }
  return folderInfos;
}

/** Watches the config files in the config file's directory. */
function createConfigFileWatcher(configFilePath: string) {
  return vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.dirname(configFilePath)), DPRINT_CONFIG_FILE_NAME_GLOB),
  );
}

interface LooseFolderEntry {
  folder: Promise<FolderService | undefined>;
  configFileWatcher: vscode.Disposable;
}

function disposeLooseFolderEntry(entry: LooseFolderEntry) {
  entry.configFileWatcher.dispose();
  entry.folder.then(folder => folder?.dispose());
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
