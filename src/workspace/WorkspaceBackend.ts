import * as path from "node:path";
import * as vscode from "vscode";
import type { ApprovedConfigPaths } from "../ApprovedConfigPaths";
import { getDprintConfig } from "../config";
import { discoverWorkspaceConfigFiles } from "../configFile";
import type { ConfigJsonSchemaProvider } from "../ConfigJsonSchemaProvider";
import {
  filterCacheDirConfigFiles,
  filterUnusedConfigFiles,
  findClosestFolder,
  findWorkspaceFolderAncestorConfigFile,
  getConfigFileDir,
  isPathWithin,
} from "../configPaths";
import { combineConfigSchemas } from "../configSchema";
import {
  DPRINT_DIR_CONFIG_FILE_GLOB,
  FILE_SCHEME,
  isDprintExtensionId,
  JUPYTER_NOTEBOOK_TYPE,
  NOTEBOOK_CELL_SCHEME,
  UNTITLED_SCHEME,
  USER_DATA_SCHEME,
} from "../constants";
import { type Environment, RealEnvironment } from "../environment";
import { DprintExecutable } from "../executable/DprintExecutable";
import type { ConfigFileChangeType, FormatDocumentResult } from "../ExtensionBackend";
import {
  getLanguageFiles,
  getNotebookCellFileNames,
  getUntitledFileNames,
  type LanguageContribution,
} from "../languageFileNames";
import { FolderService } from "../legacy/FolderService";
import type { Logger } from "../logger";
import { getNoConfigMessage } from "../noConfigMessage";
import { hasPluginForFile, type PluginFileInfo } from "../pluginFiles";
import { ActivatedDisposables, delay } from "../utils";
import { CoalescingQueue } from "../utils/CoalescingQueue";
import {
  type ApprovalChoice,
  Approvals,
  getApprovalDetails,
  getApprovalMessage,
  getDisplayPath,
  SHOW_DETAILS_TITLE,
  toPlainNotificationText,
} from "./approvals";
import { getConfigFilePatterns } from "./documentPatterns";
import { getFormatDocumentResult, getProviderEdits, ShownConfigErrors } from "./formatResults";
import { FileChangeType, LspConnection, type ProgressHandle } from "./LspConnection";
import {
  type Action,
  type ConfigApprovals,
  type ConfigFileInfo,
  type ConfigInfoResult,
  type DocumentLanguage,
  type FormatResult,
  type FormatStatus,
  getNotFormatted,
  type MessageParams,
  MessageType,
  type NotFormattedResult,
  type Notice,
  type PendingApproval,
  type PublishDiagnosticsParams,
  type Severity,
  type ShowPolicy,
  type TextRange,
  type WorkspaceFolder,
} from "./messages";
import { getServerSettings } from "./serverSettings";
import {
  getServerSupport,
  getUnsupportedError,
  isUnknownSubcommandError,
  isUnsupportedServer,
  type UnsupportedServer,
} from "./serverSupport";

/** How long a state that was replaced waits for its formats in progress before its dprint processes shut down. */
const RETIRED_FORMAT_TIMEOUT = 10_000;
/** The context key for if a config file needs something approved, which shows the command to approve it. */
const HAS_PENDING_APPROVALS_CONTEXT_KEY = "dprint.hasPendingApprovals";
/** The key in the global or workspace state for if the user dismissed the no config notification for good. */
const NO_CONFIG_NOTIFICATION_DISMISSED_KEY = "dprint.noConfigNotificationDismissed";

export interface WorkspaceBackendOptions {
  approvedPaths: ApprovedConfigPaths;
  configSchemaProvider: ConfigJsonSchemaProvider;
  logger: Logger;
  /** Where the user's choices that are kept across sessions are stored (ex. to not show a notification again). */
  state: { globalState: vscode.Memento; workspaceState: vscode.Memento };
  /** Called when a config file outside the workspace that a workspace folder uses is created or deleted. */
  onAncestorConfigFileCreatedOrDeleted(): void;
}

/**
 * Formats using dprint's language server (`dprint lsp`) with the `dprint/*` methods
 * for editor extensions, where one dprint process formats the files of the whole
 * workspace by finding the config file of each file itself. There's a process for
 * each dprint executable in use (ex. when a project in the workspace has dprint in
 * its node_modules folder). A config file whose executable is a version of dprint
 * without them is formatted with schema version 5 of the editor service instead.
 */
