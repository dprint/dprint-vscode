import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  BodyReader,
  type ConfigChangedData,
  type ConfigDiagnosticsData,
  type ConfigInfoData,
  type ConfigInfoResponseData,
  type ConfigSchemaData,
  type ConfigSchemaResponseData,
  type EditorSettings,
  encodeMessage,
  type FileInfoData,
  type FileInfoResponseData,
  FormatFailedError,
  type FormatFileData,
  type FormatFileResult,
  type InitializeData,
  type InstallPluginsData,
  type LogData,
  type MessageAction,
  MessageDecoder,
  MessageKind,
  type ProgressData,
  type RawMessage,
  type ShowMessageData,
  type ShowMessageRequestData,
} from "./messages";

// note: this file should not import "vscode" so that it can be unit tested

export type EditorServiceProcess = ChildProcessByStdio<Writable, Readable, Readable>;

/** The parts of the logger that are used, which is a subset so this can be unit tested. */
export interface ConnectionLogger {
  log(message: string): void;
  logDebug(message: string, ...args: unknown[]): void;
  logInfo(message: string, ...args: unknown[]): void;
  logWarn(message: string, ...args: unknown[]): void;
  logError(message: string, ...args: unknown[]): void;
}

/** Progress that's shown to the user until it ends. */
export interface ProgressHandle {
  /** Updates the progress, which is from 0 to 100. */
  report(percentage: number): void;
  end(): void;
}

/** The parts of a cancellation token that are used, which is a subset so this can be unit tested. */
export interface ConnectionCancellationToken {
  isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface EditorServiceConnectionOptions {
  /** Starts the editor service, which is done again on the next request after it exits. */
  spawn(): EditorServiceProcess;
  /** Gets what to initialize each started editor service with. */
  getInitializeData(): InitializeData;
  /** Shows a message from the editor service to the user. */
  showMessage(data: ShowMessageData): void;
  /** Shows a message with actions from the editor service to the user and resolves with the chosen one. */
  showMessageRequest(data: ShowMessageRequestData): Promise<MessageAction | undefined>;
  /** Shows the progress of something the editor service is doing (ex. downloading a plugin). */
  showProgress(title: string, percentage: number | undefined): ProgressHandle;
  /** Shows the problems with a config file, which replace the ones shown before for it. */
  onConfigDiagnostics(data: ConfigDiagnosticsData): void;
  /** Called when what a config file formats may have changed in a way the editor can't see. */
  onConfigChanged(data: ConfigChangedData): void;
  logger: ConnectionLogger;
  /** How long to wait for the editor service to shut down before killing it. Defaults to one second. */
  killTimeout?: number;
}

/** How long a replaced connection waits before it's shut down (see `disposeWhenIdle`). */
export interface IdleTimeouts {
  /** How long to wait for the requests in progress (ex. a format on save). */
  requests: number;
  /** How long to wait for the user to answer the messages the editor service is waiting on. */
  messageRequests: number;
}

const DEFAULT_IDLE_TIMEOUTS: IdleTimeouts = { requests: 10_000, messageRequests: 10 * 60_000 };

/**
 * Communicates with a process of schema version 6 of the editor service, which
 * formats the files of a whole workspace. The process is started on the first
 * request and again on the next request after it exits.
 */
export class EditorServiceConnection {
  readonly #options: EditorServiceConnectionOptions;
  readonly #pendingRequests = new Map<number, PendingRequest>();
  /** Called when a request or a message the user hasn't answered finishes. */
  readonly #idleListeners = new Set<() => void>();
  /** The progress being shown for the current process by the id it gave it. */
  readonly #progress = new Map<number, ProgressHandle>();
  #process: EditorServiceProcess | undefined;
  #lastMessageId = 0;
  #unansweredMessageRequestCount = 0;
  /** Whether it's waiting to shut down, which is when new requests fail. */
  #closing = false;
  #disposed = false;

  constructor(options: EditorServiceConnectionOptions) {
    this.#options = options;
  }

  /** The number of requests that are waiting on a response. */
  get pendingRequestCount() {
    return this.#pendingRequests.size;
  }

  fileInfo(data: FileInfoData) {
    return this.#request<FileInfoResponseData>(MessageKind.FileInfo, [JSON.stringify(data)]);
  }

