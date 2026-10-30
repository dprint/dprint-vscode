// note: this file should not import "vscode" so that it can be unit tested

/**
 * The versions of the `dprint/*` methods of `dprint lsp` that the extension supports (see
 * dprint's docs/editor-extension-development.md), which it sends in the `dprint` experimental
 * capability. The server responds with the one it uses, or without the capability when it
 * doesn't support any of them.
 */
export const DPRINT_METHODS_VERSIONS = [1];

export const FORMAT_METHOD = "dprint/format";
export const FILE_INFO_METHOD = "dprint/fileInfo";
export const CONFIG_INFO_METHOD = "dprint/configInfo";
export const CONFIG_SCHEMA_METHOD = "dprint/configSchema";
export const APPROVE_METHOD = "dprint/approve";
export const RESET_METHOD = "dprint/reset";
export const PENDING_APPROVALS_METHOD = "dprint/pendingApprovals";
export const FORGET_DECISIONS_METHOD = "dprint/forgetDecisions";
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
  capabilities: { experimental?: { dprint?: ServerCapability } };
  serverInfo?: { name: string; version?: string };
}

/** The `dprint` experimental capability of the server. */
export interface ServerCapability {
  /** The version of the methods it uses, which is missing when it doesn't support any of the extension's. */
  version?: number;
  /** The versions of the methods it supports. */
  versions?: number[];
  /** Where dprint's own files are, which are left out when their directory can't be found. */
  files?: { settings?: string; approvals?: string; globalConfig?: string };
  /** The globs of the config files to watch in the workspace folders. */
  configFileGlobs?: string[];
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
  /** When the global config file is used when there's no config file in an ancestor directory, which is dprint's setting when not provided. */
  globalConfig?: GlobalConfigUse;
}

export type GlobalConfigUse = "whenNoConfigFile" | "never";

export interface DocumentLanguage {
  id: string;
  /** The file extensions of the language, with or without the leading period (ex. ".ts"). */
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
  & {
    /** The config file that was used for the document. */
    configFile: ConfigFileInfo | null;
  }
  & (
    /** The edits of the text that was sent, which are empty when it's already formatted. */
    | { kind: "formatted"; edits: TextEdit[] }
    | NotFormattedResult
    | {
      kind: "failed";
      reason: FormatFailedReason;
      message: string;
      show: ShowPolicy;
      severity: Severity;
      plugin?: FilePlugin;
    }
  );

export interface NotFormattedResult extends NotFormatted {
  kind: "notFormatted";
}

/** Why a document isn't formatted, which is the same for each method. */
export interface NotFormatted {
  reason: NotFormattedReason;
  /** The message to show the user about why the file wasn't formatted (ex. for a command the user ran). */
  message: string;
  /** When to show the message. */
  show: ShowPolicy;
  /** How to show the message. */
  severity: Severity;
  /** Whether to keep acting as the document's formatter so the user is told why it isn't formatted. */
  claim: boolean;
  /** What the user needs to approve for the file to be formatted. */
  approvals?: PendingApproval[];
}

/**
 * When to show a message for a request the user made (ex. a format on save or a command), which
 * may be a value that's newer than the extension that's handled like "command".
 */
export type ShowPolicy = "always" | "command" | "oncePerConfigFile" | (string & {});

/** How to show a message, which may be a value that's newer than the extension that's handled like "warning". */
export type Severity = "error" | "warning" | "info" | (string & {});

/** Whether a document or the documents of a config file are formatted, which may be a kind that's newer than the extension. */
export type FormatStatus = { kind: "ready" } | ({ kind: "notFormatted" } & NotFormatted) | { kind: string & {} };

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
  /** Something needs to be approved before the config file is used, which the approvals have. */
  | "approvalRequired"
  /** The document can't be formatted (ex. its uri isn't a file). */
  | "unsupportedDocument"
  /** The document isn't a file, so its language is needed. */
  | "languageRequired"
  /** The config file that was asked about doesn't exist (ex. it was deleted). */
  | "configFileNotFound"
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
  configFile: ConfigFileInfo;
  /** What's downloaded or run. */
  items: ApprovalItem[];
  /** The decisions the user can make in the order to show them. */
  decisions: ApprovalDecisionOption[];
  /** Whether the user denied it, which is when they're only asked again when they ask for it (ex. a command). */
  denied: boolean;
  /** What the user decided before, which is "deny" or "alwaysDeny" when it's denied. */
  previousDecision?: ApprovalDecision;
  /** The message to show the user when asking. */
  message: string;
}

export interface ApprovalItem {
  /** The url, path, or npm specifier. */
  specifier: string;
  kind?: "plugin" | "config" | (string & {});
  /** The name, version, and config key of a plugin that was set up before. */
  name?: string;
  version?: string;
  configKey?: string;
  /** The configuration a process plugin that was set up before runs with. */
  configuration?: unknown;
}

export type ApprovalKind = "downloads" | "processPlugins" | (string & {});

export type ApprovalDecision = "allow" | "alwaysAllow" | "deny" | "alwaysDeny" | (string & {});

export interface ApprovalDecisionOption {
  id: ApprovalDecision;
  /** What to show the user, which is for a decision the extension doesn't know. */
  label: string;
  /** Whether it allows what's approved, which is otherwise denied. */
  allows: boolean;
  /** Whether it's remembered after dprint stops, which is otherwise only for the session. */
  always: boolean;
  /** What it does. */
  description: string;
}

