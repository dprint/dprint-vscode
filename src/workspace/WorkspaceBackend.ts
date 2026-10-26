import * as path from "node:path";
import * as vscode from "vscode";
import type { ApprovedConfigPaths } from "../ApprovedConfigPaths";
import { getDprintConfig } from "../config";
import { discoverWorkspaceConfigFiles } from "../configFile";
import type { ConfigJsonSchemaProvider } from "../ConfigJsonSchemaProvider";
import {
  filterCacheDirConfigFiles,
  findClosestFolder,
  findWorkspaceFolderAncestorConfigFile,
  isPathWithin,
} from "../configPaths";
import {
  DPRINT_CONFIG_FILE_NAME_GLOB,
  FILE_SCHEME,
  isDprintExtensionId,
  JUPYTER_NOTEBOOK_TYPE,
  NOTEBOOK_CELL_SCHEME,
  UNTITLED_SCHEME,
  USER_DATA_SCHEME,
} from "../constants";
import { type Environment, RealEnvironment } from "../environment";
import { DprintExecutable } from "../executable/DprintExecutable";
import type { FormatDocumentResult } from "../ExtensionBackend";
import type { NotFormattedReason as ExtensionNotFormattedReason } from "../globalConfigCommand";
import { getNotebookCellFileNames, getUntitledFileNames, type LanguageContribution } from "../languageFileNames";
import type { Logger } from "../logger";
import { hasPluginForFile } from "../pluginFiles";
import { expandToLines } from "../textRange";
import { ActivatedDisposables, delay } from "../utils";
import { CoalescingQueue } from "../utils/CoalescingQueue";
import { EditorServiceConnection } from "./EditorServiceConnection";
import {
  type EditorServiceInfo,
  type EditorSettings,
  type MessageType,
  type NotFormattedReason,
  parseEditorServiceInfo,
  type PluginInfo,
  SCHEMA_VERSION,
} from "./messages";

export interface WorkspaceBackendOptions {
  approvedPaths: ApprovedConfigPaths;
  configSchemaProvider: ConfigJsonSchemaProvider;
  logger: Logger;
  /** Called when a config file outside the workspace that a workspace folder uses is created or deleted. */
  onAncestorConfigFileCreatedOrDeleted(): void;
}

/**
 * Formats using schema version 6 of dprint's editor service, where one dprint
 * process formats the files of the whole workspace by finding the config file
 * of each file itself. There's a process for each dprint executable in use (ex.
 * when a project in the workspace has dprint in its node_modules folder).
 */
export class WorkspaceBackend implements vscode.Disposable {
  readonly #options: WorkspaceBackendOptions;
  readonly #logger: Logger;
  readonly #environment: Environment;
  #state: WorkspaceState | undefined;
  #disposed = false;

  constructor(options: WorkspaceBackendOptions) {
    this.#options = options;
    this.#logger = options.logger;
    this.#environment = new RealEnvironment(options.logger);
  }