export class WorkspaceBackend implements vscode.Disposable {
  readonly #options: WorkspaceBackendOptions;
  readonly #logger: Logger;
  readonly #environment: Environment;
  #state: WorkspaceState | undefined;
  /** The state being initialized, which replaces the current one once it's ready. */
  #pendingState: WorkspaceState | undefined;
  /**
   * The dprint processes by their executable and its version, which are kept across the states
   * so that dprint isn't started again when the workspace changes (ex. a config file is created).
   * That keeps what the user chose for the session (ex. allowing a download).
   */
  readonly #services = new Map<string, Promise<ServiceResolution>>();
  /** The dprint processes that were replaced by a restart, which shut down once a state doesn't use them. */
  readonly #restartedServices = new Set<Promise<ServiceResolution>>();
  /** The problems with the config files. */
  readonly #diagnostics: vscode.DiagnosticCollection;
  /** Provides the read-only documents of what process plugins run with (see `askApproval`). */
  readonly #approvalConfigurationProvider: vscode.Disposable;
  /** The config files each dprint process sent problems for, which are cleared once it stops. */
  readonly #diagnosticUris = new Map<LspConnection, Set<string>>();
  /** What's kept across the states for the session of the extension. */
  readonly #session: WorkspaceSession = {
    hasNotifiedNoConfig: false,
    shownConfigErrors: new ShownConfigErrors(),
    pendingApprovalsItem: createPendingApprovalsItem(),
  };
  #disposed = false;

  constructor(options: WorkspaceBackendOptions) {
    this.#options = options;
    this.#logger = options.logger;
    this.#environment = new RealEnvironment(options.logger);
    this.#diagnostics = vscode.languages.createDiagnosticCollection("dprint");
    this.#approvalConfigurationProvider = vscode.workspace.registerTextDocumentContentProvider(
      APPROVAL_CONFIGURATION_SCHEME,
      { provideTextDocumentContent: uri => approvalConfigurations.get(uri.path) },
    );
  }

  /**
   * Starts formatting the workspace, which is false when the default dprint executable
   * doesn't have the `dprint/*` methods. Nothing is registered in that case.
   *
   * The current state keeps formatting until the new one is ready to replace it, so
   * that formatting (ex. on save) isn't skipped while initializing. The dprint processes
   * of the executables that are still in use are kept.
   *
   * @param onSupported - Called once the executables support it and the new state
   * is ready, right before the formatter is registered.
   * @param options.restart - Starts new dprint processes instead of keeping them (ex. for the
   * restart command), which also forgets what the user chose for the session.
   */
  async initialize(onSupported: () => void, options: { restart?: boolean } = {}): Promise<boolean> {
    this.#logger.setDebug(getDprintConfig(vscode.workspace.workspaceFolders?.[0]?.uri).verbose);
    if (options.restart) {
      // the current state keeps using them until the new one replaces it
      for (const service of this.#services.values()) {
        this.#restartedServices.add(service);
        // what the user answers to a prompt that's still open isn't used, because they restarted to forget it
        service.then(resolution => isUnsupportedServer(resolution) ? undefined : resolution.approvals.cancel())
          .catch(() => {/* it didn't start */});
      }
      this.#services.clear();
    }
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
      // dprint or the extension needs to be updated after a version mismatch, which doesn't fall back to
      // schema version 5 because that version of dprint may not have it anymore
      const versionMismatchErrors = new Set(
        [defaultService, ...configServices]
          .filter(service => isUnsupportedServer(service) && service.isVersionMismatch)
          .map(service => (service as UnsupportedServer).error),
      );
      const unsupportedError = versionMismatchErrors.size > 0
        ? undefined
        : getUnsupportedError(defaultService, configFiles.length > 0);
      if (unsupportedError != null) {
        this.#logger.logInfo(`Using schema version 5 of the editor service. ${unsupportedError}`);
        state.dispose();
        this.#pendingState = undefined;
        const retiredState = this.#state;
        this.#state = undefined;
        (retiredState?.retire() ?? Promise.resolve()).then(() => this.#disposeUnusedServices());
        // the legacy backend has nothing to approve
        await setHasPendingApprovals(this.#session, false);
        return false;
      }
      if (this.#disposed) {
        state.dispose();
        return false;
      }
      for (const error of versionMismatchErrors) {
        vscode.window.showWarningMessage(toPlainNotificationText(error));
      }
      if (isUnsupportedServer(defaultService)) {
        this.#logger.logWarn(
          `Can't format files without a configuration file in the workspace. ${defaultService.error}`,
        );
      }
      state.setConfigs(configFiles.map((configFile, i) => {
        const service = configServices[i];
        if (!isUnsupportedServer(service)) {
          return { ...configFile, service, legacyFolder: undefined, info: undefined };
        }
        if (service.isVersionMismatch) {
          // its files aren't formatted until dprint or the extension is updated
          this.#logger.logWarn(`Can't format the files of ${configFile.configFilePath}. ${service.error}`);
          return { ...configFile, service: undefined, legacyFolder: undefined, info: undefined };
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
      // the processes that are kept may have been started with other settings or workspace folders
      for (const service of state.services) {
        service.connection.updateSettings(getSettings());
        service.connection.updateWorkspaceFolders(getWorkspaceFolders());
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
   * for the setting of the executable because the others are sent to dprint.
   */
  affectsInitialization(evt: vscode.ConfigurationChangeEvent) {
    return evt.affectsConfiguration("dprint.path");
  }

  async onConfigFileChanged(uri?: vscode.Uri, type?: ConfigFileChangeType) {
    // dprint doesn't watch the config files, so tell it (ex. to publish their problems)
    if (uri != null && type != null) {
      for (const service of this.#runningServices()) {
        service.connection.configFileChanged(uri.toString(), getFileChangeType(type));
      }
    }
    if (type === "created" || type === "deleted") {
      return; // the backend is initialized again
    }
    // dprint sends dprint/configChanged when what a config file formats changed, which refreshes
    // the plugins, but schema version 5 of the editor service doesn't
    const states = uri == null
      ? [this.#state, this.#pendingState]
      : [this.#state, this.#pendingState].filter(state => state?.hasLegacyFolders);
    // the state being initialized may have gotten the plugins before the change
    await Promise.all(states.map(state => state?.scheduleRefresh()));
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
      { useGlobalConfig: true, saysWhyNotFormatted: true },
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

  /** Asks the user about what the config files need approved, which includes what they denied. */
  approve() {
    return this.#state?.approve() ?? Promise.resolve();
  }

  /** Forgets what the user decided about what the config files need approved, so they're asked again. */
  forgetDecisions() {
    return this.#state?.forgetDecisions() ?? Promise.resolve();
  }

  /** Shows what the user decided about what the config files need approved, which they can forget. */
  showDecisions() {
    return this.#state?.showDecisions() ?? Promise.resolve();
  }

  dispose() {
    this.#disposed = true;
    this.#pendingState?.dispose();
    this.#state?.dispose();
    this.#state = undefined;
    this.#disposeUnusedServices();
    this.#diagnostics.dispose();
    this.#approvalConfigurationProvider.dispose();
    this.#session.pendingApprovalsItem.dispose();
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
        // the cli only uses one config file for each directory (ex. not a `.config/dprint.json`
        // when there's a `dprint.json` beside the `.config` directory)
        filterUnusedConfigFiles(this.#environment, folderConfigUris.map(uri => uri.fsPath)),
      );
      for (const configFilePath of configFilePaths) {
        configFiles.push({
          dirUri: vscode.Uri.file(getConfigFileDir(this.#environment, configFilePath)),
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
      // this is sent to dprint, so it doesn't need a process each
      verbose: false,
      logger: this.#logger,
      environment: this.#environment,
    });
  }

  /** Formats the files of a config file whose executable doesn't have the `dprint/*` methods. */
  #createLegacyFolder(configFile: ConfigFile) {
    return new FolderService({
      approvedPaths: this.#options.approvedPaths,
      cwd: configFile.folderUri,
      configUri: vscode.Uri.file(configFile.configFilePath),
      logger: this.#logger,
    });
  }

  /**
   * Gets the dprint process of the executable, which is the one that's kept from before when
   * it's the same executable with the same version of dprint. The version is known once a
   * process is initialized, so one is started to find out, which is kept when there isn't one.
   */
  async #getService(executable: DprintExecutable): Promise<ServiceResolution> {
    const connection = this.#createConnection(executable);
    let support: ReturnType<typeof getServerSupport>;
    try {
      support = getServerSupport(await connection.initialize());
    } catch (err) {
      connection.dispose();
      return {
        error: `Running \`${executable.cmdPath} lsp\` failed: ${err}`,
        // a version of dprint without the subcommand still runs
        isUnavailable: !isUnknownSubcommandError(err),
      };
    }
    if (isUnsupportedServer(support)) {
      connection.dispose();
      return support;
    }
    // a different version of the executable (ex. after updating it) or a different environment
    // of dprint (ex. a different global config directory) needs a new process
    const key = JSON.stringify([executable.processKey, support.version, getDprintEnvVars()]);
    let service = this.#services.get(key);
    if (service == null) {
      this.#logger.logInfo(`Initialized dprint ${support.version} (language server)\n  Command: ${executable.cmdPath}`);
      service = Promise.resolve(this.#createService(key, connection));
      this.#services.set(key, service);
    } else {
      connection.dispose();
    }
    return service;
  }

  #createConnection(executable: DprintExecutable): LspConnection {
    const connection: LspConnection = new LspConnection({
      spawn: () => executable.spawnLanguageServer(),
      getInitializeParams: () => ({
        processId: process.pid,
        clientInfo: { name: vscode.env.appName, version: vscode.version },
        workspaceFolders: getWorkspaceFolders(),
        initializationOptions: getSettings(),
      }),
      showMessage,
      showProgress,
      onDiagnostics: params => this.#setDiagnostics(connection, params),
      onConfigChanged: params => {
        this.#logger.logDebug("Configuration changed:", params.configFile?.uri ?? "(every configuration file)");
        // only the schema changed (ex. a plugin's schema downloaded), which getting it again is enough for
        if (params.schemaOnly) {
          this.#state?.refreshSchema();
          return;
        }
        // an error that's still there is shown again
        if (params.configFile == null) {
          this.#session.shownConfigErrors.clear();
        } else {
          this.#session.shownConfigErrors.forget(params.configFile);
        }
        this.onConfigFileChanged().catch(err => this.#logger.logError("Error refreshing:", err));
      },
      // the new server doesn't know what the config files were resolved from, which getting them again
      // tells it (it keeps what the user decided for the session by the connection's session id)
      onRestart: () => {
        this.onConfigFileChanged()
          .catch(err => this.#logger.logError("Error refreshing:", err));
      },
      logger: this.#logger,
    });
    return connection;
  }

  #createService(key: string, connection: LspConnection): Service {
    const approvals = new Approvals({
      ask: askApproval,
      approve: async params => {
        const result = await connection.approve(params);
        // ex. the decision couldn't be stored
        if (result.notice != null) {
          showSeverityMessage(result.notice);
        }
        return result;
      },
      // it's for one config file
      pendingApprovals: async configFile => await connection.pendingApprovals({ configFile }) as ConfigApprovals,
      // the user is waiting on the decision they made, like for a command, and it's shown once like
      // the errors of a config file so the next format doesn't show it again
      showNotUsed: (notFormatted, configFile) => {
        this.#session.shownConfigErrors.shouldShow(configFile, notFormatted.message);
        showSeverityMessage(notFormatted);
      },
    });
    return { key, connection, approvals };
  }

  /** The dprint processes the states use. */
  #runningServices() {
    return new Set([...this.#state?.services ?? [], ...this.#pendingState?.services ?? []]);
  }

  /** Shuts down the dprint processes that the states don't use anymore. */
  #disposeUnusedServices() {
    const usedKeys = new Set([...this.#state?.serviceKeys ?? [], ...this.#pendingState?.serviceKeys ?? []]);
    for (const [key, service] of [...this.#services]) {
      if (usedKeys.has(key) && !this.#disposed) {
        continue;
      }
      this.#services.delete(key);
      this.#disposeService(service);
    }
    // a restarted service has the same key as the one that replaced it
    const usedServices = new Set([...this.#state?.services ?? [], ...this.#pendingState?.services ?? []]);
    for (const service of [...this.#restartedServices]) {
      this.#restartedServices.delete(service);
      service.then(resolved => {
        if (!this.#disposed && !isUnsupportedServer(resolved) && usedServices.has(resolved)) {
          // it's checked again once the state that uses it is replaced
          this.#restartedServices.add(service);
        } else {
          this.#disposeService(service);
        }
      });
    }
  }

  #disposeService(service: Promise<ServiceResolution>) {
    service.then(service => {
      if (isUnsupportedServer(service)) {
        return;
      }
      // the config files of a process that stopped aren't checked anymore
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
  #setDiagnostics(connection: LspConnection, params: PublishDiagnosticsParams) {
    if (this.#disposed) {
      return;
    }
    let uris = this.#diagnosticUris.get(connection);
    if (uris == null) {
      uris = new Set();
      this.#diagnosticUris.set(connection, uris);
    }
    uris.add(params.uri);
    this.#diagnostics.set(
      vscode.Uri.parse(params.uri),
      params.diagnostics.map(lspDiagnostic => {
        const diagnostic = new vscode.Diagnostic(
          toRange(lspDiagnostic.range),
          lspDiagnostic.message,
          getDiagnosticSeverity(lspDiagnostic.severity),
        );
        diagnostic.source = lspDiagnostic.source ?? "dprint";
        if (lspDiagnostic.code != null) {
          diagnostic.code = lspDiagnostic.code;
        }
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

/**
 * A config file and what formats its files, which is either a dprint process or a legacy folder (or neither
 * for a version of dprint the extension doesn't support).
 */
interface Config extends ConfigFile {
  service: Service | undefined;
  /** Formats the files with schema version 5 when the executable doesn't have the `dprint/*` methods. */
  legacyFolder: FolderService | undefined;
  /** What dprint says about the config file, which is undefined until it's known. */
  info: ConfigInfoResult | undefined;
}

/** A dprint process of an executable. */
interface Service {
  /** Identifies the executable and its version. */
  key: string;
  connection: LspConnection;
  /** Asks the user about what the process needs approved. */
  approvals: Approvals;
}

type ServiceResolution = Service | UnsupportedServer;

/** What the states share for the session of the extension. */
interface WorkspaceSession {
  /**
   * Whether the user was notified about a file without a config file, which is only
   * done once per session even when there are several.
   */
  hasNotifiedNoConfig: boolean;
  /** The errors of the config files that were shown, which dprint doesn't show for the extension. */
  shownConfigErrors: ShownConfigErrors;
  /**
   * Shows that something needs to be approved without interrupting the user, which asks
   * about it when it's clicked.
   */
  pendingApprovalsItem: vscode.StatusBarItem;
}

/** What dprint formats a document as. */
interface FormatTarget {
  /** The uri that's sent to dprint, which is a file uri for a user data file (ex. the user settings.json). */
  uri: string;
  /**
   * A path in the directory that the document is formatted in, which decides the dprint process
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
  /** Gets the dprint process of the executable, which may be one that's kept from another state. */
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
  /** The dprint processes by the process key of their executable. */
  readonly #services = new Map<string, Promise<ServiceResolution>>();
  /** The dprint processes that were resolved. */
  readonly #resolvedServices: Service[] = [];
  readonly #refreshQueue: CoalescingQueue;
  readonly #getServiceForExecutable: (executable: DprintExecutable) => Promise<ServiceResolution>;
  readonly #onActivate: () => void;
  readonly #session: WorkspaceSession;
  readonly #watchedDirPaths = new Set<string>();
  /** The watchers of the files the config files were resolved from by their uri. */
  readonly #fileWatchers = new Map<string, vscode.Disposable>();
  /** The formats in progress, which a state that was replaced waits on before its processes shut down. */
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
        ["verbose", "useGlobalConfig", "ensureStableFormat"].some(setting =>
          evt.affectsConfiguration(`dprint.${setting}`)
        )
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

  /** The keys of the dprint processes the state uses, which aren't shut down while it does. */
  get serviceKeys() {
    return this.#resolvedServices.map(service => service.key);
  }

  /** Whether a config file is formatted with schema version 5 of the editor service. */
  get hasLegacyFolders() {
    return this.#configs.some(config => config.legacyFolder != null);
  }

  /** The dprint processes the state uses. */
  get services(): readonly Service[] {
    return this.#resolvedServices;
  }

  /** Stops the state, which leaves its dprint processes to the backend. */
  dispose() {
    this.#stop();
    this.#disposeLegacyFolders();
  }

  /**
   * Stops using the state now that another one replaced it, which resolves once the formats
   * in progress finish so that a format (ex. on save) during the initialization still gets
   * its edits before the dprint processes that aren't used anymore are shut down.
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

  /** Gets the dprint process of the executable, which is shared with the other config files that use it. */
  async getService(createExecutable: () => Promise<DprintExecutable>): Promise<ServiceResolution> {
    if (this.#disposed) {
      return { error: "dprint was stopped.", isUnavailable: true };
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
        if (!isUnsupportedServer(service)) {
          this.#resolvedServices.push(service);
        }
        return service;
      });
      this.#services.set(key, service);
    }
    return service;
  }

  /** Gets the dprint process for the files that don't have a config file in the workspace. */
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
    // dprint may need something approved for a config file the extension didn't find (ex. the global one)
    await setHasPendingApprovals(this.#session, (await this.#getPendingApprovals()).length > 0);
    this.#updateWatchedFiles();
    this.refreshSchema();
    // don't wait for this because it may need to start dprint for a config outside the workspace
    this.#scheduleUserDataFilePathsUpdate();
    if (this.#configs.length === 0) {
      this.#logger.logInfo("Configuration file not found.");
    }
  }

  /** Has vscode get the schema of the config files again. */
  refreshSchema() {
    this.#options.configSchemaProvider.setSource({ getConfigSchema: () => this.#getConfigSchema() });
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
      ...getDocumentParams(target),
      globalConfig: "whenNoConfigFile",
      text: document.getText(),
    });
    return info.configFile?.kind === "global";
  }

  /**
   * Asks the user about what the config files need approved, which includes what they denied
   * or were already asked about because they ran the command.
   */
  async approve() {
    // what's pending may have changed since the plugins were refreshed
    await Promise.all(this.#configs.map(config => this.#refreshConfig(config)));
    const pending = await this.#getPendingApprovals();
    if (pending.length === 0) {
      vscode.window.showInformationMessage("Nothing needs to be approved for the configuration files.");
      this.scheduleRefresh();
      return;
    }
    // ask about each config file, starting with the one of the active document
    const groups = new Map<string, { service: Service; approvals: PendingApproval[]; dirPath: string }>();
    for (const { service, approval } of pending) {
      const key = `${approval.configFile.uri}\n${approval.configFile.dirUri}`;
      const group = groups.get(key)
        ?? { service, approvals: [], dirPath: vscode.Uri.parse(approval.configFile.dirUri).fsPath };
      group.approvals.push(approval);
      groups.set(key, group);
    }
    const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
    const activeGroup = activePath == null
      ? undefined
      : findClosestFolder([...groups.values()], group => group.dirPath, activePath);
    const orderedGroups = activeGroup == null
      ? [...groups.values()]
      : [activeGroup, ...[...groups.values()].filter(group => group !== activeGroup)];
    for (const group of orderedGroups) {
      try {
        await this.#requestApproval(group.service, group.approvals, { isExplicit: true });
      } catch (err) {
        this.#logger.logError("Error approving:", err);
      }
    }
    // what the config files format may have changed once dprint responded
    this.scheduleRefresh();
  }

  /** Gets what needs to be approved for the config files dprint used, with the process that needs it. */
  async #getPendingApprovals() {
    const pending: { service: Service; approval: PendingApproval }[] = [];
    const seenIds = new Set<string>();
    for (const service of this.#resolvedServices) {
      try {
        // workspace folders may use the same config file in an ancestor directory
        for (const approval of (await service.connection.pendingApprovals()).approvals) {
          if (!seenIds.has(approval.id)) {
            seenIds.add(approval.id);
            pending.push({ service, approval });
          }
        }
      } catch (err) {
        this.#logger.logError("Error getting what needs to be approved:", err);
      }
    }
    return pending;
  }

  /** Shows what the user decided for the config files, which they can forget. */
  async showDecisions() {
    const results = await Promise.all(this.#resolvedServices.map(service => service.connection.decisions()));
    // the "Always" decisions are shared by the processes
    const decisions = [
      ...new Map(results.flatMap(result => result.decisions).map(decision => [JSON.stringify(decision), decision]))
        .values(),
    ];
    const items: (vscode.QuickPickItem & { forget?: boolean })[] = decisions.map(decision => ({
      label: toPlainQuickPickText(
        `${decision.allows ? "Allowed" : "Denied"}${decision.always ? " (always)" : ""}: ${
          decision.specifiers.map((specifier, i) => {
            const item = decision.items?.[i];
            if (item?.kind === "npmrcProxy" && item.npmrcUri != null) {
              return `the proxy ${specifier} of ${getDisplayPath(item.npmrcUri)}`;
            }
            if (item?.kind === "networkPath") {
              const reachedFrom = item.localUri == null ? "" : `, which ${getDisplayPath(item.localUri)} reaches`;
              return `${specifier} (on another machine${reachedFrom})`;
            }
            return specifier;
          }).join(", ")
        }`,
      ),
      detail: decision.kind === "downloads"
        ? "Downloads"
        : decision.kind === "processPlugins"
        ? "Process plugins"
        : decision.kind,
      description: decision.configFile == null
        ? "Every configuration file"
        : toPlainQuickPickText(getDisplayPath(decision.configFile.uri)),
    }));
    if (results.some(result => result.allowProcessPlugins)) {
      items.unshift({ label: "Process plugins are allowed by dprint's settings file (editor.allowProcessPlugins)" });
    }
    if (items.length === 0) {
      vscode.window.showInformationMessage("Nothing was decided about what the configuration files need approved.");
      return;
    }
    items.push({ label: "Forget the decisions", forget: true });
    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: "What was decided about what dprint needs approved",
    });
    if (selection?.forget) {
      await this.forgetDecisions();
    }
  }

  /** Forgets what the user decided for every config file, including the "Always" decisions. */
  async forgetDecisions() {
    if (this.#resolvedServices.length === 0) {
      vscode.window.showInformationMessage("dprint isn't running, so there are no decisions to forget.");
      return;
    }
    // each process forgets what was decided for its session, and the stored decisions are shared
    const results = await Promise.allSettled(this.#resolvedServices.map(async service => {
      try {
        const result = await service.connection.forgetDecisions();
        return result.notice;
      } finally {
        // the user is asked again even about what they were asked about before once dprint responds, which
        // is for every config file because it's sent without one (a failure may have forgotten them too)
        service.approvals.forget();
      }
    }));
    const failure = results.find(result => result.status === "rejected");
    // ex. the stored decisions couldn't be forgotten, which is the same for each process
    const notice = results.map(result => result.status === "fulfilled" ? result.value : undefined)
      .find(notice => notice != null);
    if (failure != null) {
      this.#logger.logError("Error forgetting the approval decisions:", failure.reason);
      vscode.window.showErrorMessage(
        toPlainNotificationText(`dprint failed to forget the approval decisions: ${failure.reason}`),
      );
    } else if (notice != null) {
      showSeverityMessage(notice);
    } else {
      vscode.window.showInformationMessage("dprint will ask to approve what the configuration files need again.");
    }
    this.scheduleRefresh();
  }

  watchAncestorConfigFile(configFilePath: string) {
    const dirPath = getConfigFileDir(this.#environment, configFilePath);
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
      new vscode.RelativePattern(vscode.Uri.file(dirPath), DPRINT_DIR_CONFIG_FILE_GLOB),
    );
    const onCreateOrDelete = () => {
      this.#logger.logDebug("Ancestor configuration file created or deleted in:", dirPath);
      this.#options.onAncestorConfigFileCreatedOrDeleted();
    };
    watcher.onDidCreate(onCreateOrDelete);
    watcher.onDidChange(uri => {
      this.#logger.logDebug("Ancestor configuration file changed in:", dirPath);
      // dprint doesn't watch the config files, so tell it, which sends dprint/configChanged when
      // what it formats changed
      for (const service of this.#resolvedServices) {
        service.connection.configFileChanged(uri.toString(), FileChangeType.Changed);
      }
    });
    watcher.onDidDelete(onCreateOrDelete);
    this.#disposables.push(watcher);
  }

  /**
   * Watches the files that the config files were resolved from (ex. a config file one extends),
   * which dprint doesn't watch, so it's told when they change.
   */
  #updateWatchedFiles() {
    // a state that was stopped while refreshing disposed its watchers
    if (this.#disposed) {
      return;
    }
    const uris = new Set(this.#configs.flatMap(config => config.info?.watchUris ?? []));
    for (const [uri, watcher] of [...this.#fileWatchers]) {
      if (!uris.has(uri)) {
        watcher.dispose();
        this.#fileWatchers.delete(uri);
      }
    }
    for (const uri of uris) {
      if (this.#fileWatchers.has(uri)) {
        continue;
      }
      const filePath = vscode.Uri.parse(uri).fsPath;
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(path.dirname(filePath)), path.basename(filePath)),
      );
      const onChange = (type: FileChangeType) => {
        this.#logger.logDebug("File a configuration file was resolved from changed:", filePath);
        for (const service of this.#resolvedServices) {
          service.connection.configFileChanged(uri, type);
        }
      };
      watcher.onDidCreate(() => onChange(FileChangeType.Created));
      watcher.onDidChange(() => onChange(FileChangeType.Changed));
      watcher.onDidDelete(() => onChange(FileChangeType.Deleted));
      this.#fileWatchers.set(uri, watcher);
    }
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
      // this also sets up the plugins that are approved, so the first format doesn't wait on it
      config.info = await config.service.connection.configInfo({
        configFile: { uri: vscode.Uri.file(config.configFilePath).toString(), dirUri: config.dirUri.toString() },
      });
      const notFormatted = getNotFormatted(config.info.status);
      const approvals = notFormatted?.approvals ?? [];
      if (approvals.length > 0) {
        this.#logger.logInfo(
          `Not formatting with ${config.configFilePath} until it's approved, which is asked when formatting `
            + "or with the \"Dprint: Approve Configuration\" command:",
          approvals.map(approval => approval.message).join(" "),
        );
      } else if (notFormatted != null) {
        this.#logger.logInfo(
          `Not formatting with ${config.configFilePath}:`,
          notFormatted.message ?? notFormatted.reason,
        );
      } else if (config.info.plugins?.length === 0) {
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
    isAfterApproval = false,
  ): Promise<FormatDocumentResult> {
    const target = this.#getFormatTarget(document);
    if (target == null) {
      return { notFormattedReason: "noFilePath" };
    }
    const config = this.#getConfigForFile(target.filePath);
    if (config?.legacyFolder != null) {
      return this.#formatLegacyDocument(config.legacyFolder, document, target, ranges, token);
    }
    // a config file without a dprint process has a version of dprint the extension doesn't support
    const service = config != null ? config.service : await this.#getDefaultServiceOrWarn();
    if (service == null || token.isCancellationRequested) {
      return service == null ? { notFormattedReason: "failed" } : { edits: [] };
    }
    const useGlobalConfig = options.useGlobalConfig ?? getDprintConfig(document.uri).useGlobalConfig;
    try {
      const result = await service.connection.format({
        ...getDocumentParams(target),
        // dprint's setting is the environment variable when the setting of the folder is off
        globalConfig: useGlobalConfig ? "whenNoConfigFile" : undefined,
        text: document.getText(),
        ranges: ranges?.map(toTextRange),
      }, token);
      if (result == null) {
        return { edits: [] }; // cancelled
      }
      // a kind that's newer than the extension is handled like a result that isn't formatted with
      // the fields it has (ex. its approvals), like a status of a kind it doesn't know
      const kind: "formatted" | "failed" | "notFormatted" = result.kind === "formatted"
        ? "formatted"
        : result.kind === "failed"
        ? "failed"
        : "notFormatted";
      switch (kind) {
        case "formatted": {
          const formatted = result as Extract<FormatResult, { kind: "formatted" }>;
          this.#logger.logDebug("Response - Formatted:", target.uri);
          if (formatted.notice != null) {
            if (options.saysWhyNotFormatted) {
              // a command doesn't say anything about a document that was formatted itself
              showSeverityMessage(formatted.notice);
            } else {
              this.#onMessage(formatted.notice, formatted.configFile, {});
            }
          }
          return { edits: formatted.edits.map(edit => vscode.TextEdit.replace(toRange(edit.range), edit.newText)) };
        }
        case "notFormatted": {
          const notFormatted = {
            ...getNotFormatted(result as FormatStatus)!,
            kind: "notFormatted" as const,
            configFile: result.configFile,
          };
          this.#logger.logDebug(`Response - Not formatted (${notFormatted.reason}):`, target.uri);
          this.#onNotFormatted(notFormatted, { ...options, useGlobalConfig }, document.uri);
          // only a document dprint says to claim is asked about when the user didn't run a command
          // (it isn't when what the config file formats isn't known) unless the user chose dprint
          // as the formatter of its language
          const mayAsk = notFormatted.claim || options.saysWhyNotFormatted === true
            || isDprintDefaultFormatter(document);
          if (notFormatted.approvals != null && notFormatted.approvals.length > 0 && !isAfterApproval && mayAsk) {
            // The user is asked when formatting (ex. on save) because opening a project isn't the
            // same as choosing to run what its config file says.
            const approval = this.#requestApproval(service, notFormatted.approvals, { isExplicit: false }).catch(
              err => {
                this.#logger.logError("Error approving:", err);
                return false;
              },
            ).finally(() => this.scheduleRefresh());
            if (options.saysWhyNotFormatted) {
              // a command waits on it unless it's cancelled
              if (await waitUnlessCancelled(approval, token)) {
                return this.#formatDocument(document, ranges, options, token, true);
              }
            } else {
              // a save doesn't wait on it, so the document is formatted and saved again once it's approved
              approval.then(isApproved => isApproved ? this.#formatAfterApproval(document) : undefined).catch(err => {
                this.#logger.logError("Error formatting after approving:", err);
              });
            }
          }
          return getFormatDocumentResult(notFormatted.reason, notFormatted.message, target.notebookUri != null);
        }
        case "failed": {
          // VS Code chooses the formatter by the config file's patterns, so a failure's claim doesn't
          // change which documents dprint formats
          const failed = result as {
            message?: string;
            show?: ShowPolicy;
            severity?: Severity;
            actions?: Action[];
            configFile?: ConfigFileInfo | null;
          };
          this.#onFormatFailed({
            message: `dprint failed to format the document: ${failed.message ?? "Formatting failed."}`,
            show: failed.show ?? "command",
            severity: failed.severity ?? "warning",
            actions: failed.actions,
          }, failed.configFile ?? null);
          return { notFormattedReason: "failed" };
        }
      }
    } catch (err) {
      this.#logger.logError("Error formatting text.", err);
      return { notFormattedReason: "failed" };
    }
  }

  /** Formats the document with a config file whose executable doesn't have the `dprint/*` methods. */
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

  /** Asks the user about the approval, which keeps the process running until they answered. */
  #requestApproval(service: Service, approvals: PendingApproval[], options: { isExplicit: boolean }) {
    return service.connection.trackInteraction(service.approvals.request(approvals, options));
  }

  #onNotFormatted(
    result: NotFormattedResult & { configFile: ConfigFileInfo | null },
    options: FormatDocumentOptions & { useGlobalConfig: boolean },
    documentUri: vscode.Uri,
  ) {
    switch (result.reason) {
      case "noConfigFile":
      case "globalConfigNotAllowed":
        this.#logger.logInfo("Configuration file not found for:", documentUri.toString());
        if (!options.saysWhyNotFormatted) {
          this.#notifyNoConfig({
            useGlobalConfig: options.useGlobalConfig,
            hasGlobalConfig: result.reason === "globalConfigNotAllowed",
          }, documentUri);
        }
        break;
      default: {
        this.#onMessage(result, result.configFile, options);
        break;
      }
    }
  }

  /**
   * Shows a message of dprint like it says, which dprint doesn't show to the user because only
   * the extension knows that the user formatted.
   */
  #onMessage(message: Notice, configFile: ConfigFileInfo | null, options: FormatDocumentOptions) {
    if (options.saysWhyNotFormatted) {
      return;
    }
    switch (message.show) {
      case "always":
        this.#logger.logError(message.message);
        showSeverityMessage(message);
        break;
      case "oncePerConfigFile": {
        this.#logger.logError(message.message);
        const identifier = configFile == null ? undefined : { uri: configFile.uri, dirUri: configFile.dirUri };
        if (this.#session.shownConfigErrors.shouldShow(identifier, message.message)) {
          showSeverityMessage(message);
        }
        break;
      }
      default:
        // only for a command, which says why itself
        this.#logger.logInfo(message.message);
        break;
    }
  }

  /** Notifies the user about a file without a config file, which is only done once per session. */
  #notifyNoConfig(options: { useGlobalConfig: boolean; hasGlobalConfig: boolean }, documentUri: vscode.Uri) {
    const { globalState, workspaceState } = this.#options.state;
    if (
      this.#session.hasNotifiedNoConfig
      || !getDprintConfig(documentUri).showNoConfigNotification
      || globalState.get(NO_CONFIG_NOTIFICATION_DISMISSED_KEY) === true
      || workspaceState.get(NO_CONFIG_NOTIFICATION_DISMISSED_KEY) === true
    ) {
      return;
    }
    this.#session.hasNotifiedNoConfig = true;
    const workspaceButtonText = "Don't show in this workspace";
    const globalButtonText = "Don't show again";
    // the workspace state is only kept when a workspace is open
    const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    const buttons = hasWorkspace ? [workspaceButtonText, globalButtonText] : [globalButtonText];
    // don't wait for this because it only resolves once the notification is dismissed
    vscode.window.showInformationMessage(getNoConfigMessage(options), ...buttons).then(async selection => {
      if (selection == null) {
        return;
      }
      const state = selection === workspaceButtonText ? workspaceState : globalState;
      try {
        await state.update(NO_CONFIG_NOTIFICATION_DISMISSED_KEY, true);
      } catch (err) {
        this.#logger.logError("Error storing that the no configuration file notification was dismissed:", err);
      }
    });
  }

  #onFormatFailed(message: Notice, configFile: ConfigFileInfo | null) {
    // ex. a syntax error isn't shown because a format usually happens without the user doing
    // anything (ex. on save) and the editor already shows it
    if (message.show !== "always" && message.show !== "oncePerConfigFile") {
      this.#logger.logWarn("Error formatting text:", message.message);
      return;
    }
    this.#onMessage(message, configFile, {});
  }

  /**
   * Formats the document once what it needed was approved, which is saved again when it was
   * saved before and didn't change in the meantime.
   */
  async #formatAfterApproval(document: vscode.TextDocument) {
    if (document.isClosed) {
      return;
    }
    const version = document.version;
    const wasSaved = !document.isDirty;
    const result = await this.formatDocument(document, undefined, {}, new vscode.CancellationTokenSource().token);
    if (result.edits == null || result.edits.length === 0 || document.isClosed || document.version !== version) {
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.set(document.uri, result.edits);
    if (await vscode.workspace.applyEdit(edit) && wasSaved) {
      await document.save();
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
      // this is sent to dprint, so it doesn't need a process each
      verbose: false,
      logger: this.#logger,
      environment: this.#environment,
    });
  }

  /**
   * Gets the schema of the config files in the workspace from dprint, which has the
   * schemas of their plugins. vscode gets one schema for every config file, so these
   * are combined when there are multiple config files.
   */
  async #getConfigSchema() {
    const configs = this.#configs.filter((config, i) =>
      config.service != null
      // workspace folders may use the same config file in an ancestor directory
      && this.#configs.findIndex(other => other.configFilePath === config.configFilePath) === i
    );
    const schemas = await Promise.all(configs.map(async config => {
      try {
        const result = await config.service!.connection.configSchema({
          configFile: { uri: vscode.Uri.file(config.configFilePath).toString() },
        });
        return result.schema;
      } catch (err) {
        this.#logger.logError(`Error getting the schema of ${config.configFilePath}:`, err);
        return undefined;
      }
    }));
    return combineConfigSchemas(schemas.filter(schema => schema != null));
  }

  /** Gets the config file in the workspace that's closest to the file. */
  #getConfigForFile(filePath: string) {
    return findClosestFolder(this.#configs, config => config.dirUri.fsPath, filePath);
  }

  /** Gets the dprint process of the config file in the workspace that's closest to the file or otherwise the default one. */
  async #getServiceForFile(filePath: string): Promise<Service | undefined> {
    const config = this.#getConfigForFile(filePath);
    if (config != null) {
      return config.service;
    }
    return this.#getDefaultServiceOrWarn();
  }

  async #getDefaultServiceOrWarn() {
    const service = await this.getDefaultService();
    if (isUnsupportedServer(service)) {
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
    for (const watcher of this.#fileWatchers.values()) {
      watcher.dispose();
    }
    this.#fileWatchers.clear();
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
      service.connection.updateSettings(getSettings());
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
      // because they're matched differently than a glob). It's every file when the config file
      // formats other files too (ex. with a plugin's associations).
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
        const info = await service.connection.fileInfo({
          textDocument: { uri: vscode.Uri.file(uri.fsPath).toString() },
          globalConfig: getDprintConfig(uri).useGlobalConfig ? "whenNoConfigFile" : undefined,
        });
        return info.status.kind === "ready";
      } catch (err) {
        this.#logger.logError("Error checking if the file can be formatted.", err);
        return false;
      }
    }));
    return [...new Set(uris.filter((_, i) => canFormat[i]).map(uri => uri.fsPath))].sort();
  }
}

