import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  CancellationTokenSource,
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import {
  APPROVE_METHOD,
  type ApproveParams,
  type ApproveResult,
  type ClientInitializeParams,
  CONFIG_CHANGED_NOTIFICATION,
  CONFIG_INFO_METHOD,
  CONFIG_SCHEMA_METHOD,
  type ConfigChangedParams,
  type ConfigInfoResult,
  type ConfigParams,
  type ConfigSchemaResult,
  DPRINT_METHODS_VERSIONS,
  FILE_INFO_METHOD,
  type FileInfoParams,
  type FileInfoResult,
  FORMAT_METHOD,
  type FormatParams,
  type FormatResult,
  type InitializeResult,
  type MessageParams,
  MessageType,
  PENDING_APPROVALS_METHOD,
  type PendingApprovalsResult,
  type ProgressParams,
  type PublishDiagnosticsParams,
  type ServerSettings,
  type WorkspaceFolder,
} from "./messages";
import { isSupportedServer } from "./serverSupport";

// note: this file should not import "vscode" so that it can be unit tested

export type ServerProcess = ChildProcessByStdio<Writable, Readable, Readable>;

/** How a watched file changed, which is the language server protocol's `FileChangeType`. */
export enum FileChangeType {
  Created = 1,
  Changed = 2,
  Deleted = 3,
}

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

export interface LspConnectionOptions {
  /** Starts `dprint lsp`, which is done again on the next request after it exits. */
  spawn(): ServerProcess;
  /** Gets what to initialize each started server with. */
  getInitializeParams(): ClientInitializeParams;
  /** Shows a message from the server to the user. */
  showMessage(params: MessageParams): void;
  /** Shows the progress of something the server is doing (ex. downloading a plugin). */
  showProgress(title: string, percentage: number | undefined): ProgressHandle;
  /** Shows the problems with a config file, which replace the ones shown before for it. */
  onDiagnostics(params: PublishDiagnosticsParams): void;
  /** Called when what a config file formats may have changed in a way the editor can't see. */
  onConfigChanged(params: ConfigChangedParams): void;
  /**
   * Called when a server is started again after one exited (ex. it crashed), which doesn't know
   * what the one before it was told (ex. the files the config files were resolved from).
   */
  onRestart?(): void;
  logger: ConnectionLogger;
  /** How long to wait for the server to exit after it's asked to before killing it. Defaults to one second. */
  killTimeout?: number;
}

/** How long a replaced connection waits before it's shut down (see `disposeWhenIdle`). */
export interface IdleTimeouts {
  /** How long to wait for the requests in progress (ex. a format on save). */
  requests: number;
  /** How long to wait for the user to answer what was asked for the server (ex. an approval). */
  interactions: number;
}

const DEFAULT_IDLE_TIMEOUTS: IdleTimeouts = { requests: 10_000, interactions: 10 * 60_000 };
/** How long to wait for the rest of stderr of a server that exited before it was initialized. */
const STDERR_TIMEOUT = 500;
/** How much of stderr is kept to say why a server exited before it was initialized. */
const MAX_STDERR_LENGTH = 2_000;

/**
 * Communicates with dprint's language server (`dprint lsp`) using the `dprint/*`
 * methods for editor extensions, where one process formats the files of a whole
 * workspace. The process is started on the first request and again on the next
 * request after it exits.
 */
export class LspConnection {
  readonly #options: LspConnectionOptions;
  readonly #pendingRequests = new Set<PendingRequest>();
  /** Called when a request or an interaction finishes. */
  readonly #idleListeners = new Set<() => void>();
  #server: Server | undefined;
  /** Whether a server was started, which is when starting another is a restart. */
  #hasStarted = false;
  #interactionCount = 0;
  /** Whether it's waiting to shut down, which is when a server isn't started again. */
  #closing = false;
  #disposed = false;

  constructor(options: LspConnectionOptions) {
    this.#options = options;
  }

  /** The number of requests that are waiting on a response. */
  get pendingRequestCount() {
    return this.#pendingRequests.size;
  }

  /** Starts the server when it's not running and resolves with the result of initializing it. */
  initialize(): Promise<InitializeResult> {
    return this.#track(server => server.initialized, undefined) as Promise<InitializeResult>;
  }

  fileInfo(params: FileInfoParams) {
    return this.#request<FileInfoResult>(FILE_INFO_METHOD, params);
  }

  pendingApprovals() {
    return this.#request<PendingApprovalsResult>(PENDING_APPROVALS_METHOD, {});
  }