  /**
   * Starts formatting the workspace, which is false when one of the dprint executables
   * in use doesn't support schema version 6. Nothing is registered in that case.
   *
   * @param onSupported - Called once it's known that the executables support it,
   * before the formatter is registered.
   */
  async initialize(onSupported: () => void): Promise<boolean> {
    this.#clearState();
    this.#logger.setDebug(getDprintConfig(vscode.workspace.workspaceFolders?.[0]?.uri).verbose);
    const state = new WorkspaceState(this.#options, this.#environment);
    try {
      const configFiles = await this.#findConfigFiles();
      const configServices = await Promise.all(
        configFiles.map(configFile =>
          state.getService(() => this.#createExecutable(configFile.dirUri, configFile.folderUri))
        ),
      );
      // the files without a config file in the workspace are formatted with this one, which is only
      // required to support the schema version when there's nothing else to format with
      const services = configFiles.length === 0 ? [await state.getDefaultService()] : configServices;
      const unsupported = services.find(service => "error" in service);
      if (unsupported != null && "error" in unsupported) {
        this.#logger.logInfo(`Using schema version 5 of the editor service. ${unsupported.error}`);
        state.dispose();
        return false;
      }
      if (this.#disposed) {
        state.dispose();
        return false;
      }
      onSupported();
      this.#state = state;
      state.setConfigs(configFiles.map((configFile, i) => ({
        dirUri: configFile.dirUri,
        configFilePath: configFile.configFilePath,
        service: configServices[i] as Service,
        plugins: [],
      })));
      for (const configFile of configFiles) {
        if (configFile.isAncestor) {
          state.watchAncestorConfigFile(configFile.configFilePath);
        }
      }
      await state.refresh();
      return true;
    } catch (err) {
      if (this.#state !== state) {
        state.dispose();
      }
      throw err;
    }
  }

  onConfigFileChanged() {
    return this.#state?.scheduleRefresh() ?? Promise.resolve();
  }

  provideGlobalConfigFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range | undefined,
    _options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<FormatDocumentResult> {
    if (this.#state == null) {
      return Promise.resolve({ notFormattedReason: "failed" });
    }
    return this.#state.formatDocument(document, range, { allowGlobalConfig: true }, token);
  }

  dispose() {
    this.#disposed = true;
    this.#clearState();
  }

  #clearState() {
    this.#state?.dispose();
    this.#state = undefined;
  }

  /** Finds the config files in the workspace folders and the ones the workspace folders use from an ancestor directory. */
  async #findConfigFiles(): Promise<ConfigFile[]> {
    const configFileUris = await discoverWorkspaceConfigFiles({ logger: this.#logger });
    const configFiles: ConfigFile[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const folderConfigUris = configFileUris.filter(uri => isPathWithin(folder.uri.fsPath, uri.fsPath));
      // vscode.workspace.findFiles doesn't respect .gitignore files, so it finds config files in
      // gitignored directories that the dprint cli never uses (ex. Cargo's target/package directory)
      const configFilePaths = await filterCacheDirConfigFiles(
        this.#environment,
        folder.uri.fsPath,
        folderConfigUris.map(uri => uri.fsPath),
      );
      for (const configFilePath of configFilePaths) {
        configFiles.push({
          dirUri: vscode.Uri.file(path.dirname(configFilePath)),
          folderUri: folder.uri,
          configFilePath,
          isAncestor: false,
        });
      }
      // a workspace folder that's a descendant directory of a folder with a config file uses that one
      const ancestorConfigFilePath = await findWorkspaceFolderAncestorConfigFile(
        this.#environment,
        folder.uri.fsPath,
        configFilePaths,
      );
      if (ancestorConfigFilePath != null) {
        configFiles.push({
          dirUri: folder.uri,
          folderUri: folder.uri,
          configFilePath: ancestorConfigFilePath,
          isAncestor: true,
        });
      }
    }
    return configFiles;
  }

  #createExecutable(dirUri: vscode.Uri, folderUri: vscode.Uri) {
    const config = getDprintConfig(dirUri);
    return DprintExecutable.create({
      approvedPaths: this.#options.approvedPaths,
      pathInfo: config.pathInfo,
      // It's important that the process runs in the workspace folder instead of a
      // sub directory so that it doesn't hold a resource lock on the sub directory,
      // which would prevent the user from deleting it.
      cwd: folderUri,
      configUri: undefined,
      // search from the config file's directory so that a project in a sub directory
      // uses the dprint installed in its own node_modules folder
      npmSearchDir: dirUri,
      ensureStableFormat: config.ensureStableFormat,
      verbose: config.verbose,
      logger: this.#logger,
      environment: this.#environment,
    });
  }
}

/** A config file that the files in a directory of a workspace folder are formatted with. */
interface ConfigFile {
  /** The directory whose files are formatted with the config file. */
  dirUri: vscode.Uri;
  /** The workspace folder of the directory. */
  folderUri: vscode.Uri;
  configFilePath: string;
  /** Whether it's a config file in an ancestor directory of the workspace folder. */
  isAncestor: boolean;
}

interface Config {
  dirUri: vscode.Uri;
  configFilePath: string;
  service: Service;
  plugins: PluginInfo[];
}

/** An editor service process and what its executable supports. */
interface Service {
  connection: EditorServiceConnection;
  info: EditorServiceInfo;
  executable: DprintExecutable;
}

type ServiceResolution = Service | { error: string };

/** The files dprint may format a document as. */
interface FormatFileCandidates {
  dirPath: string;
  /** The file names in order of preference. This is never empty. */
  fileNames: string[];
  /** The notebook file's path when the document is a notebook cell. */
  notebookPath?: string;
}

/** What's started for one initialization of the workspace. */
class WorkspaceState {
  readonly #options: WorkspaceBackendOptions;
  readonly #logger: Logger;
  readonly #environment: Environment;
  readonly #disposables: ActivatedDisposables;
  readonly #registrationDisposables: ActivatedDisposables;
  readonly #services = new Map<string, Promise<ServiceResolution>>();
  readonly #refreshQueue: CoalescingQueue;
  #defaultService: Promise<ServiceResolution> | undefined;
  #configs: Config[] = [];
  #registrationKey: string | undefined;
  #registrationUpdate = Promise.resolve();
  #userDataFilePaths: string[] = [];
  #userDataFilePathsUpdate = Promise.resolve();
  #disposed = false;