  configInfo(data: ConfigInfoData) {
    return this.#request<ConfigInfoResponseData>(MessageKind.ConfigInfo, [JSON.stringify(data)]);
  }

  configSchema(data: ConfigSchemaData) {
    return this.#request<ConfigSchemaResponseData>(MessageKind.ConfigSchema, [JSON.stringify(data)]);
  }

  /**
   * Downloads and sets up the plugins of the config file of a document that aren't installed, which
   * first asks the user to allow the process plugins that weren't, so it may take a while to resolve.
   */
  installPlugins(data: InstallPluginsData) {
    return this.#request<void>(MessageKind.InstallPlugins, [JSON.stringify(data)]);
  }

  /**
   * Has a running editor service forget the config files and stop the plugins, as if it started again,
   * while keeping what the user chose for the session.
   */
  async reset() {
    if (this.#process != null) {
      await this.#request<void>(MessageKind.Reset, []);
    }
  }

  /**
   * Formats the text of the document, which resolves with undefined when the format was cancelled and
   * rejects with a `FormatFailedError` when formatting failed.
   */
  formatFile(
    data: FormatFileData,
    text: string,
    token: ConnectionCancellationToken,
  ): Promise<FormatFileResult | undefined> {
    if (token.isCancellationRequested) {
      return Promise.resolve(undefined);
    }
    const id = this.#nextMessageId();
    const request = this.#sendRequest<FormatFileResult>(id, MessageKind.FormatFile, [JSON.stringify(data), text]);
    const disposable = token.onCancellationRequested(() => {
      // the editor service doesn't respond to a cancelled request, so stop waiting on it here
      const pendingRequest = this.#pendingRequests.get(id);
      if (pendingRequest != null) {
        this.#pendingRequests.delete(id);
        pendingRequest.resolve(undefined);
        this.#write(encodeMessage(this.#nextMessageId(), MessageKind.CancelRequest, [id]));
        this.#notifyIdleListeners();
      }
    });
    return request.finally(() => disposable.dispose());
  }

  /** Sends the settings to a running editor service. One that's started later is initialized with them. */
  async updateSettings(settings: EditorSettings) {
    if (this.#process != null) {
      await this.#request<void>(MessageKind.UpdateSettings, [JSON.stringify(settings)]);
    }
  }

  /**
   * Shuts down the editor service once its requests finish and the user answered the
   * messages it's waiting on, which is for a connection that was replaced. That way a
   * format in progress still gets its edits and choosing an action (ex. "Don't show
   * again") reaches the process that asked. New requests fail in the meantime.
   */
  disposeWhenIdle(timeouts = DEFAULT_IDLE_TIMEOUTS) {
    if (this.#closing || this.#disposed) {
      return Promise.resolve();
    }
    this.#closing = true;
    return Promise.all([
      this.#waitFor(() => this.#pendingRequests.size === 0, timeouts.requests),
      // an answer can't reach a process that exited
      this.#waitFor(
        () => this.#unansweredMessageRequestCount === 0 || this.#process == null,
        timeouts.messageRequests,
      ),
    ]).then(() => this.dispose());
  }

  /** Shuts down the editor service, which is killed when it doesn't exit soon enough. */
  dispose() {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#endProgress();
    const process = this.#process;
    if (process == null) {
      return;
    }
    const killTimeout = setTimeout(() => this.#kill(process), this.#options.killTimeout ?? 1_000);
    this.#sendRequest<void>(this.#nextMessageId(), MessageKind.ShutDownProcess, [])
      .catch(() => {/* ignore */})
      .finally(() => {
        clearTimeout(killTimeout);
        this.#kill(process);
      });
  }

  #request<T>(kind: MessageKind, parts: ReadonlyArray<number | string>) {
    return this.#sendRequest<T>(this.#nextMessageId(), kind, parts);
  }

