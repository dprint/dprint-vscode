import { Buffer } from "node:buffer";

// note: this file should not import "vscode" so that it can be unit tested

/** The schema version of the editor service that formats the files of a whole workspace. */
export const SCHEMA_VERSION = 6;

/** The kinds of the messages of schema version 6 (see dprint's docs/editor-extension-development.md). */
export enum MessageKind {
  SuccessResponse = 0,
  ErrorResponse = 1,
  ShutDownProcess = 2,
  Active = 3,
  Initialize = 4,
  UpdateSettings = 5,
  FormatFile = 6,
  FormatFileResponse = 7,
  CancelFormat = 8,
  FileInfo = 9,
  FileInfoResponse = 10,
  ConfigInfo = 11,
  ConfigInfoResponse = 12,
  ShowMessage = 13,
  ShowMessageRequest = 14,
  ShowMessageRequestResponse = 15,
  ConfigSchema = 16,
  ConfigSchemaResponse = 17,
  Log = 18,
  Progress = 19,
  ConfigDiagnostics = 20,
  ConfigChanged = 21,
}

/** The output of `dprint editor-service --info`. */
export interface EditorServiceInfo {
  cliVersion: string;
  editorServiceSchemaVersions: number[];
  configSchemaUrl: string;
}

export interface InitializeData {
  clientInfo: { name: string; version?: string };
  settings?: EditorSettings;
}

export interface EditorSettings {
  /** The uris of the workspace folders. */
  workspaceFolders?: string[];
  allowGlobalConfig?: boolean;
  showNoConfigNotification?: boolean;
  verbose?: boolean;
}

/** The language of a document that isn't a file, which dprint names the file it formats the document as after. */
export interface DocumentLanguage {
  id: string;
  /** The file extensions of the language with the leading period (ex. ".ts"). */
  fileExtensions?: string[];
  /** The file names of the language (ex. "Dockerfile"). */
  fileNames?: string[];
}

export interface FileInfoData {
  uri: string;
  language?: DocumentLanguage;
  notebookUri?: string;
  allowGlobalConfig?: boolean;
}

export interface FileInfoResponseData {
  configFile: ConfigFileInfo | null;
  canFormat: boolean;
  reason?: NotFormattedReason;
  message?: string;
}

export interface ConfigFileInfo {
  uri: string;
  isGlobal: boolean;
}

export interface ConfigInfoData {
  uri: string;
  allowGlobalConfig?: boolean;
}

export interface ConfigInfoResponseData {
  configFile: ConfigFileInfo | null;
  plugins: PluginInfo[];
}

export interface ConfigSchemaData {
  uris: string[];
  allowGlobalConfig?: boolean;
}

export interface ConfigSchemaResponseData {
  schema: { [key: string]: any };
}

export interface PluginInfo {
  name: string;
  version: string;
  configKey: string;
  fileExtensions: string[];
  fileNames: string[];
  configSchemaUrl: string | undefined;
  helpUrl: string;
  updateUrl: string | undefined;
}

/** Why dprint didn't format a file, which may be a reason that's newer than the extension. */
export type NotFormattedReason =
  | "noConfigFile"
  | "globalConfigNotAllowed"
  | "notMatched"
  | "noPlugin"
  | "noPlugins"
  | "unchanged"
  /** A plugin's configuration in the config file has errors, which the editor service shows the user. */
  | "configDiagnostics"
  /** A plugin that formats the file doesn't support formatting a range. */
  | "rangeFormattingNotSupported"
  | (string & {});

export interface FormatFileData {
  uri: string;
  language?: DocumentLanguage;
  notebookUri?: string;
  /** The UTF-16 offsets to format, which dprint expands to whole lines. The whole text is formatted when not provided. */
  range?: { start: number; end: number };
  overrideConfig?: Record<string, unknown>;
  allowGlobalConfig?: boolean;
  ensureStableFormat?: boolean;
  showNoConfigNotification?: boolean;
}

/** Replaces the text between two UTF-16 offsets of the text that was formatted. */
export interface FormatEdit {
  start: number;
  end: number;
  newText: string;
}

export type FormatFileResult =
  | { edits: FormatEdit[]; reason?: undefined; message?: undefined }
  | {
    edits?: undefined;
    reason: NotFormattedReason;
    /** The message to show the user about why the file wasn't formatted (ex. for a command the user ran). */
    message?: string;
    /** The errors in the configuration of the plugins when the reason is `configDiagnostics`. */
    diagnostics?: ConfigDiagnostic[];
  };

/** A problem with a config file. */
export interface ConfigDiagnostic {
  message: string;
  pluginName?: string;
  propertyName?: string;
  /** Where the problem is in the config file, when that's known. */
  range?: TextRange;
}

/** A range of zero-based lines and UTF-16 characters like in the language server protocol. */
export interface TextRange {
  start: TextPosition;
  end: TextPosition;
}

export interface TextPosition {
  line: number;
  character: number;
}