  constructor(options: WorkspaceBackendOptions, environment: Environment) {
    this.#options = options;
    this.#logger = options.logger;
    this.#environment = environment;
    this.#disposables = new ActivatedDisposables(options.logger);
    this.#registrationDisposables = new ActivatedDisposables(options.logger);
    // coalesced because saving a config file often causes multiple change events
    this.#refreshQueue = new CoalescingQueue({ action: () => this.refresh(), wait: () => delay(100) });

    // update the formatting registration when the default formatter settings or languages change
    this.#disposables.push(vscode.workspace.onDidChangeConfiguration(evt => {
      this.#scheduleRegistrationUpdate();
      if (evt.affectsConfiguration("dprint.showNoConfigNotification")) {
        this.#updateSettings();
      }
    }));
    this.#disposables.push(vscode.extensions.onDidChange(() => this.#scheduleRegistrationUpdate()));
    // update the user data files (ex. the user settings.json) to format when the visible editors change
    this.#disposables.push(vscode.window.onDidChangeVisibleTextEditors(() => this.#scheduleUserDataFilePathsUpdate()));
  }

  dispose() {
    this.#disposed = true;
    this.#registrationDisposables.dispose();
    this.#disposables.dispose();
    for (const service of this.#services.values()) {
      service.then(service => {
        if (!("error" in service)) {
          service.connection.dispose();
        }
      });
    }
    this.#services.clear();
  }

  setConfigs(configs: Config[]) {
    this.#configs = configs;
  }

  /**
   * Gets the editor service of the executable, which is shared with the other executables
   * that are launched the same way.
   */
  async getService(createExecutable: () => Promise<DprintExecutable>): Promise<ServiceResolution> {
    let executable: DprintExecutable;
    try {
      // this fails when a command in the "dprint.path" setting fails
      executable = await createExecutable();
    } catch (err) {
      return { error: `Error resolving the dprint executable: ${err}` };
    }
    const key = executable.processKey;
    let service = this.#services.get(key);
    if (service == null) {
      service = this.#createService(executable);
      this.#services.set(key, service);
    }
    return service;
  }

  /** Gets the editor service for the files that don't have a config file in the workspace. */
  getDefaultService(): Promise<ServiceResolution> {
    this.#defaultService ??= this.getService(() => this.#createDefaultExecutable());
    return this.#defaultService;
  }

  /** Refreshes the plugins of the config files after a config file's contents changed. */
  scheduleRefresh() {
    return this.#refreshQueue.schedule();
  }

  async refresh() {
    await Promise.all(this.#configs.map(async config => {
      try {
        const info = await config.service.connection.configInfo({ filePath: config.configFilePath });
        config.plugins = info.plugins;
        if (info.plugins.length === 0) {
          this.#logger.logWarn("No plugins found in the configuration file:", config.configFilePath);
        }
      } catch (err) {
        config.plugins = [];
        if (!this.#disposed) {
          this.#logger.logErrorAndNotify(
            "Failed initializing dprint.",
            `Error initializing in ${config.dirUri.fsPath}:`,
            err,
          );
        }
      }
    }));
    if (this.#disposed) {
      return;
    }
    const configsWithPlugins = this.#configs.filter(config => config.plugins.length > 0);
    this.#options.configSchemaProvider.setConfigSchemaInfos(configsWithPlugins.map(config => ({
      configSchemaUrl: config.service.info.configSchemaUrl,
      plugins: config.plugins,
    })));
    await this.#scheduleRegistrationUpdate();
    // don't wait for this because it may need to start dprint for a config outside the workspace
    this.#scheduleUserDataFilePathsUpdate();
    if (this.#configs.length === 0) {
      this.#logger.logInfo("Configuration file not found.");
    }
  }

  /** Formats the document, or only the range when provided, and says why it wasn't formatted when that's the case. */
  async formatDocument(
    document: vscode.TextDocument,
    range: vscode.Range | undefined,
    options: { allowGlobalConfig?: boolean },
    token: vscode.CancellationToken,
  ): Promise<FormatDocumentResult> {
    const candidates = this.#getFormatFileCandidates(document);
    if (candidates == null) {
      return { notFormattedReason: "noFilePath" };
    }
    const service = await this.#getServiceForFile(path.join(candidates.dirPath, candidates.fileNames[0]));
    if (service == null || token.isCancellationRequested) {
      return service == null ? { notFormattedReason: "failed" } : { edits: [] };
    }
    const allowGlobalConfig = options.allowGlobalConfig ?? getDprintConfig(document.uri).useGlobalConfig;
    try {
      const filePath = await this.#getFormatFilePath(service, candidates, allowGlobalConfig);
      const text = document.getText();
      const offsetRange = range == null
        ? { start: 0, end: text.length }
        : expandToLines(text, { start: document.offsetAt(range.start), end: document.offsetAt(range.end) });
      const result = await service.connection.formatFile(
        filePath,
        text,
        offsetRange,
        { notebookPath: candidates.notebookPath, allowGlobalConfig },
        token,
      );
      if (result == null) {
        return { edits: [] }; // cancelled
      }
      if (result.edits == null) {
        this.#logger.logDebug(`Response - Not formatted (${result.reason}):`, filePath);
        if (result.reason === "noPlugin" && candidates.notebookPath == null) {
          // say when it's because the config file has no plugins at all
          const info = await service.connection.configInfo({ filePath, allowGlobalConfig });
          if (info.plugins.length === 0) {
            return { notFormattedReason: "noPlugins" };
          }
        }
        return getFormatDocumentResult(result.reason, candidates.notebookPath != null);
      }
      // plugins may format the whole file instead of only the range
      if (range != null && result.edits.some(edit => edit.start < offsetRange.start || edit.end > offsetRange.end)) {
        this.#logger.logDebug("Response - Ignored range format with changes outside the range:", filePath);
        return { edits: [] };
      }
      this.#logger.logDebug("Response - Formatted:", filePath);
      return {
        edits: result.edits.map(edit =>
          vscode.TextEdit.replace(
            new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
            edit.newText,
          )
        ),
      };
    } catch (err) {
      this.#logger.logError("Error formatting text.", err);
      return { notFormattedReason: "failed" };
    }
  }

  watchAncestorConfigFile(configFilePath: string) {
    const dirPath = path.dirname(configFilePath);
    // config files in workspace folders are already watched by the extension
    if (vscode.workspace.workspaceFolders?.some(folder => isPathWithin(folder.uri.fsPath, dirPath))) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dirPath), DPRINT_CONFIG_FILE_NAME_GLOB),
    );
    const onCreateOrDelete = () => {
      this.#logger.logDebug("Ancestor configuration file created or deleted in:", dirPath);
      this.#options.onAncestorConfigFileCreatedOrDeleted();
    };
    watcher.onDidCreate(onCreateOrDelete);
    watcher.onDidChange(() => {
      this.#logger.logDebug("Ancestor configuration file changed in:", dirPath);
      this.scheduleRefresh();
    });
    watcher.onDidDelete(onCreateOrDelete);
    this.#disposables.push(watcher);
  }

  async #createService(executable: DprintExecutable): Promise<ServiceResolution> {
    let info: ReturnType<typeof parseEditorServiceInfo>;
    try {
      info = parseEditorServiceInfo(await executable.getEditorServiceInfo());
    } catch (err) {
      return { error: `Running \`${executable.cmdPath} editor-service --info\` failed: ${err}` };
    }
    if ("error" in info) {
      return info;
    }
    const connection = new EditorServiceConnection({
      spawn: () => executable.spawnWorkspaceEditorService(SCHEMA_VERSION),
      getInitializeData: () => ({
        clientInfo: { name: vscode.env.appName, version: vscode.version },
        settings: getEditorSettings(),
      }),
      showMessage: data => {
        getShowMessageFunction(data.kind)(data.message);
      },
      showMessageRequest: async data => {
        const selection = await getShowMessageFunction(data.kind)(
          data.message,
          ...data.actions.map(action => action.title),
        );
        return data.actions.find(action => action.title === selection);
      },
      logger: this.#logger,
    });
    if (this.#disposed) {
      connection.dispose();
    } else {
      this.#logger.logInfo(
        `Initialized dprint ${info.cliVersion} (editor service schema version ${SCHEMA_VERSION})\n`
          + `  Command: ${executable.cmdPath}`,
      );
    }
    return { connection, info, executable };
  }

  #createDefaultExecutable() {
    const config = getDprintConfig(undefined);
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri
      ?? vscode.Uri.file(this.#environment.homeDir() ?? this.#environment.tmpdir());
    return DprintExecutable.create({
      approvedPaths: this.#options.approvedPaths,
      pathInfo: config.pathInfo,
      cwd,
      configUri: undefined,
      // don't run executables from arbitrary node_modules folders outside the workspace
      resolveNpmExecutable: false,
      ensureStableFormat: config.ensureStableFormat,
      verbose: config.verbose,
      logger: this.#logger,
      environment: this.#environment,
    });
  }

  /** Gets the editor service of the config file in the workspace that's closest to the file or otherwise the default one. */
  async #getServiceForFile(filePath: string): Promise<Service | undefined> {
    const config = findClosestFolder(this.#configs, config => config.dirUri.fsPath, filePath);
    if (config != null) {
      return config.service;
    }
    const service = await this.getDefaultService();
    if ("error" in service) {
      this.#logger.logWarn(`Can't format files without a configuration file in the workspace. ${service.error}`);
      return undefined;
    }
    return service;
  }

  /**
   * Gets the file path to format the document as. A document that isn't on the file
   * system is formatted as the first of its candidate file names that dprint formats.
   */
  async #getFormatFilePath(service: Service, candidates: FormatFileCandidates, allowGlobalConfig: boolean) {
    const filePaths = candidates.fileNames.map(fileName => path.join(candidates.dirPath, fileName));
    if (filePaths.length > 1) {
      for (const filePath of filePaths) {
        const info = await service.connection.fileInfo({
          filePath,
          notebookPath: candidates.notebookPath,
          allowGlobalConfig,
        });
        if (info.canFormat) {
          return filePath;
        }
        if (info.configFile == null) {
          break; // the same for every candidate
        }
      }
    }
    return filePaths[0];
  }

  /**
   * Gets the candidate files dprint should format the document as. An untitled document
   * isn't on the file system, so it's formatted as a file in the first workspace
   * folder (or the home directory) named based on its language.
   */
  #getFormatFileCandidates(document: vscode.TextDocument): FormatFileCandidates | undefined {
    if (document.uri.scheme === NOTEBOOK_CELL_SCHEME) {
      return this.#getNotebookCellFormatFileCandidates(document);
    }
    if (document.uri.scheme !== UNTITLED_SCHEME) {
      return { dirPath: path.dirname(document.fileName), fileNames: [path.basename(document.fileName)] };
    }
    const dirPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.#environment.homeDir();
    const fileNames = getUntitledFileNames(getLanguageContributions(), document.languageId);
    if (dirPath == null || fileNames.length === 0) {
      this.#logger.logInfo(
        "Could not determine a file path to format the untitled document with language:",
        document.languageId,
      );
      return undefined;
    }
    return { dirPath, fileNames };
  }

  /**
   * A notebook cell is formatted as a file in the notebook's directory named based
   * on its language, which is how the jupyter plugin formats a notebook's code cells.
   */
  #getNotebookCellFormatFileCandidates(document: vscode.TextDocument): FormatFileCandidates | undefined {
    const notebook = vscode.workspace.notebookDocuments.find(notebook =>
      notebook.getCells().some(cell => cell.document === document)
    );
    if (notebook == null) {
      this.#logger.logInfo("Could not find the notebook of the cell:", document.uri.toString());
      return undefined;
    }
    // unsaved notebooks aren't supported because the cli only formats notebooks on the file system
    if (notebook.uri.scheme !== FILE_SCHEME) {
      this.#logger.logInfo(
        "Not formatting the cell of a notebook that isn't on the file system:",
        notebook.uri.toString(),
      );
      return undefined;
    }
    const fileNames = getNotebookCellFileNames(getLanguageContributions(), document.languageId);
    if (fileNames.length === 0) {
      this.#logger.logInfo(
        "Could not determine a file path to format the notebook cell with language:",
        document.languageId,
      );
      return undefined;
    }
    const notebookPath = notebook.uri.fsPath;
    return { dirPath: path.dirname(notebookPath), fileNames, notebookPath };
  }

  #updateSettings() {
    for (const service of this.#services.values()) {
      service.then(async service => {
        if (!("error" in service)) {
          try {
            await service.connection.updateSettings(getEditorSettings());
          } catch (err) {
            this.#logger.logError("Error updating the settings of the editor service:", err);
          }
        }
      });
    }
  }

  // Updates run one at a time because getting the languages is async and
  // concurrent updates would otherwise register the providers twice. The key
  // skips re-registering when an unrelated configuration change occurs.
  #scheduleRegistrationUpdate() {
    this.#registrationUpdate = this.#registrationUpdate
      .then(() => this.#updateRegistration())
      .catch(err => this.#logger.logError("Error updating formatting registration:", err));
    return this.#registrationUpdate;
  }

  async #updateRegistration() {
    const configsWithPlugins = this.#configs.filter(config => config.plugins.length > 0);
    const folderUris = configsWithPlugins.map(config => config.dirUri);
    const notebookFolderUris = configsWithPlugins
      .filter(config => hasPluginForFile(config.plugins, "notebook.ipynb"))
      .map(config => config.dirUri);
    const defaultFormatterLanguageIds = await getDefaultFormatterLanguageIds();
    if (this.#disposed) {
      return;
    }
    const registrationKey = JSON.stringify([
      folderUris.map(uri => uri.toString()),
      notebookFolderUris.map(uri => uri.toString()),
      defaultFormatterLanguageIds,
      this.#userDataFilePaths,
    ]);
    if (registrationKey === this.#registrationKey) {
      return;
    }
    this.#registrationKey = registrationKey;
    this.#registrationDisposables.dispose();

    const documentSelector: vscode.DocumentFilter[] = [
      // Match against all files and let dprint say if it can format a file or not.
      // A user may use the "associations" of the config file to format any file
      // with a certain plugin and vscode's pattern matching may differ from dprint's,
      // so the "includes" and "excludes" of the config file aren't used here.
      ...folderUris.map(uri => ({ scheme: FILE_SCHEME, pattern: new vscode.RelativePattern(uri, "**/*") })),
      // Notebook cells are formatted when a plugin (the jupyter plugin) formats the notebook.
      // When a notebook type is specified, vscode matches the scheme and pattern against the
      // notebook's uri instead of the cell's.
      ...notebookFolderUris.map(uri => ({
        notebookType: JUPYTER_NOTEBOOK_TYPE,
        scheme: FILE_SCHEME,
        pattern: new vscode.RelativePattern(uri, "**/*"),
      })),
      // Files outside of those are only formatted when the user chose dprint as the
      // default formatter for the language. They're formatted using the file's closest
      // ancestor config file or the global config file. This is limited to those languages
      // so that dprint doesn't cause a "multiple formatters" prompt for other files.
      ...defaultFormatterLanguageIds.flatMap(language => [
        { scheme: FILE_SCHEME, language },
        // untitled documents are formatted as a file in the workspace
        { scheme: UNTITLED_SCHEME, language },
        { notebookType: JUPYTER_NOTEBOOK_TYPE, scheme: FILE_SCHEME, language },
      ]),
      // User data files (ex. the user settings.json) aren't file scheme documents. They're
      // only registered when a plugin in the file's config can format them.
      ...this.#userDataFilePaths.map(pattern => ({ scheme: USER_DATA_SCHEME, pattern })),
    ];
    if (documentSelector.length === 0) {
      return;
    }

    this.#registrationDisposables.push(vscode.languages.registerDocumentFormattingEditProvider(documentSelector, {
      provideDocumentFormattingEdits: async (document, _options, token) => {
        return getProviderEdits(await this.formatDocument(document, undefined, {}, token));
      },
    }));
    this.#registrationDisposables.push(vscode.languages.registerDocumentRangeFormattingEditProvider(documentSelector, {
      provideDocumentRangeFormattingEdits: async (document, range, _options, token) => {
        return getProviderEdits(await this.formatDocument(document, range, {}, token));
      },
    }));
  }

  // This is separate from the formatting registration update so that the workspace
  // registration doesn't wait on starting dprint for a config outside the workspace.
  #scheduleUserDataFilePathsUpdate() {
    this.#userDataFilePathsUpdate = this.#userDataFilePathsUpdate
      .then(async () => {
        const userDataFilePaths = await this.#getFormattableUserDataFilePaths();
        if (!this.#disposed && JSON.stringify(userDataFilePaths) !== JSON.stringify(this.#userDataFilePaths)) {
          this.#userDataFilePaths = userDataFilePaths;
          await this.#scheduleRegistrationUpdate();
        }
      })
      .catch(err => this.#logger.logError("Error updating the user data files to format:", err));
    return this.#userDataFilePathsUpdate;
  }

  /** Gets the paths of the visible user data files that dprint can format. */
  async #getFormattableUserDataFilePaths() {
    // the user data files are on the local machine, so they can't be formatted from a remote extension host
    if (vscode.env.remoteName != null) {
      return [];
    }
    const uris = vscode.window.visibleTextEditors
      .map(editor => editor.document.uri)
      .filter(uri => uri.scheme === USER_DATA_SCHEME);
    if (uris.length === 0) {
      return [];
    }
    const service = await this.#getServiceForFile(uris[0].fsPath);
    if (service == null) {
      return [];
    }
    const canFormat = await Promise.all(uris.map(async uri => {
      try {
        const info = await service.connection.fileInfo({
          filePath: uri.fsPath,
          allowGlobalConfig: getDprintConfig(uri).useGlobalConfig,
        });
        return info.canFormat;
      } catch (err) {
        this.#logger.logError("Error checking if the file can be formatted.", err);
        return false;
      }
    }));
    return [...new Set(uris.filter((_, i) => canFormat[i]).map(uri => uri.fsPath))].sort();
  }
}