interface FormatDocumentOptions {
  /** Uses the global config file regardless of the setting (ex. for a command). */
  useGlobalConfig?: boolean;
  /**
   * Whether the caller tells the user why the document wasn't formatted (ex. a command), which is when
   * the extension doesn't notify them about a file without a config file or a config file's error.
   */
  saysWhyNotFormatted?: boolean;
}

/** Waits for the promise, which resolves to false when the token is cancelled first. */
async function waitUnlessCancelled(promise: Promise<boolean>, token: vscode.CancellationToken) {
  let disposable: vscode.Disposable | undefined;
  const cancelled = new Promise<false>(resolve => {
    disposable = token.onCancellationRequested(() => resolve(false));
  });
  try {
    return await Promise.race([promise.then(value => value && !token.isCancellationRequested), cancelled]);
  } finally {
    disposable?.dispose();
  }
}

/** The scheme of the read-only documents of what's approved. */
const APPROVAL_CONFIGURATION_SCHEME = "dprint-approval";
/** What's approved by the path of its document, which is the approval's id, while it's asked about. */
const approvalConfigurations = new Map<string, string>();

/** Asks the user about what dprint needs approved with the message dprint provides. */
async function askApproval(approval: PendingApproval, choices: ApprovalChoice[]) {
  const details = getApprovalDetails(approval);
  const titles = choices.map(choice => choice.title);
  const documentPath = `/${approval.id}.jsonc`;
  try {
    return await askApprovalShowingDetails(approval, choices, titles, details, documentPath);
  } finally {
    approvalConfigurations.delete(documentPath);
  }
}