  configInfo(params: ConfigParams) {
    return this.#request<ConfigInfoResult>(CONFIG_INFO_METHOD, params);
  }

  configSchema(params: ConfigParams) {
    return this.#request<ConfigSchemaResult>(CONFIG_SCHEMA_METHOD, params);
  }

  approve(params: ApproveParams) {
    return this.#request<ApproveResult>(APPROVE_METHOD, params);
  }

  /** Formats the text of the document, which resolves with undefined when the format was cancelled. */
  format(params: FormatParams, token: ConnectionCancellationToken): Promise<FormatResult | undefined> {
    return this.#track(server => this.#sendRequest<FormatResult>(server, FORMAT_METHOD, params, token), token);
  }

  /** Sends the settings to a running server. One that's started later is initialized with them. */
  updateSettings(settings: ServerSettings) {
    const server = this.#server;
    if (server != null) {
      this.#notify(server, "workspace/didChangeConfiguration", { settings });
    }
  }

  /**
   * Tells a running server that a config file was created, changed, or deleted, which it doesn't watch
   * for itself. One that's started later reads the config files when they're used.
   */
  configFileChanged(uri: string, type: FileChangeType) {
    const server = this.#server;
    if (server != null) {
      this.#notify(server, "workspace/didChangeWatchedFiles", { changes: [{ uri, type }] });
    }
  }

  /** Sends the workspace folders to a running server. One that's started later is initialized with them. */
  updateWorkspaceFolders(folders: WorkspaceFolder[]) {
    const server = this.#server;
    if (server == null) {
      return;
    }
    const added = folders.filter(folder => !server.workspaceFolders.some(other => other.uri === folder.uri));
    const removed = server.workspaceFolders.filter(other => !folders.some(folder => folder.uri === other.uri));
    server.workspaceFolders = folders;
    if (added.length > 0 || removed.length > 0) {
      this.#notify(server, "workspace/didChangeWorkspaceFolders", { event: { added, removed } });
    }
  }

  /**
   * Keeps the server running until what's asked of the user for it (ex. an approval)
   * finishes when the connection is disposed when idle, so the answer reaches it.
   */
  trackInteraction<T>(interaction: Promise<T>): Promise<T> {
    this.#interactionCount++;
    return interaction.finally(() => {
      this.#interactionCount--;
      this.#notifyIdleListeners();
    });
  }

  /**
   * Shuts down the server once its requests finish and the user answered what was asked
   * for it, which is for a connection that was replaced. That way a format in progress still
   * gets its edits and an approval reaches the process that needed it. The server isn't
   * started again in the meantime.
   */
  disposeWhenIdle(timeouts = DEFAULT_IDLE_TIMEOUTS) {
    if (this.#closing || this.#disposed) {
      return Promise.resolve();
    }
    this.#closing = true;
    return Promise.all([
      this.#waitFor(() => this.#pendingRequests.size === 0, timeouts.requests),
      // an answer can't reach a process that exited
      this.#waitFor(() => this.#interactionCount === 0 || this.#server == null, timeouts.interactions),
    ]).then(() => this.dispose());
  }

  /** Shuts down the server, which is killed when it doesn't exit soon enough. */
  dispose() {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    const server = this.#server;
    if (server == null) {
      return;
    }
    this.#endProgress(server);
    const killTimeout = setTimeout(() => this.#kill(server), this.#options.killTimeout ?? 1_000);
    server.exited.then(() => clearTimeout(killTimeout));
    server.initialized
      .then(() => server.connection.sendRequest("shutdown"))
      .then(() => server.connection.sendNotification("exit"))
      .catch(() => {/* it's killed after the timeout */});
  }

  #request<T>(method: string, params: unknown) {
    return this.#track(server => this.#sendRequest<T>(server, method, params, undefined), undefined) as Promise<T>;
  }