/** Gets the settings to send to the editor service. */
function getEditorSettings(): EditorSettings {
  return {
    workspaceFolders: vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [],
    // the setting is resource scoped, so it's sent with each request instead
    allowGlobalConfig: false,
    showNoConfigNotification: getDprintConfig(undefined).showNoConfigNotification,
  };
}

/** Gets the result for a file that dprint didn't format. */
function getFormatDocumentResult(reason: NotFormattedReason, isNotebookCell: boolean): FormatDocumentResult {
  let notFormattedReason: ExtensionNotFormattedReason;
  switch (reason) {
    case "unchanged":
      return { edits: [] };
    case "noConfigFile":
    case "globalConfigNotAllowed":
      notFormattedReason = "noConfigFile";
      break;
    case "noPlugin":
      notFormattedReason = isNotebookCell ? "noCellPlugin" : "noPlugin";
      break;
    default:
      // includes the reasons that are newer than the extension
      notFormattedReason = "notMatched";
      break;
  }
  return { notFormattedReason };
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

function getShowMessageFunction(kind: MessageType) {
  switch (kind) {
    case "warning":
      return vscode.window.showWarningMessage;
    case "error":
      return vscode.window.showErrorMessage;
    default:
      // includes the kinds that are newer than the extension
      return vscode.window.showInformationMessage;
  }
}

async function getDefaultFormatterLanguageIds() {
  const languageIds = await vscode.languages.getLanguages();
  return languageIds.filter(languageId => {
    return isDprintExtensionId(vscode.workspace.getConfiguration("editor", { languageId }).get("defaultFormatter"));
  }).sort();
}

/** Gets the languages contributed by the installed extensions. */
function getLanguageContributions(): LanguageContribution[] {
  return vscode.extensions.all.flatMap(extension => extension.packageJSON?.contributes?.languages ?? []);
}
