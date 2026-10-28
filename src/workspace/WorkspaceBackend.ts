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
import {
  getLanguageFiles,
  getNotebookCellFileNames,
  getUntitledFileNames,
  type LanguageContribution,
} from "../languageFileNames";
import { FolderService } from "../legacy/FolderService";
import type { Logger } from "../logger";
import { hasPluginForFile, type PluginFileInfo } from "../pluginFiles";
import { ActivatedDisposables, delay } from "../utils";
import { CoalescingQueue } from "../utils/CoalescingQueue";
import { getConfigDiagnosticMessage, getConfigDiagnosticRange } from "./configDiagnostics";
import { getConfigFilePatterns } from "./documentPatterns";
import { EditorServiceConnection, type ProgressHandle } from "./EditorServiceConnection";
import { getFormatDocumentResult, getProviderEdits } from "./formatResults";
import {
  type ConfigDiagnosticsData,
  type ConfigInfoResponseData,
  type DocumentLanguage,
  type EditorServiceInfo,
  type EditorSettings,
  FormatFailedError,
  type FormatFileResult,
  type MessageType,
  parseEditorServiceInfo,
  SCHEMA_VERSION,
} from "./messages";
import { getUnsupportedError, isOldDprintError, isUnsupportedService, type UnsupportedService } from "./serviceSupport";

/** How long a state that was replaced waits for its formats in progress before its editor services shut down. */
const RETIRED_FORMAT_TIMEOUT = 10_000;
/** The context key for if a config file's process plugins weren't allowed, which shows the command to allow them. */
const HAS_PROCESS_PLUGINS_NOT_ALLOWED_CONTEXT_KEY = "dprint.hasProcessPluginsNotAllowed";

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
 * when a project in the workspace has dprint in its node_modules folder). A config
 * file whose executable is a version of dprint without it is formatted with a
 * process of schema version 5 instead.
 */
export class WorkspaceBackend implements vscode.Disposable {
  readonly #options: WorkspaceBackendOptions;
  readonly #logger: Logger;
  readonly #environment: Environment;
  #state: WorkspaceState | undefined;
  /** The state being initialized, which replaces the current one once it's ready. */
  #pendingState: WorkspaceState | undefined;
  /**
   * The editor services by their executable and its version, which are kept across the states
   * so that dprint isn't started again when the workspace changes (ex. a config file is created).
   * That keeps what the user chose for the session (ex. allowing process plugins).
   */
  readonly #services = new Map<string, Promise<ServiceResolution>>();
  /** The problems with the config files. */
  readonly #diagnostics: vscode.DiagnosticCollection;
  /** The config files each editor service sent problems for, which are cleared once it stops. */
  readonly #diagnosticUris = new Map<EditorServiceConnection, Set<string>>();
  /** What's kept across the states for the session of the extension. */
  readonly #session: WorkspaceSession = { hasNotifiedNoConfig: false };
  #disposed = false;

  constructor(options: WorkspaceBackendOptions) {
    this.#options = options;
    this.#logger = options.logger;
    this.#environment = new RealEnvironment(options.logger);
    this.#diagnostics = vscode.languages.createDiagnosticCollection("dprint");
  }

