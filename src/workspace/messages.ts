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
export const DECISIONS_METHOD = "dprint/decisions";
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
  versions: number[];
  /** Where dprint's own files are, which are left out when their directory can't be found. */
  files?: { settingsUri?: string; approvalsUri?: string; globalConfigUri?: string };
  /** The configuration files to watch in the workspace folders, which is missing without a `version`. */
  configFileGlobs?: string[];
  /**
   * The names of the configuration files that are looked up in a directory (ex. in the ancestor directories of the workspace
   * folders), which may have names added later, are empty for `dprint lsp --config`, and are missing without a `version`. A
   * case insensitive file system (Windows and macOS by default) finds them in any case, which the server does too.
   */
  configFileNames?: string[];
  /**
   * The names of the configuration files that are looked up in the `.config` directory of a directory, like
   * `configFileNames`. The home directory's `.config` is an ordinary directory, which isn't looked in for them.
   */
  dotConfigFileNames?: string[];
  /** What to tell the user when there isn't a `version` (ex. that dprint or the extension needs to be updated). */
  message?: string;
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
  notebookDocument?: { uri: string; fileUri?: string };
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

/** What dprint responds to a format with. */
export interface FormatResponse {
  /** The config file that was used for the document. */
  configFile: ConfigFileInfo | null;
  result:
    /** The edits of the text that was sent, which are empty when it's already formatted. */
    | { kind: "formatted"; edits: TextEdit[]; notice?: Notice }
    | NotFormattedResult
    | {
      kind: "failed";
      reason: FormatFailedReason;
      message: string;
      show: ShowPolicy;
      severity: Severity;
      claim: boolean;
      actions?: Action[];
      plugin?: FilePlugin;
    }
    /** A kind that's newer than the extension, which is handled like a status of a kind it doesn't know. */
    | { kind: string & {} };
}

/** What formatting a document did with the config file that was used. */
export type FormatResult = { configFile: ConfigFileInfo | null } & FormatResponse["result"];

/** Something to tell the user about the result of a request (ex. a decision that couldn't be stored). */
export interface Notice {
  message: string;
  show: ShowPolicy;
  severity: Severity;
  actions?: Action[];
}

/** Something the user can do about a message, which may be a kind that's newer than the extension. */
export type Action = { kind: "openUri"; label: string; uri: string } | { kind: string & {}; label: string };

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
  /** What the user can do about it. */
  actions?: Action[];
}

/**
 * When to show a message for a request the user made (ex. a format on save or a command), which
 * may be a value that's newer than the extension that's handled like "command".
 */
export type ShowPolicy = "always" | "command" | "oncePerConfigFile" | (string & {});

/** How to show a message, which may be a value that's newer than the extension that's handled like "warning". */
export type Severity = "error" | "warning" | "info" | (string & {});

/** Whether a document or the documents of a config file are formatted, which may be a kind that's newer than the extension. */
export type FormatStatus =
  | { kind: "ready" }
  | ({ kind: "notFormatted" } & NotFormatted)
  | { kind: string & {} };

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
  | "configFileMissing"
  | (string & {});

/**
 * Why formatting failed. `formatError` is when a plugin couldn't format the file (usually a syntax
 * error) and `pluginError` is when a plugin failed (ex. it panicked or couldn't be set up).
 */
export type FormatFailedReason = "formatError" | "pluginError" | (string & {});

/** Something the user needs to approve before dprint uses a config file. */
export interface PendingApproval {
  /**
   * Identifies exactly what's approved, which changes when what's shown does (ex. the configuration of a process plugin, or once its
   * process plugins are set up) and is the same in another server of the same version of dprint, but may change between versions, so
   * recognize the same approval by what it approves instead (see "Approving"). Only send a decision for the id that was shown to the
   * user.
   */
  id: string;
  kind: ApprovalKind;
  /** A short description of what's approved. */
  title: string;
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
  /** The message to show the user when asking, which has everything to see apart from the configuration. */
  message: string;
  /** What the process plugins that weren't set up before run with once they're allowed, which includes what it extends. */
  trustedConfiguration?: { [key: string]: unknown };
}