  #sendRequest<T>(id: number, kind: MessageKind, parts: ReadonlyArray<number | string>) {
    return new Promise<T>((resolve, reject) => {
      const process = kind === MessageKind.ShutDownProcess ? this.#process : this.#ensureProcess();
      if (process == null) {
        reject(new Error("The editor service is not running."));
        return;
      }
      this.#pendingRequests.set(id, { resolve, reject });
      this.#write(encodeMessage(id, kind, parts), err => {
        // no response will arrive for a request that wasn't sent
        const pendingRequest = this.#pendingRequests.get(id);
        if (pendingRequest != null) {
          this.#pendingRequests.delete(id);
          pendingRequest.reject(err);
          this.#notifyIdleListeners();
        }
      });
    });
  }

  #ensureProcess() {
    if (this.#disposed || this.#closing) {
      return undefined;
    }
    if (this.#process == null) {
      this.#process = this.#startProcess();
    }
    return this.#process;
  }

  #startProcess() {
    const process = this.#options.spawn();
    const decoder = new MessageDecoder();
    process.stdout.on("data", (chunk: Buffer) => {
      if (this.#process !== process) {
        return; // output of a process that was replaced
      }
      try {
        for (const message of decoder.push(chunk)) {
          this.#handleMessage(message);
        }
      } catch (err) {
        this.#options.logger.logError("Error reading from the editor service:", err);
        this.#kill(process);
      }
    });
    process.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text.length > 0) {
        this.#options.logger.log(text);
      }
    });
    process.on(
      "exit",
      () => this.#onExit(process, new Error("The editor service exited while the request was in progress.")),
    );
    // a process that fails to spawn (ex. the executable or the cwd no longer exists) only emits this event
    process.on("error", err => {
      this.#options.logger.logError("Editor service process error:", err);
      this.#onExit(process, new Error(`The editor service failed to start. ${err}`));
    });
    // a failed write is reported to the writer, so this only prevents an uncaught exception
    process.stdin.on("error", err => {
      this.#options.logger.logDebug("Error writing to the editor service:", err);
    });
    // this is handled before the messages that are written after it, so they don't wait on its response
    const initializeId = this.#nextMessageId();
    this.#pendingRequests.set(initializeId, {
      resolve() {},
      reject: err => this.#options.logger.logError("Error initializing the editor service:", err),
    });
    process.stdin.write(
      encodeMessage(initializeId, MessageKind.Initialize, [JSON.stringify(this.#options.getInitializeData())]),
    );
    return process;
  }

  #onExit(process: EditorServiceProcess, err: Error) {
    // a process that was replaced must not affect the current one
    if (this.#process !== process) {
      return;
    }
    this.#process = undefined;
    this.#endProgress();
    const pendingRequests = [...this.#pendingRequests.values()];
    this.#pendingRequests.clear();
    for (const pendingRequest of pendingRequests) {
      pendingRequest.reject(err);
    }
    this.#notifyIdleListeners();
  }

  #kill(process: EditorServiceProcess) {
    try {
      process.kill();
    } catch {
      // ignore
    }
    // the events of a killed process are ignored once it's replaced, so its exit is handled here
    this.#onExit(process, new Error("The editor service was stopped while the request was in progress."));
  }

  // The body is read before taking the pending request so that a malformed body,
  // which stops the process, rejects that request along with the others.
  #handleMessage(message: RawMessage) {
    const body = new BodyReader(message.body);
    switch (message.kind) {
      case MessageKind.SuccessResponse:
        this.#takePendingRequest(body.readInt())?.resolve(undefined);
        break;
      case MessageKind.ErrorResponse: {
        const id = body.readInt();
        const err = new Error(body.readSizedString());
        this.#takePendingRequest(id)?.reject(err);
        break;
      }
      case MessageKind.FileInfoResponse:
      case MessageKind.ConfigInfoResponse:
      case MessageKind.ConfigSchemaResponse: {
        const id = body.readInt();
        const data = body.readSizedJson();
        this.#takePendingRequest(id)?.resolve(data);
        break;
      }
      case MessageKind.FormatFileResponse: {
        const id = body.readInt();
        const responseKind = body.readInt();
        const data = body.readSizedJson<any>();
        const pendingRequest = this.#takePendingRequest(id);
        switch (responseKind) {
          case 0:
            pendingRequest?.resolve({
              reason: data.reason,
              message: data.message,
              ...(data.diagnostics != null ? { diagnostics: data.diagnostics } : {}),
            });
            break;
          case 1:
            pendingRequest?.resolve({ edits: data.edits });
            break;
          default:
            // includes the kinds that are newer than the extension
            pendingRequest?.reject(
              new FormatFailedError(data.reason ?? "pluginError", data.message ?? "Formatting failed."),
            );
            break;
        }
        break;
      }
      case MessageKind.Active:
        this.#write(encodeMessage(this.#nextMessageId(), MessageKind.SuccessResponse, [message.id]));
        break;
      case MessageKind.ShowMessage:
        this.#options.showMessage(body.readSizedJson());
        break;
      case MessageKind.ShowMessageRequest:
        this.#respondToShowMessageRequest(message.id, body.readSizedJson());
        break;
      case MessageKind.Log:
        this.#log(body.readSizedJson());
        break;
      case MessageKind.Progress:
        this.#handleProgress(body.readSizedJson());
        break;
      case MessageKind.ConfigDiagnostics:
        this.#options.onConfigDiagnostics(body.readSizedJson());
        break;
      case MessageKind.ConfigChanged:
        this.#options.onConfigChanged(body.readSizedJson());
        break;
      default:
        this.#write(
          encodeMessage(this.#nextMessageId(), MessageKind.ErrorResponse, [
            message.id,
            `The editor can't handle a message with kind ${message.kind}.`,
          ]),
        );
        break;
    }
  }

  async #respondToShowMessageRequest(id: number, data: ShowMessageRequestData) {
    const process = this.#process;
    let action: MessageAction | undefined;
    this.#unansweredMessageRequestCount++;
    try {
      action = await this.#options.showMessageRequest(data);
    } catch (err) {
      this.#options.logger.logError("Error showing a message:", err);
    } finally {
      this.#unansweredMessageRequestCount--;
    }
    // a process started after the request's process exited may use the same message id
    if (this.#process === process) {
      this.#write(
        encodeMessage(this.#nextMessageId(), MessageKind.ShowMessageRequestResponse, [
          id,
          JSON.stringify({ action: action ?? null }),
        ]),
      );
    }
    this.#notifyIdleListeners();
  }

  #log(data: LogData) {
    const logger = this.#options.logger;
    switch (data.level) {
      case "error":
        logger.logError(data.message);
        break;
      case "warn":
        logger.logWarn(data.message);
        break;
      case "debug":
        logger.logDebug(data.message);
        break;
      default:
        // includes the levels that are newer than the extension
        logger.logInfo(data.message);
        break;
    }
  }

  #handleProgress(data: ProgressData) {
    switch (data.kind) {
      case "begin":
        this.#progress.get(data.id)?.end();
        this.#progress.set(data.id, this.#options.showProgress(data.title, data.percentage));
        break;
      case "report":
        this.#progress.get(data.id)?.report(data.percentage);
        break;
      case "end":
        this.#progress.get(data.id)?.end();
        this.#progress.delete(data.id);
        break;
    }
  }

  /** Ends the progress of the current process, which doesn't send the end of it once it exits. */
  #endProgress() {
    for (const progress of this.#progress.values()) {
      progress.end();
    }
    this.#progress.clear();
  }

  #takePendingRequest(id: number) {
    const pendingRequest = this.#pendingRequests.get(id);
    this.#pendingRequests.delete(id);
    this.#notifyIdleListeners();
    return pendingRequest;
  }

  /** Resolves once the condition is true, which is checked each time something finishes, or after the timeout. */
  #waitFor(condition: () => boolean, timeout: number) {
    if (condition()) {
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timeoutId);
        this.#idleListeners.delete(listener);
        resolve();
      };
      const listener = () => {
        if (condition()) {
          done();
        }
      };
      const timeoutId = setTimeout(done, timeout);
      this.#idleListeners.add(listener);
    });
  }

  #notifyIdleListeners() {
    for (const listener of [...this.#idleListeners]) {
      listener();
    }
  }

  #write(buf: Buffer, onError?: (err: Error) => void) {
    const process = this.#process;
    if (process == null) {
      onError?.(new Error("The editor service is not running."));
      return;
    }
    process.stdin.write(buf, err => {
      if (err != null) {
        onError?.(err);
      }
    });
  }

  #nextMessageId() {
    return ++this.#lastMessageId;
  }
}

interface PendingRequest {
  resolve(value: any): void;
  reject(err: unknown): void;
}
