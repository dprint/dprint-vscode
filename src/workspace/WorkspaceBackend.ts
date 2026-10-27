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
import { combineConfigSchemas } from "../configSchema";
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
import { getLanguageFiles, type LanguageContribution } from "../languageFileNames";
import type { Logger } from "../logger";
import { hasPluginForFile } from "../pluginFiles";
import { ActivatedDisposables, delay } from "../utils";
import { CoalescingQueue } from "../utils/CoalescingQueue";
import { getConfigDiagnosticMessage, getConfigDiagnosticRange } from "./configDiagnostics";
import { EditorServiceConnection, type ProgressHandle } from "./EditorServiceConnection";
import { getFormatDocumentResult, getProviderEdits } from "./formatResults";
import {
  type ConfigDiagnosticsData,
  type DocumentLanguage,
  type EditorServiceInfo,
  type EditorSettings,
  type FormatFileResult,
  type MessageType,
  parseEditorServiceInfo,
  type PluginInfo,
  SCHEMA_VERSION,
} from "./messages";
import { getUnsupportedError, isUnsupportedService, type UnsupportedService } from "./serviceSupport";

/** How long a state that was replaced waits for its formats in progress before shutting down. */
const RETIRED_FORMAT_TIMEOUT = 10_000;

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
  /** The state being initialized, which replaces the current one once it's ready. */
  #pendingState: WorkspaceState | undefined;
  /** What's kept across the states for the session of the extension. */
  readonly #session: WorkspaceSession = { hasNotifiedNoConfig: false };
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
   * The current state keeps formatting until the new one is ready to replace it, so
   * that formatting (ex. on save) isn't skipped while initializing.
   *
   * @param onSupported - Called once the executables support it and the new state
   * is ready, right before the formatter is registered.
   */
  async initialize(onSupported: () => void): Promise<boolean> {
    this.#logger.setDebug(getDprintConfig(vscode.workspace.workspaceFolders?.[0]?.uri).verbose);
    const state = new WorkspaceState(this.#options, this.#environment, this.#session, () => {
      // the formats in progress finish with the state they started with
      this.#state?.retire();
      this.#state = state;
      onSupported();
    });
    this.#pendingState = state;
    try {
      const configFiles = await this.#findConfigFiles();
      const [configServices, defaultService] = await Promise.all([
        Promise.all(
          configFiles.map(configFile =>
            state.getService(() => this.#createExecutable(configFile.dirUri, configFile.folderUri))
          ),
        ),
        // the files without a config file in the workspace are formatted with this one
        state.getDefaultService(),
      ]);
      const unsupportedError = getUnsupportedError(configServices, defaultService);
      if (unsupportedError != null) {
        this.#logger.logInfo(`Using schema version 5 of the editor service. ${unsupportedError}`);
        state.dispose();
        this.#state?.retire();
        this.#state = undefined;
        return false;
      }
      if (this.#disposed) {
        state.dispose();
        return false;
      }
      if (isUnsupportedService(defaultService)) {
        this.#logger.logWarn(
          `Can't format files without a configuration file in the workspace. ${defaultService.error}`,
        );
      }
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
    } finally {
      if (this.#pendingState === state) {
        this.#pendingState = undefined;
      }
    }
  }

  /**
   * Gets if a change to the settings needs the backend to be initialized again, which is only
   * for the setting of the executable because the others are sent to the editor service.
   */
  affectsInitialization(evt: vscode.ConfigurationChangeEvent) {
    return evt.affectsConfiguration("dprint.path");
  }

  async onConfigFileChanged() {
    // the state being initialized may have gotten the plugins before the change
    await Promise.all([this.#state?.scheduleRefresh(), this.#pendingState?.scheduleRefresh()]);
  }

  provideGlobalConfigFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range | undefined,
    _options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<FormatDocumentResult> {
    if (this.#state == null) {
      this.#logger.logWarn("Can't format with the global configuration file until dprint is initialized.");
      return Promise.resolve({ notFormattedReason: "failed" });
    }
    // the command says why the file wasn't formatted itself
    return this.#state.formatDocument(
      document,
      range,
      { allowGlobalConfig: true, showNoConfigNotification: false },
      token,
    );
  }

  dispose() {
    this.#disposed = true;
    this.#pendingState?.dispose();
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
      // search from the config file's directory so that a project in a sub directory
      // uses the dprint installed in its own node_modules folder
      npmSearchDir: dirUri,
      // this is sent to the editor service, so it doesn't need a process each
      verbose: false,
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

type ServiceResolution = Service | UnsupportedService;

/** What the states share for the session of the extension. */
interface WorkspaceSession {
  /**
   * Whether a format asked an editor service to notify the user about a file without a
   * config file, which is only done once per session even when dprint is started again.
   */
  hasNotifiedNoConfig: boolean;
}

/** What dprint formats a document as. */
interface FormatTarget {
  /** The uri that's sent to dprint, which is a file uri for a user data file (ex. the user settings.json). */
  uri: string;
  /**
   * A path in the directory that the document is formatted in, which decides the editor service
   * and settings to use. It's in the workspace folder for an untitled document and the notebook's
   * directory for a notebook cell.
   */
  filePath: string;
  /** The language of a document that isn't a file, which dprint names the file it's formatted as after. */
  language?: DocumentLanguage;
  notebookUri?: string;
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
  readonly #onActivate: () => void;
  readonly #session: WorkspaceSession;
  readonly #watchedDirPaths = new Set<string>();
  /** The problems with the config files, which are cleared once the state stops. */
  readonly #diagnostics: vscode.DiagnosticCollection;
  /** The formats in progress, which a state that was replaced waits on before shutting down. */
  readonly #formats = new Set<Promise<unknown>>();
  #defaultService: Promise<ServiceResolution> | undefined;
  #configs: Config[] = [];
  /** Whether the config files were set, which is when the plugins can be refreshed. */
  #hasConfigs = false;
  #registrationKey: string | undefined;
  #registrationUpdate = Promise.resolve();
  #userDataFilePaths: string[] = [];
  #userDataFilePathsUpdate = Promise.resolve();
  /** Whether the plugins of the config files were found, which is when the formatter can be registered. */
  #hasRefreshed = false;
  #isActivated = false;
  #disposed = false;

  /** @param onActivate - Called once the state is ready, right before it registers the formatter. */
  constructor(
    options: WorkspaceBackendOptions,
    environment: Environment,
    session: WorkspaceSession,
    onActivate: () => void,
  ) {
    this.#options = options;
    this.#logger = options.logger;
    this.#environment = environment;
    this.#session = session;
    this.#onActivate = onActivate;
    this.#disposables = new ActivatedDisposables(options.logger);
    this.#registrationDisposables = new ActivatedDisposables(options.logger);
    this.#diagnostics = vscode.languages.createDiagnosticCollection("dprint");
    this.#disposables.push(this.#diagnostics);
    // coalesced because saving a config file often causes multiple change events
    this.#refreshQueue = new CoalescingQueue({ action: () => this.refresh(), wait: () => delay(100) });

    // update the formatting registration when the default formatter settings or languages change
    this.#disposables.push(vscode.workspace.onDidChangeConfiguration(evt => {
      this.#scheduleRegistrationUpdate();
      if (evt.affectsConfiguration("dprint.verbose")) {
        this.#logger.setDebug(getDprintConfig(vscode.workspace.workspaceFolders?.[0]?.uri).verbose);
      }
      if (evt.affectsConfiguration("dprint.showNoConfigNotification") || evt.affectsConfiguration("dprint.verbose")) {
        this.#updateSettings();
      }
      // the global config file may format the user data files
      if (evt.affectsConfiguration("dprint.useGlobalConfig")) {
        this.#scheduleUserDataFilePathsUpdate();
      }
    }));
    this.#disposables.push(vscode.extensions.onDidChange(() => this.#scheduleRegistrationUpdate()));
    // update the user data files (ex. the user settings.json) to format when the visible editors change
    this.#disposables.push(vscode.window.onDidChangeVisibleTextEditors(() => this.#scheduleUserDataFilePathsUpdate()));
  }

  dispose() {
    for (const service of this.#stop()) {
      service.then(service => {
        if (!isUnsupportedService(service)) {
          service.connection.dispose();
        }
      });
    }
  }

  /**
   * Stops using the state now that another one replaced it. Its editor services are only
   * shut down once the formats in progress finish, so that a format (ex. on save) during
   * the initialization still gets its edits, and once the user answered their messages.
   */
  retire() {
    if (this.#disposed) {
      return;
    }
    const formats = [...this.#formats].map(format => format.catch(() => {/* ignore */}));
    const services = this.#stop();
    Promise.race([Promise.all(formats), delay(RETIRED_FORMAT_TIMEOUT)]).then(() => {
      for (const service of services) {
        service.then(service => {
          if (!isUnsupportedService(service)) {
            service.connection.disposeWhenIdle();
          }
        });
      }
    });
  }

  setConfigs(configs: Config[]) {
    this.#configs = configs;
    this.#hasConfigs = true;
  }

  /**
   * Gets the editor service of the executable, which is shared with the other executables
   * that are launched the same way.
   */
  async getService(createExecutable: () => Promise<DprintExecutable>): Promise<ServiceResolution> {
    if (this.#disposed) {
      return { error: "The editor service was stopped.", isUnavailable: true };
    }
    let executable: DprintExecutable;
    try {
      // this fails when a command in the "dprint.path" setting fails
      executable = await createExecutable();
    } catch (err) {
      return { error: `Error resolving the dprint executable: ${err}`, isUnavailable: true };
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
    // the initialization refreshes them once it set the config files
    if (!this.#hasConfigs || this.#disposed) {
      return Promise.resolve();
    }
    return this.#refreshQueue.schedule();
  }

  async refresh() {
    if (this.#disposed) {
      return;
    }
    await Promise.all(this.#configs.map(async config => {
      try {
        const info = await config.service.connection.configInfo({
          uri: vscode.Uri.file(config.configFilePath).toString(),
        });
        config.plugins = info.plugins;
        if (info.plugins.length === 0) {
          this.#logger.logWarn("No plugins found in the configuration file:", config.configFilePath);
        }
      } catch (err) {
        config.plugins = [];
        // the editor service shows the user why the config file failed to resolve
        this.#logger.logError(`Error initializing in ${config.dirUri.fsPath}:`, err);
      }
    }));
    if (this.#disposed) {
      return;
    }
    this.#hasRefreshed = true;
    await this.#scheduleRegistrationUpdate();
    // in case updating the registration failed
    this.#activate();
    if (this.#disposed) {
      return;
    }
    // this also tells vscode to get the schema again
    this.#options.configSchemaProvider.setSource({ getConfigSchema: () => this.#getConfigSchema() });
    // don't wait for this because it may need to start dprint for a config outside the workspace
    this.#scheduleUserDataFilePathsUpdate();
    if (this.#configs.length === 0) {
      this.#logger.logInfo("Configuration file not found.");
    }
  }

  /** Formats the document, or only the range when provided, and says why it wasn't formatted when that's the case. */
  formatDocument(
    document: vscode.TextDocument,
    range: vscode.Range | undefined,
    options: FormatDocumentOptions,
    token: vscode.CancellationToken,
  ): Promise<FormatDocumentResult> {
    const format = this.#formatDocument(document, range, options, token);
    this.#formats.add(format);
    format.finally(() => this.#formats.delete(format)).catch(() => {/* ignore */});
    return format;
  }

  watchAncestorConfigFile(configFilePath: string) {
    const dirPath = path.dirname(configFilePath);
    // config files in workspace folders are already watched by the extension
    if (vscode.workspace.workspaceFolders?.some(folder => isPathWithin(folder.uri.fsPath, dirPath))) {
      return;
    }
    // workspace folders in the same directory use the same config file
    if (this.#watchedDirPaths.has(dirPath)) {
      return;
    }
    this.#watchedDirPaths.add(dirPath);
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

  async #formatDocument(
    document: vscode.TextDocument,
    range: vscode.Range | undefined,
    options: FormatDocumentOptions,
    token: vscode.CancellationToken,
  ): Promise<FormatDocumentResult> {
    const target = this.#getFormatTarget(document);
    if (target == null) {
      return { notFormattedReason: "noFilePath" };
    }
    const service = await this.#getServiceForFile(target.filePath);
    if (service == null || token.isCancellationRequested) {
      return service == null ? { notFormattedReason: "failed" } : { edits: [] };
    }
    // the settings of the directory it's formatted in, which is the workspace folder
    // for an untitled document and the notebook's directory for a notebook cell
    const config = getDprintConfig(vscode.Uri.file(target.filePath));
    const allowGlobalConfig = options.allowGlobalConfig ?? config.useGlobalConfig;
    try {
      const showNoConfigNotification = (options.showNoConfigNotification ?? config.showNoConfigNotification)
        && !this.#session.hasNotifiedNoConfig;
      const result = await service.connection.formatFile(
        {
          uri: target.uri,
          language: target.language,
          notebookUri: target.notebookUri,
          // dprint expands the range to whole lines
          range: range == null
            ? undefined
            : { start: document.offsetAt(range.start), end: document.offsetAt(range.end) },
          allowGlobalConfig,
          // otherwise the cli uses the DPRINT_EDITOR_STABLE_FORMAT environment variable like with the legacy backend
          ensureStableFormat: config.ensureStableFormat ? true : undefined,
          showNoConfigNotification,
        },
        document.getText(),
        token,
      );
      if (result == null) {
        return { edits: [] }; // cancelled
      }
      if (result.edits == null) {
        this.#logger.logDebug(`Response - Not formatted (${result.reason}):`, target.uri);
        this.#onNotFormatted(result, showNoConfigNotification);
        return getFormatDocumentResult(result.reason, result.message, target.notebookUri != null);
      }
      this.#logger.logDebug("Response - Formatted:", target.uri);
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

  #onNotFormatted(result: FormatFileResult & { edits?: undefined }, askedToNotifyNoConfig: boolean) {
    switch (result.reason) {
      case "noConfigFile":
      case "globalConfigNotAllowed":
        if (askedToNotifyNoConfig) {
          this.#session.hasNotifiedNoConfig = true;
        }
        break;
      case "configDiagnostics":
        // the editor service shows the user the errors
        this.#logger.logError(result.message ?? (result.diagnostics ?? []).map(getConfigDiagnosticMessage).join("\n"));
        break;
    }
  }

  async #createService(executable: DprintExecutable): Promise<ServiceResolution> {
    let info: ReturnType<typeof parseEditorServiceInfo>;
    try {
      info = parseEditorServiceInfo(await executable.getEditorServiceInfo());
    } catch (err) {
      return {
        error: `Running \`${executable.cmdPath} editor-service --info\` failed: ${err}`,
        // a version of dprint without the flag still runs
        isUnavailable: !await canRun(executable),
      };
    }
    if ("error" in info) {
      return { error: info.error, isUnavailable: false };
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
      showProgress,
      onConfigDiagnostics: data => this.#setConfigDiagnostics(data),
      onConfigChanged: data => {
        this.#logger.logDebug("Configuration changed:", data.uri);
        this.scheduleRefresh();
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
      // don't run executables from arbitrary node_modules folders outside the workspace
      resolveNpmExecutable: false,
      // this is sent to the editor service, so it doesn't need a process each
      verbose: false,
      logger: this.#logger,
      environment: this.#environment,
    });
  }

  /**
   * Gets the schema of the config files in the workspace from dprint. A config file's plugins
   * are in the schema of its executable's editor service, so these are combined when there
   * are multiple executables.
   */
  async #getConfigSchema() {
    const urisByService = new Map<Service, string[]>();
    for (const config of this.#configs) {
      const uris = urisByService.get(config.service) ?? [];
      const uri = vscode.Uri.file(config.configFilePath).toString();
      // workspace folders may use the same config file in an ancestor directory
      if (!uris.includes(uri)) {
        uris.push(uri);
      }
      urisByService.set(config.service, uris);
    }
    const schemas = await Promise.all(
      [...urisByService].map(([service, uris]) =>
        service.connection.configSchema({ uris }).then(response => response.schema)
      ),
    );
    return combineConfigSchemas(schemas);
  }

  /** Gets the editor service of the config file in the workspace that's closest to the file or otherwise the default one. */
  async #getServiceForFile(filePath: string): Promise<Service | undefined> {
    const config = findClosestFolder(this.#configs, config => config.dirUri.fsPath, filePath);
    if (config != null) {
      return config.service;
    }
    const service = await this.getDefaultService();
    if (isUnsupportedService(service)) {
      this.#logger.logWarn(`Can't format files without a configuration file in the workspace. ${service.error}`);
      return undefined;
    }
    return service;
  }

  /**
   * Gets what dprint formats the document as. A document that isn't a file is formatted as a
   * file that dprint names after its language. That's in the first workspace folder (or the
   * home directory) for an untitled document, which is where dprint formats it too.
   */
  #getFormatTarget(document: vscode.TextDocument): FormatTarget | undefined {
    if (document.uri.scheme === NOTEBOOK_CELL_SCHEME) {
      return this.#getNotebookCellFormatTarget(document);
    }
    if (document.uri.scheme === UNTITLED_SCHEME) {
      const dirPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.#environment.homeDir();
      if (dirPath == null) {
        this.#logger.logInfo("Could not determine a directory to format the untitled document in.");
        return undefined;
      }
      return {
        uri: document.uri.toString(),
        filePath: path.join(dirPath, "Untitled"),
        language: getDocumentLanguage(document.languageId),
      };
    }
    // a user data file (ex. the user settings.json) is formatted as the file it is on disk
    return { uri: vscode.Uri.file(document.fileName).toString(), filePath: document.fileName };
  }

  /**
   * A notebook cell is formatted as a file in the notebook's directory named based
   * on its language, which is how the jupyter plugin formats a notebook's code cells.
   */
  #getNotebookCellFormatTarget(document: vscode.TextDocument): FormatTarget | undefined {
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
    return {
      uri: document.uri.toString(),
      filePath: path.join(path.dirname(notebook.uri.fsPath), "code_block"),
      language: getDocumentLanguage(document.languageId),
      notebookUri: notebook.uri.toString(),
    };
  }

  /** Shows the problems with a config file, which replace the ones shown before for it. */
  #setConfigDiagnostics(data: ConfigDiagnosticsData) {
    // a state that was replaced may still get these until its editor services shut down
    if (this.#disposed) {
      return;
    }
    this.#diagnostics.set(
      vscode.Uri.parse(data.uri),
      data.diagnostics.map(configDiagnostic => {
        const range = getConfigDiagnosticRange(configDiagnostic);
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character),
          getConfigDiagnosticMessage(configDiagnostic),
          vscode.DiagnosticSeverity.Error,
        );
        diagnostic.source = "dprint";
        return diagnostic;
      }),
    );
  }

  /** Stops the state's listeners and formatter, which provides its editor services to shut down. */
  #stop() {
    this.#disposed = true;
    this.#registrationDisposables.dispose();
    this.#disposables.dispose();
    const services = [...this.#services.values()];
    this.#services.clear();
    return services;
  }

  /** Has this state replace the current one, which is only done once. */
  #activate() {
    if (this.#isActivated || this.#disposed) {
      return;
    }
    this.#isActivated = true;
    this.#onActivate();
  }

  #updateSettings() {
    for (const service of this.#services.values()) {
      service.then(async service => {
        if (!isUnsupportedService(service)) {
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
    if (!this.#hasRefreshed) {
      return;
    }
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
    // this unregisters the formatter of the state it replaces, so it's synchronous with registering this one
    this.#activate();
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
        // the refresh updates these once the config files are known
        if (!this.#hasRefreshed) {
          return;
        }
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
          uri: vscode.Uri.file(uri.fsPath).toString(),
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

interface FormatDocumentOptions {
  allowGlobalConfig?: boolean;
  showNoConfigNotification?: boolean;
}

/** Gets if the executable runs, which is false when it's not installed. */
async function canRun(executable: DprintExecutable) {
  try {
    await executable.execShell(["--version"], undefined, undefined);
    return true;
  } catch {
    return false;
  }
}

/** Gets the settings to send to the editor service. */
function getEditorSettings(): EditorSettings {
  return {
    workspaceFolders: vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()) ?? [],
    // the setting is resource scoped, so it's sent with each request instead
    allowGlobalConfig: false,
    showNoConfigNotification: getDprintConfig(undefined).showNoConfigNotification,
    verbose: getDprintConfig(vscode.workspace.workspaceFolders?.[0]?.uri).verbose,
  };
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

/** Gets the language of a document that isn't a file, which dprint names the file it's formatted as after. */
function getDocumentLanguage(languageId: string): DocumentLanguage {
  return { id: languageId, ...getLanguageFiles(getLanguageContributions(), languageId) };
}

/** Gets the languages contributed by the installed extensions. */
function getLanguageContributions(): LanguageContribution[] {
  return vscode.extensions.all.flatMap(extension => extension.packageJSON?.contributes?.languages ?? []);
}

/**
 * Shows the progress of something dprint is doing (ex. downloading a plugin) in the
 * status bar, which doesn't interrupt the user like a notification would.
 */
function showProgress(title: string, percentage: number | undefined): ProgressHandle {
  let lastPercentage = percentage;
  let report: ((percentage: number) => void) | undefined;
  let end!: () => void;
  const ended = new Promise<void>(resolve => end = resolve);
  vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `dprint: ${title}` }, progress => {
    report = percentage => progress.report({ message: `${Math.round(percentage)}%` });
    if (lastPercentage != null) {
      report(lastPercentage);
    }
    return ended;
  });
  return {
    report(percentage) {
      lastPercentage = percentage;
      report?.(percentage);
    },
    end,
  };
}
