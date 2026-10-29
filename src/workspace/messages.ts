// note: this file should not import "vscode" so that it can be unit tested

/**
 * The version of the `dprint/*` methods of `dprint lsp` that the extension uses (see
 * dprint's docs/editor-extension-development.md), which the extension and the server
 * say they support in the `dprint` experimental capability. A server supports the
 * versions before its own, so it needs to be at least this one.
 */
export const DPRINT_METHODS_VERSION = 1;

export const FORMAT_METHOD = "dprint/format";
export const FILE_INFO_METHOD = "dprint/fileInfo";
export const CONFIG_INFO_METHOD = "dprint/configInfo";
export const CONFIG_SCHEMA_METHOD = "dprint/configSchema";
export const APPROVE_METHOD = "dprint/approve";
export const RESET_METHOD = "dprint/reset";
export const CONFIG_CHANGED_NOTIFICATION = "dprint/configChanged";

/** The params of the initialize request that the extension provides. */
export interface ClientInitializeParams {
  /** The process that the server exits with. */
  processId: number;
  clientInfo: { name: string; version?: string };
  workspaceFolders: WorkspaceFolder[];
  initializationOptions: ServerSettings;
}

/** The parts of the initialize result that are used. */
export interface InitializeResult {
  capabilities: { experimental?: { dprint?: { version?: number } } };
  serverInfo?: { name: string; version?: string };
}

export interface WorkspaceFolder {
  uri: string;
  name: string;
}

/** The settings of the server, where one that isn't provided keeps its value. */
export interface ServerSettings {
  useGlobalConfig?: boolean;
  ensureStableFormat?: boolean;
  verbose?: boolean;
}

/** What identifies a document, which dprint formats as a file. */
export interface DocumentParams {
  textDocument: { uri: string };
  /** The language of a document that isn't a file, which dprint names the file it formats the document as after. */
  language?: DocumentLanguage;
  /** The notebook when the document is one of its cells. */
  notebookDocument?: { uri: string };
  /** Uses the global config file when there's no config file in an ancestor directory, in addition to the setting. */
  useGlobalConfig?: boolean;
}

export interface DocumentLanguage {
  id: string;
  /** The file extensions of the language with the leading period (ex. ".ts"). */
  fileExtensions?: string[];
  /** The file names of the language (ex. "Dockerfile"). */
  fileNames?: string[];
}

export interface FormatParams extends DocumentParams {
  text: string;
  /** The ranges to format, which is the whole text when not provided. */
  ranges?: TextRange[];
  /** The editor's indentation settings, which are the only config that can be overridden. */
  overrideConfig?: { indentWidth?: number; useTabs?: boolean };
}

export type FormatResult =
  /** The edits of the text that was sent, which are empty when it's already formatted. */
  | { kind: "formatted"; edits: TextEdit[] }
  | NotFormattedResult
  | { kind: "failed"; reason: FormatFailedReason; message: string };

export interface NotFormattedResult {
  kind: "notFormatted";
  reason: NotFormattedReason;
  /** The message to show the user about why the file wasn't formatted (ex. for a command the user ran). */
  message?: string;
  /** What the user needs to approve for the file to be formatted. */
  approval?: PendingApproval;
}

/** Why dprint didn't format a file, which may be a reason that's newer than the extension. */
export type NotFormattedReason =
  | "noConfigFile"
  | "globalConfigNotAllowed"
  | "notMatched"
  | "noPlugin"
  | "rangeFormattingNotSupported"
  /** A plugin's configuration in the config file has problems, which are in the config file's diagnostics. */
  | "configDiagnostics"
  /** The config file failed to resolve, which dprint shows the user. */
  | "configError"
  /** Something needs to be approved before the config file is used, which the approval has. */
  | "approvalRequired"
  | (string & {});

/**
 * Why formatting failed. `formatError` is when a plugin couldn't format the file (usually a syntax
 * error) and `pluginError` is when a plugin failed (ex. it panicked or couldn't be set up).
 */