  /**
   * Starts formatting the workspace, which is false when the default dprint executable
   * doesn't support schema version 6. Nothing is registered in that case.
   *
   * The current state keeps formatting until the new one is ready to replace it, so
   * that formatting (ex. on save) isn't skipped while initializing. The editor services
   * of the executables that are still in use are kept.
   *
   * @param onSupported - Called once the executables support it and the new state
   * is ready, right before the formatter is registered.
   * @param options.reset - Has the editor services that are kept start their plugins
   * again (ex. for the restart command).
   */
  async initialize(onSupported: () => void, options: { reset?: boolean } = {}): Promise<boolean> {
    this.#logger.setDebug(getDprintConfig(vscode.workspace.workspaceFolders?.[0]?.uri).verbose);
    const state = new WorkspaceState({
      options: this.#options,
      environment: this.#environment,
      session: this.#session,
      getService: executable => this.#getService(executable),
      onActivate: () => {
        // the formats in progress finish with the state they started with
        const retiredState = this.#state;
        this.#state = state;
        retiredState?.retire().then(() => this.#disposeUnusedServices());
        onSupported();
      },
    });
    this.#pendingState = state;
    try {
      const configFiles = await this.#findConfigFiles();
      await this.#clearDeletedConfigDiagnostics();
      const [configServices, defaultService] = await Promise.all([
        Promise.all(
          configFiles.map(configFile =>
            state.getService(() => this.#createExecutable(configFile.dirUri, configFile.folderUri))
          ),
        ),
        // the files without a config file in the workspace are formatted with this one
        state.getDefaultService(),
      ]);
      const unsupportedError = getUnsupportedError(defaultService, configFiles.length > 0);
      if (unsupportedError != null) {
        this.#logger.logInfo(`Using schema version 5 of the editor service. ${unsupportedError}`);
        state.dispose();
        this.#pendingState = undefined;
        const retiredState = this.#state;
        this.#state = undefined;
        (retiredState?.retire() ?? Promise.resolve()).then(() => this.#disposeUnusedServices());
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
      state.setConfigs(configFiles.map((configFile, i) => {
        const service = configServices[i];
        if (!isUnsupportedService(service)) {
          return { ...configFile, service, legacyFolder: undefined, info: undefined };
        }
        this.#logger.logInfo(
          `Using schema version 5 of the editor service for ${configFile.configFilePath}. ${service.error}`,
        );
        return {
          ...configFile,
          service: undefined,
          legacyFolder: this.#createLegacyFolder(configFile),
          info: undefined,
        };
      }));
      for (const configFile of configFiles) {
        if (configFile.isAncestor) {
          state.watchAncestorConfigFile(configFile.configFilePath);
        }
      }
      // the services that are kept may have been started with other settings (ex. workspace folders)
      await Promise.all(state.services.map(async service => {
        try {
          await service.connection.updateSettings(getEditorSettings());
          if (options.reset) {
            await service.connection.reset();
          }
        } catch (err) {
          this.#logger.logError("Error updating the editor service:", err);
        }
      }));
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
      range == null ? undefined : [range],
      { allowGlobalConfig: true, showNoConfigNotification: false },
      token,
    );
  }

  /**
   * Gets if the document would be formatted with the global config file, which is when the commands
   * for it apply. This is undefined until dprint is initialized.
   */
  canFormatWithGlobalConfig(document: vscode.TextDocument): Promise<boolean | undefined> {
    return this.#state?.canFormatWithGlobalConfig(document) ?? Promise.resolve(undefined);
  }

  /** Asks the user whether to allow the process plugins of the config files that weren't allowed. */
  allowProcessPlugins() {
    return this.#state?.allowProcessPlugins() ?? Promise.resolve();
  }

  dispose() {
    this.#disposed = true;
    this.#pendingState?.dispose();
    this.#state?.dispose();
    this.#state = undefined;
    this.#disposeUnusedServices();
    this.#diagnostics.dispose();
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

  /** Formats the files of a config file whose executable doesn't support schema version 6. */
  #createLegacyFolder(configFile: ConfigFile) {
    return new FolderService({
      approvedPaths: this.#options.approvedPaths,
      cwd: configFile.folderUri,
      configUri: vscode.Uri.file(configFile.configFilePath),
      logger: this.#logger,
    });
  }

  /**
   * Gets the editor service of the executable, which is the one that's kept from before when
   * it's the same executable with the same version of dprint.
   */
  async #getService(executable: DprintExecutable): Promise<ServiceResolution> {
    let info: ReturnType<typeof parseEditorServiceInfo>;
    try {
      info = parseEditorServiceInfo(await executable.getEditorServiceInfo());
    } catch (err) {
      return {
        error: `Running \`${executable.cmdPath} editor-service --info\` failed: ${err}`,
        // a version of dprint without the flag still runs
        isUnavailable: !isOldDprintError(err),
      };
    }
    if ("error" in info) {
      return { error: info.error, isUnavailable: false };
    }
    // a different version of the executable (ex. after updating it) or a different environment
    // of dprint (ex. a different global config directory) needs a new process
    const key = JSON.stringify([executable.processKey, info.cliVersion, getDprintEnvVars()]);
    let service = this.#services.get(key);
    if (service == null) {
      service = Promise.resolve(this.#createService(key, executable, info));
      this.#services.set(key, service);
    }
    return service;
  }

  #createService(key: string, executable: DprintExecutable, info: EditorServiceInfo): Service {
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
      onConfigDiagnostics: data => this.#setConfigDiagnostics(connection, data),
      onConfigChanged: data => {
        this.#logger.logDebug("Configuration changed:", data.uri);
        this.onConfigFileChanged().catch(err => this.#logger.logError("Error refreshing:", err));
      },
      logger: this.#logger,
    });
    this.#logger.logInfo(
      `Initialized dprint ${info.cliVersion} (editor service schema version ${SCHEMA_VERSION})\n`
        + `  Command: ${executable.cmdPath}`,
    );
    return { key, connection, info, executable };
  }