async function askApprovalShowingDetails(
  approval: PendingApproval,
  choices: ApprovalChoice[],
  titles: string[],
  details: string,
  documentPath: string,
) {
  while (true) {
    const selection = await vscode.window.showWarningMessage(
      toPlainNotificationText(getApprovalMessage(approval)),
      ...titles,
      SHOW_DETAILS_TITLE,
    );
    if (selection !== SHOW_DETAILS_TITLE) {
      return choices.find(choice => choice.title === selection)?.decision;
    }
    // it's asked about again once the user has seen what's approved, which is a read-only document
    approvalConfigurations.set(documentPath, details);
    const uri = vscode.Uri.from({ scheme: APPROVAL_CONFIGURATION_SCHEME, path: documentPath });
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
  }
}

/** Gets the settings to send to dprint. */
function getSettings() {
  return getServerSettings({
    // it's provided with each document because it's a setting of each folder
    useGlobalConfig: false,
    ensureStableFormat: getDprintConfig(undefined).ensureStableFormat,
    verbose: getDprintConfig(vscode.workspace.workspaceFolders?.[0]?.uri).verbose,
  }, process.env);
}

function getWorkspaceFolders(): WorkspaceFolder[] {
  return vscode.workspace.workspaceFolders?.map(folder => ({ uri: folder.uri.toString(), name: folder.name })) ?? [];
}