export interface ApprovalItem {
  /** The url, path, or npm specifier, or the setting of a proxy for "npmrcProxy". */
  specifier: string;
  /**
   * A config file is one that a config file extends, an npmrcProxy is a proxy that an `.npmrc` file sets, which downloads are sent
   * through once it's allowed, and a networkPath is a file or directory on another machine that's read (ex. a plugin, a
   * configuration file, an npm package, or an `.npmrc` file). Show a kind that isn't known by its specifier. An npm registry's item
   * is `plugin` when what was downloaded from it isn't known (ex. a decision kept from another version of dprint).
   */
  kind: "plugin" | "config" | "npmrcProxy" | "networkPath" | (string & {});
  /**
   * The uri of the path in the project of a `networkPath` that reaches the other machine through a symlink (the path before ` -> `)
   * as the editor knows it, which may be shown with it (ex. relative to the workspace folder). It's the local side of the item, not
   * where it's read from. Don't open it before it's allowed, because that follows the symlink and reads it from the other machine.
   */
  localUri?: string;
  /**
   * For the download of an npm registry itself (any registry, including the default one), it's the registry, which is the specifier
   * too, and allowing it allows every url under it unlike another url, while the item's `kind` is what's downloaded from it (`plugin`
   * or `config`). Show that allowing it allows every package and url under it. Otherwise, it's the npm registry an npm plugin is from
   * when it isn't the default one (`https://registry.npmjs.org/`), which an `.npmrc` file can set (ex. the project's for a scope).
   * Show it with the specifier then because the specifier doesn't say where the plugin is from. It's escaped like the specifier.
   */
  registry?: string;
  /** The `.npmrc` file of a proxy. */
  npmrcUri?: string;
  /** The plugin when it was set up before. */
  plugin?: FilePlugin;
  /** The configuration a process plugin that was set up before runs with. */
  configuration?: unknown;
}

export type ApprovalKind = "downloads" | "processPlugins" | (string & {});

export type ApprovalDecision = "allow" | "alwaysAllow" | "deny" | "alwaysDeny" | (string & {});

export interface ApprovalDecisionOption {
  decision: ApprovalDecision;
  /** What to show the user, which is for a decision the extension doesn't know. */
  label: string;
  /** Whether it allows what's approved, which is otherwise denied. */
  allows: boolean;
  /** Whether it's remembered after the session ends (in the approvals file), which is otherwise only for the session. */
  always: boolean;
  /** What it does. */
  description: string;
}

export interface ApproveParams {
  id: string;
  decision: ApprovalDecision;
}

/**
 * What needs to be approved for a config file now and whether it's used, which is what approving,
 * the pending approvals of a config file, and an approval that changed provide.
 */
export interface ConfigApprovals {
  /** The config file, which is null when it can't be resolved anymore (ex. it was deleted). */
  configFile: ConfigFileInfo | null;
  /**
   * What needs to be approved now for the configuration file, which is empty when nothing does. After a decision, it has
   * what was denied when the decision was to deny it and the denial was kept (a denial of downloads that were each allowed
   * exactly since isn't, which the `notice` says), and otherwise it may have something else that needs to be approved.
   */
  approvals: PendingApproval[];
  /**
   * Whether the configuration file is used now, which isn't "ready" when it has an error or was deleted, even when nothing needs to
   * be approved. It's for the configuration file, so get the `dprint/fileInfo` of a document to know whether it's formatted.
   */
  status: FormatStatus;
}

export interface ApproveResult extends ConfigApprovals {
  /**
   * What to tell the user about the decision, or about one made before for the same configuration file (ex. a denial wasn't kept
   * because what it denied was each allowed exactly for another configuration file since, so it's still allowed for the session,
   * or an `always` decision couldn't be stored, or the approvals file is from a newer version of dprint that this one can't write
   * to, so it's only used for the session). The server keeps such a decision for the session like one that isn't `always` (see
   * "Approving"). It also says when the file of the session couldn't be written or deleted, so what the user decided for the session
   * before may come back if the server is started again, and when the session's decisions aren't kept yet because another server
   * that's running uses the session id or its lock can't be taken (see `sessionId`).
   */
  notice?: Notice;
}