export interface ConfigDiagnosticsData {
  /** The config file. */
  uri: string;
  /** These replace the ones that were sent before for the config file. */
  diagnostics: ConfigDiagnostic[];
}

export interface ConfigChangedData {
  /** The config file. */
  uri: string;
}

export interface LogData {
  level: "error" | "warn" | "info" | "debug" | (string & {});
  message: string;
}

export type ProgressData =
  | { id: number; kind: "begin"; title: string; percentage?: number }
  | { id: number; kind: "report"; percentage: number }
  | { id: number; kind: "end" };

export type MessageType = "info" | "warning" | "error";

export interface ShowMessageData {
  kind: MessageType;
  message: string;
}

export interface ShowMessageRequestData {
  kind: MessageType;
  message: string;
  actions: MessageAction[];
}

export interface MessageAction {
  title: string;
}

/** A message with its body still encoded. */
export interface RawMessage {
  id: number;
  kind: number;
  body: Buffer;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const SUCCESS_BYTES_LENGTH = 4;
const HEADER_LENGTH = 12;

/** Encodes a message, where each part is a u32 or bytes that are prefixed with their length. */
export function encodeMessage(id: number, kind: MessageKind, parts: ReadonlyArray<number | string | Uint8Array>) {
  const encodedParts = parts.map((part): number | Uint8Array =>
    typeof part === "string" ? textEncoder.encode(part) : part
  );
  const bodyLength = encodedParts.reduce<number>(
    (length, part) => length + 4 + (typeof part === "number" ? 0 : part.byteLength),
    0,
  );
  const buf = Buffer.alloc(HEADER_LENGTH + bodyLength + SUCCESS_BYTES_LENGTH);
  buf.writeUInt32BE(id, 0);
  buf.writeUInt32BE(kind, 4);
  buf.writeUInt32BE(bodyLength, 8);
  let index = HEADER_LENGTH;
  for (const part of encodedParts) {
    if (typeof part === "number") {
      buf.writeUInt32BE(part, index);
      index += 4;
    } else {
      buf.writeUInt32BE(part.byteLength, index);
      index += 4;
      buf.set(part, index);
      index += part.byteLength;
    }
  }
  buf.fill(255, index);
  return buf;
}

/** Decodes the messages from the chunks of a stream, which may end in the middle of a message. */
export class MessageDecoder {
  #buffer: Buffer = Buffer.alloc(0);

  /** Adds a chunk and takes the messages that are complete. */
  push(chunk: Buffer): RawMessage[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const messages: RawMessage[] = [];
    while (this.#buffer.length >= HEADER_LENGTH) {
      const bodyLength = this.#buffer.readUInt32BE(8);
      const messageLength = HEADER_LENGTH + bodyLength + SUCCESS_BYTES_LENGTH;
      if (this.#buffer.length < messageLength) {
        break;
      }
      for (let i = messageLength - SUCCESS_BYTES_LENGTH; i < messageLength; i++) {
        if (this.#buffer[i] !== 255) {
          throw new Error(`Expected the success bytes at the end of a message, but found: ${this.#buffer[i]}`);
        }
      }
      messages.push({
        id: this.#buffer.readUInt32BE(0),
        kind: this.#buffer.readUInt32BE(4),
        // copied so the rest of the buffer can be released
        body: Buffer.from(this.#buffer.subarray(HEADER_LENGTH, HEADER_LENGTH + bodyLength)),
      });
      this.#buffer = this.#buffer.subarray(messageLength);
    }
    return messages;
  }
}

/** Reads the parts of a message's body in order. */
export class BodyReader {
  readonly #body: Buffer;
  #index = 0;

  constructor(body: Buffer) {
    this.#body = body;
  }

  readInt() {
    const value = this.#body.readUInt32BE(this.#index);
    this.#index += 4;
    return value;
  }

  readSizedString() {
    const length = this.readInt();
    const text = textDecoder.decode(this.#body.subarray(this.#index, this.#index + length));
    this.#index += length;
    return text;
  }

  readSizedJson<T>(): T {
    return JSON.parse(this.readSizedString()) as T;
  }
}

/**
 * Gets the info when it's from a version of dprint that has the schema version,
 * or otherwise why it can't be used.
 */
export function parseEditorServiceInfo(value: unknown): EditorServiceInfo | { error: string } {
  if (value == null || typeof value !== "object") {
    return { error: "The editor service info isn't an object." };
  }
  const info = value as Partial<EditorServiceInfo>;
  if (!Array.isArray(info.editorServiceSchemaVersions) || typeof info.cliVersion !== "string") {
    return { error: "The editor service info is missing its schema versions." };
  }
  if (!info.editorServiceSchemaVersions.includes(SCHEMA_VERSION)) {
    return {
      error: `dprint ${info.cliVersion} doesn't support schema version ${SCHEMA_VERSION} of the editor service.`,
    };
  }
  return {
    cliVersion: info.cliVersion,
    editorServiceSchemaVersions: info.editorServiceSchemaVersions,
    configSchemaUrl: typeof info.configSchemaUrl === "string" ? info.configSchemaUrl : "",
  };
}