export type FormatFailedReason = "formatError" | "pluginError" | (string & {});

/** Something the user needs to approve before dprint uses a config file. */
export interface PendingApproval {
  /** Identifies exactly what's approved, which changes when it does. */
  id: string;
  kind: ApprovalKind;
  /** The config file that needs it. */
  configFile?: string;
  /** The urls or paths to download, or the process plugins to run. */
  items: string[];
  /** The configuration of the process plugins that were set up before by their config key, which is what they run with. */
  configuration?: { [configKey: string]: unknown };
  /** Whether the user denied it, which is when they're only asked again when they ask for it (ex. a command). */
  denied: boolean;
  /** The message to show the user when asking. */
  message: string;
}

export type ApprovalKind = "download" | "processPlugins" | (string & {});

export type ApprovalDecision = "allow" | "alwaysAllow" | "deny" | "alwaysDeny";

export interface ApproveParams {
  id: string;
  decision: ApprovalDecision;
}

export interface ApproveResult {
  /**
   * What needs to be approved now, which is null only when the config file is ready. It's what
   * was denied when the decision was to deny it.
   */
  approval: PendingApproval | null;
}

/** The error code of a request for something that changed (ex. an approval that isn't pending anymore). */
export const CONTENT_MODIFIED_ERROR_CODE = -32801;

export interface FileInfoResult {
  configFile: ConfigFileInfo | null;
  canFormat: boolean;
  /** The plugins that format the file in the order they do. */
  plugins: { name: string; version: string }[];
  reason?: NotFormattedReason;
  message?: string;
  approval?: PendingApproval;
}

export interface ConfigFileInfo {
  uri: string;
  /** The directory whose files it formats, which isn't provided for a remote one. */
  dirUri?: string;
  isGlobal: boolean;
}

export interface ConfigParams {
  /** The config file or a document it's used for. */
  uri: string;
  useGlobalConfig?: boolean;
}

export interface ConfigInfoResult {
  configFile: ConfigFileInfo | null;
  /**
   * What they formatted the last time they were set up when something needs to be approved, which
   * is null when that isn't known (ex. a plugin that needs to be downloaded).
   */
  plugins: PluginInfo[] | null;
  /** Whether the config file formats files other than the ones of its plugins' file extensions and names (ex. associations). */
  formatsOtherFiles: boolean;
  /** Why the config file doesn't format anything (ex. its process plugins need to be approved). */
  reason?: NotFormattedReason;
  message?: string;
  approval?: PendingApproval;
}

export interface PluginInfo {
  name: string;
  version: string;
  configKey: string;
  /** The file extensions it formats without the leading period. */
  fileExtensions: string[];
  fileNames: string[];
}

export interface ConfigSchemaResult {
  schema: { [key: string]: any };
}

export interface ConfigChangedParams {
  /** The config file. */
  uri: string;
}

/** A range of zero-based lines and UTF-16 characters. */
export interface TextRange {
  start: TextPosition;
  end: TextPosition;
}

export interface TextPosition {
  line: number;
  character: number;
}

export interface TextEdit {
  range: TextRange;
  newText: string;
}

export interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: Diagnostic[];
}

export interface Diagnostic {
  range: TextRange;
  /** 1 is an error, 2 a warning, 3 information, and 4 a hint. */
  severity?: number;
  code?: number | string;
  source?: string;
  message: string;
}

/** The type of a `window/logMessage` or `window/showMessage` notification. */
export enum MessageType {
  Error = 1,
  Warning = 2,
  Info = 3,
  Log = 4,
}

export interface MessageParams {
  type: MessageType;
  message: string;
}

export interface ProgressParams {
  token: number | string;
  value: WorkDoneProgress;
}

export type WorkDoneProgress =
  | { kind: "begin"; title: string; percentage?: number; message?: string }
  | { kind: "report"; percentage?: number; message?: string }
  | { kind: "end"; message?: string };