export interface ApproveParams {
  id: string;
  decision: ApprovalDecision;
}

export interface ApproveResult {
  /**
   * What needs to be approved now for the config file, which is empty when nothing does. It has
   * what was denied when the decision was to deny it.
   */
  approvals: PendingApproval[];
  /** Whether the config file is used now, which isn't ready when it has an error or was deleted. */
  status: FormatStatus;
}

/** The data of an error, which may be a kind that's newer than the extension. */
export type ErrorData =
  /** What needs to be approved for the config file now and whether it's used when they're known. */
  | { kind: "approvalChanged"; approvals?: PendingApproval[]; status?: FormatStatus }
  | { kind: string & {} };

/** Identifies a config file, with the directory it's used for. */
export interface ConfigFileIdentifier {
  uri: string;
  dirUri?: string;
}

export interface PendingApprovalsParams {
  /** The config file to get them for, which is every config file when not provided. */
  configFile?: ConfigFileIdentifier;
}

export interface PendingApprovalsResult {
  approvals: PendingApproval[];
  /** Whether the config file is used, which is only provided for one config file. */
  status?: FormatStatus;
}

export interface ForgetDecisionsParams {
  /** The config file to forget the decisions of, which is every config file when not provided. */
  configFile?: ConfigFileIdentifier;
}

/** The error code of a request for something that changed (ex. an approval that isn't pending anymore). */
export const APPROVAL_CHANGED_ERROR_CODE = -32803;

export interface FileInfoParams extends DocumentParams {
  /** The text of the document, which is otherwise read from the file when it's needed (ex. a shebang). */
  text?: string;
}

export interface FileInfoResult {
  configFile: ConfigFileInfo | null;
  /** The plugins that format the file in the order they do. */
  plugins: FilePlugin[];
  status: FormatStatus;
}

export interface FilePlugin {
  name: string;
  version: string;
  configKey: string;
}

export interface ConfigFileInfo {
  uri: string;
  /** The directory whose files it formats or that its patterns are relative to. */
  dirUri: string;
  kind: "local" | "global" | "cli" | (string & {});
  /** Whether it's in a workspace folder. */
  inWorkspace: boolean;
}

/** Either the config file itself or a document it's used for, and not both. */
export interface ConfigParams extends Partial<DocumentParams> {
  /** The config file, with the directory it's used for. */
  configFile?: ConfigFileIdentifier;
}

export interface ConfigInfoResult {
  configFile: ConfigFileInfo | null;
  /**
   * What they formatted the last time they were set up when something needs to be approved, which
   * is null when that isn't known (ex. a plugin that needs to be downloaded).
   */
  plugins: PluginInfo[] | null;
  /** Whether the config file formats files other than the ones of its plugins' file extensions and names (ex. associations). */
  /** The files the plugins may format. */
  filePatterns: FilePattern[];
  /** The other files the config file formats, which only fileInfo says (ex. extensionless files with a shebang). */
  otherFiles: { kind: "shebangs" | "associations" | (string & {}); values: string[] }[];
  /** The local files besides the config file that it was resolved from (ex. a config file it extends). */
  watchUris?: string[];
  status: FormatStatus;
}

export interface FilePattern {
  /** A glob relative to the directory of the config file, which matches file extensions and names case insensitively. */
  glob: string;
  configKeys: string[];
}

export interface PluginInfo {
  name: string;
  version: string;
  configKey: string;
  /** The file extensions it formats without the leading period. */
  fileExtensions: string[];
  fileNames: string[];
  /** Whether it formats a file in addition to the plugin that formats it. */
  additive?: boolean;
  rangeFormatting?: "supported" | "wholeLines" | "unsupported" | (string & {});
  helpUrl?: string;
  updateUrl?: string;
}

export interface ConfigSchemaResult {
  schema: { [key: string]: any };
  /** Whether it has the schema of each plugin. */
  complete?: boolean;
}

export interface ConfigChangedParams {
  /** The canonical path of the config file, which is every config file when it's not provided. */
  uri?: string;
  /** The directory it's used for, which is every directory it's used for when not provided. */
  dirUri?: string;
  reason?: "created" | "changed" | "deleted" | (string & {});
  /** What changed, which is anything when it's not provided. */
  changes?: ("schema" | (string & {}))[];
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

/** Gets why the status says a document isn't formatted, which is undefined when it's ready. */
export function getNotFormatted(status: FormatStatus): NotFormatted | undefined {
  if (status.kind === "ready") {
    return undefined;
  }
  if (status.kind === "notFormatted" && "reason" in status) {
    return status as NotFormatted;
  }
  // a kind that's newer than the extension, which has the fields it has
  const fields = status as Partial<NotFormatted>;
  return {
    reason: fields.reason ?? "notMatched",
    message: fields.message ?? "dprint did not format the file.",
    show: fields.show ?? "command",
    severity: fields.severity ?? "warning",
    claim: fields.claim ?? false,
    approvals: fields.approvals,
  };
}

/** Gets what needs to be approved for the status. */
export function getApprovals(status: FormatStatus): PendingApproval[] {
  return getNotFormatted(status)?.approvals ?? [];
}