/** The data of an error, which may be a kind that's newer than the extension. */
export type ErrorData =
  /**
   * What needs to be approved now for the configuration file the approval was for (`current`), which is missing when that isn't
   * known (ex. the id isn't of an approval the server provided).
   */
  | { kind: "approvalChanged"; current?: ConfigApprovals }
  | { kind: string & {} };

/** Identifies a config file, with the directory it's used for. */
export interface ConfigFileIdentifier {
  uri: string;
  /**
   * The directory it's used for (its `dirUri`), which is the root of the server's current directory for the global configuration
   * file when not provided, and the directory to find the configuration file the server was started with from (`kind: "cli"`),
   * which is the server's current directory when not provided. For `dprint/decisions` and `dprint/forgetDecisions`, a
   * configuration file without one is of each directory it's used for instead.
   */
  dirUri?: string;
}

export interface PendingApprovalsParams {
  /** The configuration file to get them for, which is every configuration file that was used when not provided. */
  configFile?: ConfigFileIdentifier;
}

/** What's pending for every config file, or a `ConfigApprovals` for one. */
export type PendingApprovalsResult = { approvals: PendingApproval[] } | ConfigApprovals;

export interface ForgetDecisionsParams {
  /**
   * The configuration file to forget the decisions of, which is every configuration file when not provided. Without a `dirUri`, it's
   * the configuration file for each directory it's used for (ex. the global configuration file on each drive).
   */
  configFile?: ConfigFileIdentifier;
}

export interface ForgetDecisionsResult {
  /** The decisions that were forgotten. */
  decisions: Decision[];
  /**
   * What to tell the user about forgetting them (ex. the stored decisions couldn't be forgotten, which includes when the approvals
   * file is from a newer version of dprint that this one can't write to, so only the session's decisions were, or the file of the
   * session couldn't be written or deleted, so they may come back if the server is started again, or the session's decisions aren't
   * kept yet because another server that's running uses the session id or its lock can't be taken).
   */
  notice?: Notice;
}

export interface DecisionsResult {
  decisions: Decision[];
  /** Whether the settings file allows every process plugin without asking. */
  allowProcessPlugins: boolean;
}

/** Something the user decided about what a config file needs approved. */
export interface Decision {
  kind: ApprovalKind;
  /**
   * The configuration file it's for, which can be sent to `dprint/forgetDecisions` to forget the decisions of that configuration
   * file. It's missing for a download that's allowed for every configuration file, and for a process plugin decision whose
   * configuration file isn't a path or url the server can make a uri of (ex. one stored on another operating system). A decision
   * without one can't be forgotten on its own (an allowed download stays allowed for the session), so don't offer to forget it,
   * and never send `dprint/forgetDecisions` without a `configFile` for it, which forgets every decision of every configuration
   * file. Its `dirUri` is missing when it's for every directory the configuration file is used for (ex. the global
   * configuration file).
   */
  configFile?: ConfigFileIdentifier;
  /** The urls, paths, or specifiers it's for. */
  specifiers: string[];
  /**
   * What it's for, like an approval's items, with one for each of the `specifiers` in the same order. The server usually provides it for
   * downloads so a proxy or a path on another machine can be told apart from a url and shown with its file (an `npmrcProxy` with its
   * `npmrcUri`, or a `networkPath` with its `localUri`), and it's missing when they aren't known (ex. a denial kept by another version of
   * dprint). Show the `specifiers` when it's missing.
   */
  items?: ApprovalItem[];
  allows: boolean;
  /** Whether it's remembered after the session ends, which includes running dprint with the configuration file (ex. `dprint fmt`). */
  always: boolean;
}