  /**
   * Tracks a request to the running server, which is started when it's not. It resolves with
   * undefined once the token is cancelled and rejects when the server exits in the meantime.
   */
  #track<T>(
    action: (server: Server) => Promise<T>,
    token: ConnectionCancellationToken | undefined,
  ): Promise<T | undefined> {
    if (token?.isCancellationRequested) {
      return Promise.resolve(undefined);
    }
    const server = this.#ensureServer();
    if (server == null) {
      return Promise.reject(new Error("The dprint language server is not running."));
    }
    return new Promise<T | undefined>((resolve, reject) => {
      const settle = (action: () => void) => {
        if (this.#pendingRequests.delete(pendingRequest)) {
          cancellationDisposable?.dispose();
          action();
          this.#notifyIdleListeners();
        }
      };
      const pendingRequest: PendingRequest = { server, reject: err => settle(() => reject(err)) };
      this.#pendingRequests.add(pendingRequest);
      const cancellationDisposable = token?.onCancellationRequested(() => settle(() => resolve(undefined)));
      action(server).then(value => settle(() => resolve(value)), err => settle(() => reject(err)));
    });
  }

  /** Sends the request once the server is initialized, which is cancelled with the token. */
  async #sendRequest<T>(
    server: Server,
    method: string,
    params: unknown,
    token: ConnectionCancellationToken | undefined,
  ): Promise<T | undefined> {
    await server.initialized;
    if (token?.isCancellationRequested) {
      return undefined;
    }
    const source = new CancellationTokenSource();
    // this sends the cancellation to the server, which responds to the request once it stops
    const disposable = token?.onCancellationRequested(() => {
      source.cancel();
      disposable?.dispose();
    });
    try {
      return await server.connection.sendRequest<T>(method, params, source.token);
    } finally {
      disposable?.dispose();
      source.dispose();
    }
  }

  /** Sends the notification once the server is initialized. */
  #notify(server: Server, method: string, params: unknown) {
    server.initialized
      .then(result => {
        if (!server.hasExited && isSupportedServer(result)) {
          return server.connection.sendNotification(method, params);
        }
      })
      .catch(err => this.#options.logger.logDebug(`Error sending ${method}:`, err));
  }

  #ensureServer() {
    if (this.#disposed) {
      return undefined;
    }
    if (this.#server == null && !this.#closing) {
      const isRestart = this.#hasStarted;
      this.#hasStarted = true;
      this.#server = this.#startServer();
      if (isRestart) {
        this.#server.initialized.then(() => this.#options.onRestart?.(), () => {/* the requests fail too */});
      }
    }
    return this.#server;
  }

  #startServer(): Server {
    const logger = this.#options.logger;
    const process = this.#options.spawn();
    const reader = new StreamMessageReader(process.stdout);
    const writer = new StreamMessageWriter(process.stdin);
    const connection = createMessageConnection(reader, writer, {
      error: message => logger.logError(message),
      warn: message => logger.logWarn(message),
      info: message => logger.logDebug(message),
      log: message => logger.logDebug(message),
    });
    const initializeParams = this.#options.getInitializeParams();
    let resolveExited!: () => void;
    const server: Server = {
      process,
      connection,
      initialized: undefined!,
      isInitialized: false,
      hasExited: false,
      exited: new Promise(resolve => resolveExited = resolve),
      workspaceFolders: initializeParams.workspaceFolders,
      progress: new Map(),
      stderr: "",
    };

    connection.onNotification("window/logMessage", (params: MessageParams) => this.#log(params));
    connection.onNotification("window/showMessage", (params: MessageParams) => this.#options.showMessage(params));
    connection.onNotification(
      "textDocument/publishDiagnostics",
      (params: PublishDiagnosticsParams) => this.#options.onDiagnostics(params),
    );
    connection.onNotification(
      CONFIG_CHANGED_NOTIFICATION,
      (params: ConfigChangedParams) => this.#options.onConfigChanged(params),
    );
    // the progress is shown once it begins
    connection.onRequest("window/workDoneProgress/create", () => null);
    connection.onUnhandledProgress((params: ProgressParams) => this.#handleProgress(server, params));
    reader.onError(err => {
      logger.logError("Error reading from the dprint language server:", err);
      this.#kill(server);
    });
    // a failed write is reported to the request
    writer.onError(([err]) => logger.logDebug("Error writing to the dprint language server:", err));
    process.stdin.on("error", err => logger.logDebug("Error writing to the dprint language server:", err));
    process.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      server.stderr = (server.stderr + text).slice(-MAX_STDERR_LENGTH);
      if (text.trim().length > 0) {
        logger.log(text.trim());
      }
    });
    process.on("exit", () => {
      resolveExited();
      if (server.hasExited) {
        return; // it was killed
      }
      if (server.isInitialized) {
        this.#onExit(server, new Error("The dprint language server exited while the request was in progress."));
        return;
      }
      // the next request starts it again, while the requests are rejected with what it wrote,
      // which says why it exited (ex. an older dprint without the subcommand)
      this.#onExit(server, undefined);
      waitForEnd(process.stderr, STDERR_TIMEOUT).then(() => {
        const stderr = server.stderr.trim();
        this.#rejectPendingRequests(
          server,
          new Error(`The dprint language server exited before it was initialized.${stderr ? ` ${stderr}` : ""}`),
        );
        connection.dispose();
      });
    });
    // a process that fails to spawn (ex. the executable or the cwd no longer exists) only emits this event
    process.on("error", err => {
      resolveExited();
      logger.logError("dprint language server process error:", err);
      this.#onExit(server, new Error(`The dprint language server failed to start. ${err}`));
    });

    connection.listen();
    server.initialized = connection.sendRequest<InitializeResult>("initialize", {
      ...initializeParams,
      capabilities: {
        experimental: { dprint: { versions: DPRINT_METHODS_VERSIONS } },
        window: { workDoneProgress: true },
      },
    }).then(result => {
      server.isInitialized = true;
      // an older dprint without the dprint methods is shut down instead
      if (isSupportedServer(result)) {
        connection.sendNotification("initialized", {}).catch(() => {/* the requests fail too */});
      }
      return result;
    });
    // the requests that wait on it are rejected with why
    server.initialized.catch(() => {/* ignore */});
    return server;
  }

  /**
   * Stops using a server that exited, whose requests are rejected with the error. When it's
   * not provided, the caller rejects them and disposes the server's connection later.
   */
  #onExit(server: Server, err: Error | undefined) {
    if (server.hasExited) {
      return;
    }
    server.hasExited = true;
    if (this.#server === server) {
      this.#server = undefined;
    }
    this.#endProgress(server);
    if (err != null) {
      this.#rejectPendingRequests(server, err);
      // after rejecting them because this rejects the requests it sent with another error
      server.connection.dispose();
    }
    this.#notifyIdleListeners();
  }

  #rejectPendingRequests(server: Server, err: Error) {
    for (const pendingRequest of [...this.#pendingRequests]) {
      if (pendingRequest.server === server) {
        pendingRequest.reject(err);
      }
    }
  }

  #kill(server: Server) {
    try {
      server.process.kill();
    } catch {
      // ignore
    }
    this.#onExit(server, new Error("The dprint language server was stopped while the request was in progress."));
  }

  #log(params: MessageParams) {
    const logger = this.#options.logger;
    switch (params.type) {
      case MessageType.Error:
        logger.logError(params.message);
        break;
      case MessageType.Warning:
        logger.logWarn(params.message);
        break;
      case MessageType.Log:
        logger.logDebug(params.message);
        break;
      default:
        // includes the types that are newer than the extension
        logger.logInfo(params.message);
        break;
    }
  }

  #handleProgress(server: Server, params: ProgressParams) {
    if (server.hasExited) {
      return;
    }
    const value = params.value;
    switch (value?.kind) {
      case "begin":
        server.progress.get(params.token)?.end();
        server.progress.set(params.token, this.#options.showProgress(value.title, value.percentage));
        break;
      case "report":
        if (value.percentage != null) {
          server.progress.get(params.token)?.report(value.percentage);
        }
        break;
      case "end":
        server.progress.get(params.token)?.end();
        server.progress.delete(params.token);
        break;
    }
  }

  /** Ends the progress of a server, which doesn't send the end of it once it exits. */
  #endProgress(server: Server) {
    for (const progress of server.progress.values()) {
      progress.end();
    }
    server.progress.clear();
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
}

/** A started `dprint lsp` process. */
interface Server {
  process: ServerProcess;
  connection: MessageConnection;
  initialized: Promise<InitializeResult>;
  /** Whether it responded to the initialize request. */
  isInitialized: boolean;
  hasExited: boolean;
  /** Resolves once the process exited or failed to start. */
  exited: Promise<void>;
  /** The workspace folders the server has. */
  workspaceFolders: WorkspaceFolder[];
  /** The progress being shown by its token. */
  progress: Map<number | string, ProgressHandle>;
  /** The end of what it wrote to stderr. */
  stderr: string;
}

interface PendingRequest {
  server: Server;
  reject(err: unknown): void;
}

/** Resolves once the stream ended or after the timeout. */
function waitForEnd(stream: Readable, timeout: number) {
  return new Promise<void>(resolve => {
    if (stream.readableEnded || stream.destroyed) {
      resolve();
      return;
    }
    const timeoutId = setTimeout(done, timeout);
    stream.once("end", done);
    stream.once("close", done);
    function done() {
      clearTimeout(timeoutId);
      stream.off("end", done);
      stream.off("close", done);
      resolve();
    }
  });
}