/** Gets the environment variables of dprint (ex. `DPRINT_CONFIG_DIR`) that a process is started with. */
function getDprintEnvVars() {
  return Object.entries(process.env)
    .filter(([name]) => name.toUpperCase().startsWith("DPRINT_"))
    .sort(([a], [b]) => a.localeCompare(b));
}

function getDocumentParams(target: FormatTarget) {
  return {
    textDocument: { uri: target.uri },
    language: target.language,
    notebookDocument: target.notebookUri == null ? undefined : { uri: target.notebookUri },
  };
}

function toTextRange(range: vscode.Range): TextRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function toRange(range: TextRange) {
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

function getDiagnosticSeverity(severity: number | undefined) {
  switch (severity) {
    case 2:
      return vscode.DiagnosticSeverity.Warning;
    case 3:
      return vscode.DiagnosticSeverity.Information;
    case 4:
      return vscode.DiagnosticSeverity.Hint;
    default:
      return vscode.DiagnosticSeverity.Error;
  }
}

/** Shows a message from dprint (ex. a config file that failed to resolve). */
function showMessage(params: MessageParams) {
  const message = toPlainNotificationText(params.message);
  switch (params.type) {
    case MessageType.Error:
      vscode.window.showErrorMessage(message);
      break;
    case MessageType.Warning:
      vscode.window.showWarningMessage(message);
      break;
    default:
      // includes the types that are newer than the extension
      vscode.window.showInformationMessage(message);
      break;
  }
}

/** Gets if the user chose dprint as the default formatter of the document's language. */
function isDprintDefaultFormatter(document: vscode.TextDocument) {
  const scope = { languageId: document.languageId, uri: document.uri };
  return isDprintExtensionId(vscode.workspace.getConfiguration("editor", scope).get("defaultFormatter"));
}

/** Creates the status bar item that shows that something needs to be approved. */
function createPendingApprovalsItem() {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);
  item.text = "$(shield) dprint";
  item.tooltip = "dprint needs something approved before it formats with a configuration file. Click to review it.";
  item.command = "dprint.approve";
  return item;
}