/**
 * The error code of `dprint/approve` when what it was sent for isn't pending anymore because what needs to be approved changed.
 * Recognize it by its `data.kind` (see `ErrorData`), and treat it like `-32603` without it.
 */
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
  /** A file, https, or npm uri. */
  uri: string;
  /**
   * The directory whose files it formats, which is the directory it's in unless that's a `.config` directory (other than the home
   * directory's), even when it's a symlink to a file in another directory, and the directory it's used for when it's the global
   * configuration file (ex. the root of a drive). It's the directory its patterns are relative to for a remote or npm configuration
   * file.
   */
  dirUri: string;
  /**
   * How it was chosen: found in an ancestor directory, the global configuration file, or the one the server was started
   * with (`dprint lsp --config <path>`). Treat a kind that isn't known like "local".
   */
  kind: "local" | "global" | "cli" | (string & {});
  /** Whether it's in a workspace folder, which the global configuration file and one in an ancestor directory of the workspace folders aren't. */
  inWorkspace: boolean;
  /**
   * Whether it was found on another machine and reading it isn't allowed yet (see "Approving"), which is left out otherwise. Don't
   * open or read it then (ex. with a button in the prompt or a command that opens the configuration file of a document), because
   * that reads it from the other machine, which the approval is for. Its directory is watched like any other, which is never when
   * it's a symlink that isn't a workspace folder or one of its ancestors (see "Lifecycle"). The server sends `dprint/configChanged`
   * once it's allowed, and when a configuration file becomes one on another machine (ex. a `git pull` replaced it with a symlink
   * to a share). So don't open a configuration file from an older result or action (ex. a notification's "Open Configuration
   * File") when the latest result the editor extension has for it has `onAnotherMachine`, which is the latest `configFile` with
   * its `uri` (and `dirUri`) of a `dprint/configInfo` or `dprint/fileInfo` result, because both have the server's view of the
   * configuration file, and otherwise open it as usual. A `dprint/configChanged` that names it (or no configuration file) and
   * a restart of the server make it unknown again. The server takes back the diagnostics it published for it then by
   * publishing empty ones, and the ones it published through a directory the editor knew by another path once that doesn't lead
   * where it did (when it also sends `dprint/configChanged` for the configuration files the editor knew through it, whose
   * diagnostics are published again once they're resolved again), so don't drop them for this. This is a best effort (see
   * "Security").
   */
  onAnotherMachine?: boolean;
}

/** Either the config file itself, with the directory it's used for, or a document it's used for. */
export type ConfigParams = { configFile: ConfigFileIdentifier } | DocumentParams;

export interface ConfigInfoResult {
  configFile: ConfigFileInfo | null;
  /**
   * What they formatted the last time they were set up when something needs to be approved, which
   * is null when that isn't known (ex. a plugin that needs to be downloaded).
   */
  plugins: PluginInfo[] | null;
  /** The files the plugins may format. */
  filePatterns: FilePattern[];
  /** The other files the config file formats, which only fileInfo says (ex. extensionless files with a shebang). */
  otherFiles: { kind: "shebangs" | "associations" | (string & {}); values: string[] }[];
  /**
   * The local files that it was resolved from (ex. a configuration file it extends), and the canonical path of a local
   * configuration file when the `configFileGlobs` watcher doesn't report a change there, which is when it's a symlink (or is in
   * a `.config` directory that's one, ex. a `dprint.json` that's a symlink to a `base.json` or to a file in `node_modules`), when
   * its names are in another case on disk, and when it's reached through a directory that's a symlink the editor doesn't watch
   * through. The editor watches them too, by their directories (see "Lifecycle" for when one that's a symlink isn't watched).
   * Each is the editor's path when that's through a workspace folder or one of its ancestors that it knows by another path, and
   * the canonical path otherwise, which the editor may watch. A file whose directory may not be read (ex. it's on another machine now) is left out.
   */
  watchUris: string[];
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
  additive: boolean;
  rangeFormatting: "supported" | "wholeLines" | "unsupported" | (string & {});
  helpUrl: string;
  updateUrl?: string;
}

export interface ConfigSchemaResult {
  schema: { [key: string]: any };
  /** Whether it has the schema of each plugin. */
  complete: boolean;
}

export interface ConfigChangedParams {
  /** The config file, which is every config file when it's not provided. */
  configFile?: ConfigFileIdentifier;
  /** How it changed, where one that's newer than the extension is handled like "changed". */
  change?: "created" | "changed" | "deleted" | (string & {});
  /** Whether only its schema changed. */
  schemaOnly?: boolean;
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
    actions: fields.actions,
  };
}

/** Gets what needs to be approved for the status. */
export function getApprovals(status: FormatStatus): PendingApproval[] {
  return getNotFormatted(status)?.approvals ?? [];
}