  /** Shuts down the editor services that the states don't use anymore. */
  #disposeUnusedServices() {
    const usedKeys = new Set([...this.#state?.serviceKeys ?? [], ...this.#pendingState?.serviceKeys ?? []]);
    for (const [key, service] of [...this.#services]) {
      if (usedKeys.has(key) && !this.#disposed) {
        continue;
      }
      this.#services.delete(key);
      service.then(service => {
        if (isUnsupportedService(service)) {
          return;
        }
        // the config files of a service that stopped aren't checked anymore
        for (const uri of this.#diagnosticUris.get(service.connection) ?? []) {
          this.#diagnostics.delete(vscode.Uri.parse(uri));
        }
        this.#diagnosticUris.delete(service.connection);
        if (this.#disposed) {
          service.connection.dispose();
        } else {
          service.connection.disposeWhenIdle();
        }
      });
    }
  }

  /** Clears the problems of the config files that were deleted, which dprint doesn't check anymore. */
  async #clearDeletedConfigDiagnostics() {
    for (const uris of this.#diagnosticUris.values()) {
      for (const uri of [...uris]) {
        const fileUri = vscode.Uri.parse(uri);
        if (fileUri.scheme === FILE_SCHEME && !await this.#environment.fileExists(fileUri.fsPath)) {
          uris.delete(uri);
          this.#diagnostics.delete(fileUri);
        }
      }
    }
  }

  /** Shows the problems with a config file, which replace the ones shown before for it. */
  #setConfigDiagnostics(connection: EditorServiceConnection, data: ConfigDiagnosticsData) {
    if (this.#disposed) {
      return;
    }
    let uris = this.#diagnosticUris.get(connection);
    if (uris == null) {
      uris = new Set();
      this.#diagnosticUris.set(connection, uris);
    }
    uris.add(data.uri);
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

/** A config file and what formats its files, which is either an editor service or a legacy folder. */
interface Config extends ConfigFile {
  service: Service | undefined;
  /** Formats the files with schema version 5 when the executable doesn't support schema version 6. */
  legacyFolder: FolderService | undefined;
  /** What the editor service says about the config file, which is undefined until it's known. */
  info: ConfigInfoResponseData | undefined;
}

/** An editor service process and what its executable supports. */
interface Service {
  /** Identifies the executable and its version. */
  key: string;
  connection: EditorServiceConnection;
  info: EditorServiceInfo;
  executable: DprintExecutable;
}

type ServiceResolution = Service | UnsupportedService;

/** What the states share for the session of the extension. */
interface WorkspaceSession {
  /**
   * Whether a format asked an editor service to notify the user about a file without a
   * config file, which is only done once per session even when there are several.
   */
  hasNotifiedNoConfig: boolean;
}

/** What dprint formats a document as. */
interface FormatTarget {
  /** The uri that's sent to dprint, which is a file uri for a user data file (ex. the user settings.json). */
  uri: string;
  /**
   * A path in the directory that the document is formatted in, which decides the editor service
   * to use. It's in the workspace folder for an untitled document and the notebook's directory for
   * a notebook cell.
   */
  filePath: string;
  /** The language of a document that isn't a file, which dprint names the file it's formatted as after. */
  language?: DocumentLanguage;
  notebookUri?: string;
}

interface WorkspaceStateOptions {
  options: WorkspaceBackendOptions;
  environment: Environment;
  session: WorkspaceSession;
  /** Gets the editor service of the executable, which may be one that's kept from another state. */
  getService(executable: DprintExecutable): Promise<ServiceResolution>;
  /** Called once the state is ready, right before it registers the formatter. */
  onActivate(): void;
}

/** What's found for one initialization of the workspace. */
class WorkspaceState {
  readonly #options: WorkspaceBackendOptions;
  readonly #logger: Logger;
  readonly #environment: Environment;
  readonly #disposables: ActivatedDisposables;
  readonly #registrationDisposables: ActivatedDisposables;
  /** The editor services by the process key of their executable. */
  readonly #services = new Map<string, Promise<ServiceResolution>>();
  /** The editor services that were resolved. */
  readonly #resolvedServices: Service[] = [];
  readonly #refreshQueue: CoalescingQueue;
  readonly #getServiceForExecutable: (executable: DprintExecutable) => Promise<ServiceResolution>;
  readonly #onActivate: () => void;
  readonly #session: WorkspaceSession;
  readonly #watchedDirPaths = new Set<string>();
  /** The formats in progress, which a state that was replaced waits on before its services shut down. */
  readonly #formats = new Set<Promise<unknown>>();
  /** The messages of the plugin errors that were shown, which are only shown once. */
  readonly #shownPluginErrors = new Set<string>();
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

  constructor(stateOptions: WorkspaceStateOptions) {
    const options = stateOptions.options;
    this.#options = options;
    this.#logger = options.logger;
    this.#environment = stateOptions.environment;
    this.#session = stateOptions.session;
    this.#getServiceForExecutable = stateOptions.getService;
    this.#onActivate = stateOptions.onActivate;
    this.#disposables = new ActivatedDisposables(options.logger);
    this.#registrationDisposables = new ActivatedDisposables(options.logger);
    // coalesced because saving a config file often causes multiple change events
    this.#refreshQueue = new CoalescingQueue({ action: () => this.refresh(), wait: () => delay(100) });

    // update the formatting registration when the default formatter settings or languages change
    this.#disposables.push(vscode.workspace.onDidChangeConfiguration(evt => {
      this.#scheduleRegistrationUpdate();
      if (evt.affectsConfiguration("dprint.verbose")) {
        this.#logger.setDebug(getDprintConfig(vscode.workspace.workspaceFolders?.[0]?.uri).verbose);
      }
      if (
        ["showNoConfigNotification", "verbose", "useGlobalConfig", "ensureStableFormat"]
          .some(setting => evt.affectsConfiguration(`dprint.${setting}`))
      ) {
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

  /** The keys of the editor services the state uses, which aren't shut down while it does. */
  get serviceKeys() {
    return this.#resolvedServices.map(service => service.key);
  }

  /** The editor services the state uses. */
  get services(): readonly Service[] {
    return this.#resolvedServices;
  }

  /** Stops the state, which leaves its editor services to the backend. */
  dispose() {
    this.#stop();
    this.#disposeLegacyFolders();
  }

  /**
   * Stops using the state now that another one replaced it, which resolves once the formats
   * in progress finish so that a format (ex. on save) during the initialization still gets
   * its edits before the editor services that aren't used anymore are shut down.
   */
  retire() {
    if (this.#disposed) {
      return Promise.resolve();
    }
    const formats = [...this.#formats].map(format => format.catch(() => {/* ignore */}));
    this.#stop();
    return Promise.race([Promise.all(formats), delay(RETIRED_FORMAT_TIMEOUT)]).then(() => this.#disposeLegacyFolders());
  }

  setConfigs(configs: Config[]) {
    this.#configs = configs;
    this.#hasConfigs = true;
  }

  /** Gets the editor service of the executable, which is shared with the other config files that use it. */
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
      service = this.#getServiceForExecutable(executable).then(service => {
        if (!isUnsupportedService(service)) {
          this.#resolvedServices.push(service);
        }
        return service;
      });
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
    await Promise.all(this.#configs.map(config => this.#refreshConfig(config)));
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
    await vscode.commands.executeCommand(
      "setContext",
      HAS_PROCESS_PLUGINS_NOT_ALLOWED_CONTEXT_KEY,
      this.#configs.some(config => config.info?.reason === "processPluginsNotAllowed"),
    );
    // this also tells vscode to get the schema again
    this.#options.configSchemaProvider.setSource({ getConfigSchema: () => this.#getConfigSchema() });
    // don't wait for this because it may need to start dprint for a config outside the workspace
    this.#scheduleUserDataFilePathsUpdate();
    if (this.#configs.length === 0) {
      this.#logger.logInfo("Configuration file not found.");
    }
  }

  /**
   * Formats the document, or only the ranges when provided, and says why it wasn't formatted
   * when that's the case.
   */
  formatDocument(
    document: vscode.TextDocument,
    ranges: readonly vscode.Range[] | undefined,
    options: FormatDocumentOptions,
    token: vscode.CancellationToken,
  ): Promise<FormatDocumentResult> {
    const format = this.#formatDocument(document, ranges, options, token);
    this.#formats.add(format);
    format.finally(() => this.#formats.delete(format)).catch(() => {/* ignore */});
    return format;
  }

  /** Gets if the document would be formatted with the global config file. */
  async canFormatWithGlobalConfig(document: vscode.TextDocument) {
    const target = this.#getFormatTarget(document);
    if (target == null) {
      return false;
    }
    const config = this.#getConfigForFile(target.filePath);
    if (config != null) {
      return false;
    }
    const service = await this.#getDefaultServiceOrWarn();
    if (service == null) {
      return false;
    }
    const info = await service.connection.fileInfo({
      uri: target.uri,
      language: target.language,
      notebookUri: target.notebookUri,
      allowGlobalConfig: true,
    });
    return info.configFile?.isGlobal === true;
  }

  /** Asks the user whether to allow the process plugins of the config files that weren't allowed. */
  async allowProcessPlugins() {
    const configs = this.#configs.filter(config => config.info?.reason === "processPluginsNotAllowed");
    if (configs.length === 0) {
      vscode.window.showInformationMessage("The process plugins of the configuration files are allowed.");
      return;
    }
    // ask about the config file of the active document first
    const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
    const activeConfig = activePath == null
      ? undefined
      : findClosestFolder(configs, config => config.dirUri.fsPath, activePath);
    const orderedConfigs = activeConfig == null ? configs : [activeConfig, ...configs.filter(c => c !== activeConfig)];
    const asked = new Set<string>();
    for (const config of orderedConfigs) {
      if (config.service == null || asked.has(config.configFilePath)) {
        continue;
      }
      asked.add(config.configFilePath);
      try {
        await config.service.connection.askToAllowProcessPlugins({
          uri: vscode.Uri.file(config.configFilePath).toString(),
        });
      } catch (err) {
        this.#logger.logError("Error asking to allow the process plugins:", err);
      }
    }
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

  async #refreshConfig(config: Config) {
    if (config.legacyFolder != null) {
      // a running folder reloads its config itself, so only its plugins are gotten again
      const isRunning = config.legacyFolder.isRunning() && await config.legacyFolder.refreshEditorInfo();
      if (!isRunning) {
        await config.legacyFolder.initialize();
      }
      return;
    }
    if (config.service == null) {
      return;
    }
    try {
      config.info = await config.service.connection.configInfo({
        uri: vscode.Uri.file(config.configFilePath).toString(),
      });
      if (config.info.reason != null) {
        this.#logger.logInfo(
          `Not formatting with ${config.configFilePath}:`,
          config.info.message ?? config.info.reason,
        );
      } else if (config.info.plugins.length === 0) {
        this.#logger.logWarn("No plugins found in the configuration file:", config.configFilePath);
      }
    } catch (err) {
      config.info = undefined;
      this.#logger.logError(`Error initializing in ${config.dirUri.fsPath}:`, err);
    }
  }

  async #formatDocument(
    document: vscode.TextDocument,
    ranges: readonly vscode.Range[] | undefined,
    options: FormatDocumentOptions,
    token: vscode.CancellationToken,
  ): Promise<FormatDocumentResult> {
    const target = this.#getFormatTarget(document);
    if (target == null) {
      return { notFormattedReason: "noFilePath" };
    }
    const config = this.#getConfigForFile(target.filePath);
    if (config?.legacyFolder != null) {
      return this.#formatLegacyDocument(config.legacyFolder, document, target, ranges, token);
    }
    const service = config?.service ?? await this.#getDefaultServiceOrWarn();
    if (service == null || token.isCancellationRequested) {
      return service == null ? { notFormattedReason: "failed" } : { edits: [] };
    }
    // the settings are the ones of the directory it's formatted in, which the editor service has
    const showNoConfigNotification = options.showNoConfigNotification
      ?? (this.#session.hasNotifiedNoConfig ? false : undefined);
    try {
      const result = await service.connection.formatFile(
        {
          uri: target.uri,
          language: target.language,
          notebookUri: target.notebookUri,
          ranges: ranges?.map(range => ({ start: document.offsetAt(range.start), end: document.offsetAt(range.end) })),
          allowGlobalConfig: options.allowGlobalConfig,
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
        this.#onNotFormatted(result, showNoConfigNotification !== false);
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
      this.#onFormatError(err);
      return { notFormattedReason: "failed" };
    }
  }

  /** Formats the document with a config file whose executable doesn't support schema version 6. */
  async #formatLegacyDocument(
    folder: FolderService,
    document: vscode.TextDocument,
    target: FormatTarget,
    ranges: readonly vscode.Range[] | undefined,
    token: vscode.CancellationToken,
  ): Promise<FormatDocumentResult> {
    const fileNames = target.language == null
      ? [path.basename(target.filePath)]
      : target.notebookUri != null
      ? getNotebookCellFileNames(getLanguageContributions(), target.language.id)
      : getUntitledFileNames(getLanguageContributions(), target.language.id);
    const fileName = fileNames.find(fileName => folder.hasPluginForFile(fileName)) ?? fileNames[0];
    if (fileName == null) {
      return { notFormattedReason: "noFilePath" };
    }
    const file = {
      filePath: path.join(path.dirname(target.filePath), fileName),
      notebookPath: target.notebookUri == null ? undefined : vscode.Uri.parse(target.notebookUri).fsPath,
    };
    if (ranges == null) {
      return folder.formatDocument(document, file, undefined, token);
    }
    // the edits of each range are within its lines, so the ones of ranges on other lines don't overlap
    const edits: vscode.TextEdit[] = [];
    for (const range of ranges) {
      const result = await folder.formatDocument(document, file, range, token);
      if (result.edits == null) {
        return result;
      }
      for (const edit of result.edits) {
        if (!edits.some(other => other.range.intersection(edit.range) != null)) {
          edits.push(edit);
        }
      }
    }
    return { edits };
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
      case "configError":
        // the editor service shows the user the error
        this.#logger.logError(result.message ?? "The configuration file failed to resolve.");
        break;
    }
  }

  #onFormatError(err: unknown) {
    if (!(err instanceof FormatFailedError)) {
      this.#logger.logError("Error formatting text.", err);
      return;
    }
    // a syntax error isn't shown because a format usually happens without the user doing anything
    // (ex. on save) and the editor already shows it
    if (err.reason === "formatError") {
      this.#logger.logWarn("Error formatting text:", err.message);
      return;
    }
    this.#logger.logError("Error formatting text:", err.message);
    if (!this.#shownPluginErrors.has(err.message)) {
      this.#shownPluginErrors.add(err.message);
      vscode.window.showErrorMessage(`dprint failed to format the document: ${err.message}`);
    }
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
      if (config.service == null) {
        continue;
      }
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

  /** Gets the config file in the workspace that's closest to the file. */
  #getConfigForFile(filePath: string) {
    return findClosestFolder(this.#configs, config => config.dirUri.fsPath, filePath);
  }

  /** Gets the editor service of the config file in the workspace that's closest to the file or otherwise the default one. */
  async #getServiceForFile(filePath: string): Promise<Service | undefined> {
    const config = this.#getConfigForFile(filePath);
    if (config != null) {
      return config.service;
    }
    return this.#getDefaultServiceOrWarn();
  }

  async #getDefaultServiceOrWarn() {
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

  /** Stops the state's listeners and formatter. */
  #stop() {
    this.#disposed = true;
    this.#registrationDisposables.dispose();
    this.#disposables.dispose();
  }

  #disposeLegacyFolders() {
    for (const config of this.#configs) {
      config.legacyFolder?.dispose();
    }
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
    for (const service of this.#resolvedServices) {
      service.connection.updateSettings(getEditorSettings()).catch(err => {
        this.#logger.logError("Error updating the settings of the editor service:", err);
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
    const folderPatterns = this.#configs.flatMap(config =>
      this.#getConfigPatterns(config).map(pattern => ({ uri: config.dirUri, pattern }))
    );
    const notebookFolderUris = this.#configs
      .filter(config => hasPluginForFile(this.#getConfigPlugins(config), "notebook.ipynb"))
      .map(config => config.dirUri);
    const defaultFormatterLanguageIds = await getDefaultFormatterLanguageIds();
    if (this.#disposed) {
      return;
    }
    const registrationKey = JSON.stringify([
      folderPatterns.map(({ uri, pattern }) => [uri.toString(), pattern]),
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
      // The files the plugins of a config file format by their extension or name, which dprint
      // says if it formats (ex. the "includes" and "excludes" of the config file aren't used here
      // because they're matched differently than a glob). It's every file when that's not known.
      ...folderPatterns.map(({ uri, pattern }) => ({
        scheme: FILE_SCHEME,
        pattern: new vscode.RelativePattern(uri, pattern),
      })),
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
        return getProviderEdits(await this.formatDocument(document, [range], {}, token));
      },
      // dprint formats several ranges at once (ex. "format modifications" on save)
      provideDocumentRangesFormattingEdits: async (document, ranges, _options, token) => {
        return getProviderEdits(await this.formatDocument(document, ranges, {}, token));
      },
    }));
  }

  /** Gets the glob patterns of the files the config file may format. */
  #getConfigPatterns(config: Config) {
    if (config.legacyFolder != null) {
      // the plugins of a legacy folder don't say which other files they format (ex. their associations)
      return config.legacyFolder.getEditorInfo()?.plugins.length ? ["**/*"] : [];
    }
    return config.info == null ? [] : getConfigFilePatterns(config.info);
  }

  #getConfigPlugins(config: Config): readonly PluginFileInfo[] {
    return config.legacyFolder?.getEditorInfo()?.plugins ?? config.info?.plugins ?? [];
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
        // the editor service uses the setting of the directory, which isn't a workspace folder
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
  /** Allows the global config file regardless of the setting (ex. for a command). */
  allowGlobalConfig?: boolean;
  showNoConfigNotification?: boolean;
}

/** Gets the settings to send to the editor service, which has the settings of each workspace folder. */
function getEditorSettings(): EditorSettings {
  const config = getDprintConfig(undefined);
  return {
    workspaceFolders: vscode.workspace.workspaceFolders?.map(folder => {
      const folderConfig = getDprintConfig(folder.uri);
      return {
        uri: folder.uri.toString(),
        allowGlobalConfig: folderConfig.useGlobalConfig,
        // otherwise the cli uses the DPRINT_EDITOR_STABLE_FORMAT environment variable like with the legacy backend
        ensureStableFormat: folderConfig.ensureStableFormat ? true : undefined,
      };
    }) ?? [],
    allowGlobalConfig: config.useGlobalConfig,
    ensureStableFormat: config.ensureStableFormat ? true : undefined,
    showNoConfigNotification: config.showNoConfigNotification,
    verbose: getDprintConfig(vscode.workspace.workspaceFolders?.[0]?.uri).verbose,
  };
}

/** Gets the environment variables of dprint (ex. `DPRINT_CONFIG_DIR`) that a process is started with. */
function getDprintEnvVars() {
  return Object.entries(process.env)
    .filter(([name]) => name.toUpperCase().startsWith("DPRINT_"))
    .sort(([a], [b]) => a.localeCompare(b));
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