/** Sets whether something needs to be approved, which shows the status bar item and the command. */
async function setHasPendingApprovals(session: WorkspaceSession, hasPendingApprovals: boolean) {
  if (hasPendingApprovals) {
    session.pendingApprovalsItem.show();
  } else {
    session.pendingApprovalsItem.hide();
  }
  await vscode.commands.executeCommand("setContext", HAS_PENDING_APPROVALS_CONTEXT_KEY, hasPendingApprovals);
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

function getFileChangeType(type: ConfigFileChangeType) {
  switch (type) {
    case "created":
      return FileChangeType.Created;
    case "changed":
      return FileChangeType.Changed;
    case "deleted":
      return FileChangeType.Deleted;
  }
}

/** Gets text that's shown as it is in a quick pick, which shows `$(name)` as an icon otherwise. */
function toPlainQuickPickText(text: string) {
  return text.replace(/\$\(/g, "$\u200B(");
}

/** Shows the message to the user like its severity says, which is a warning for one that isn't known. */
function showSeverityMessage(message: Notice) {
  // the actions that aren't known are left out, and so is opening anything but a file (ex. a website)
  const actions = (message.actions ?? []).filter(
    (action): action is { kind: "openUri"; label: string; uri: string } =>
      action.kind === "openUri" && "uri" in action && vscode.Uri.parse(action.uri).scheme === "file",
  );
  const titles = actions.map(action => action.label);
  const show = message.severity === "error"
    ? vscode.window.showErrorMessage
    : message.severity === "info"
    ? vscode.window.showInformationMessage
    : vscode.window.showWarningMessage;
  show(toPlainNotificationText(message.message), ...titles).then(selection => {
    const action = actions.find(action => action.label === selection);
    if (action != null) {
      vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(action.uri));
    }
  });
}
