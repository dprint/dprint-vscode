import * as assert from "node:assert";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import {
  type CancellationToken,
  createMessageConnection,
  type MessageConnection,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { FileChangeType, LspConnection, type ServerProcess } from "./LspConnection";
import type {
  ClientInitializeParams,
  ConfigChangedParams,
  InitializeResult,
  MessageParams,
  PublishDiagnosticsParams,
} from "./messages";

describe("LspConnection", () => {
  it("initializes the server before sending a request", async () => {
    const { connection, processes } = createConnection();

    const fileInfo = connection.fileInfo({ textDocument: { uri: "file:///file.ts" } });
    const process = processes[0];
    const initialize = await process.nextMessage();
    assert.strictEqual(initialize.method, "initialize");
    assert.deepStrictEqual(initialize.params, {
      ...INITIALIZE_PARAMS,
      capabilities: { experimental: { dprint: { version: 1 } }, window: { workDoneProgress: true } },
    });
    assert.strictEqual((await process.nextMessage()).method, "initialized");
    const request = await process.nextMessage();
    assert.strictEqual(request.method, "dprint/fileInfo");
    assert.deepStrictEqual(request.params, { textDocument: { uri: "file:///file.ts" } });

    const result = { configFile: null, plugins: [], status: { kind: "notFormatted", reason: "noConfigFile" } };
    request.respond(result);
    assert.deepStrictEqual(await fileInfo, result);
    assert.strictEqual(connection.pendingRequestCount, 0);
  });

  it("resolves with the result of initializing an older dprint without initializing it", async () => {
    const result: InitializeResult = { capabilities: {}, serverInfo: { name: "dprint", version: "0.64.0" } };
    const { connection, processes } = createConnection({ initializeResult: result });

    assert.deepStrictEqual(await connection.initialize(), result);
    // it's shut down instead
    connection.dispose();
    assert.strictEqual((await processes[0].nextMessage()).method, "initialize");
    assert.strictEqual((await processes[0].nextMessage()).method, "shutdown");
  });

  it("formats with the params and resolves with the result", async () => {
    const { connection, processes } = createConnection();

    const params = {
      textDocument: { uri: "untitled:Untitled-1" },
      language: { id: "typescript", fileExtensions: [".ts"] },
      text: "text",
      ranges: [{ start: { line: 0, character: 1 }, end: { line: 0, character: 3 } }],
      useGlobalConfig: true,
    };
    const format = connection.format(params, new FakeCancellationToken());
    const process = processes[0];
    const request = await process.nextRequest("dprint/format");
    assert.deepStrictEqual(request.params, params);
    const result = {
      kind: "formatted",
      edits: [{ range: { start: { line: 0, character: 4 }, end: { line: 0, character: 4 } }, newText: "_formatted" }],
    };
    request.respond(result);
    assert.deepStrictEqual(await format, result);

    const notFormatted = connection.format(
      { textDocument: { uri: "file:///file.ts" }, text: "text" },
      new FakeCancellationToken(),
    );
    const notFormattedResult = { kind: "notFormatted", reason: "notMatched", message: "Not matched." };
    (await process.nextRequest("dprint/format")).respond(notFormattedResult);
    assert.deepStrictEqual(await notFormatted, notFormattedResult);
  });

  it("cancels a format", async () => {
    const { connection, processes } = createConnection();
    const token = new FakeCancellationToken();

    const format = connection.format({ textDocument: { uri: "file:///file.ts" }, text: "text" }, token);
    const request = await processes[0].nextRequest("dprint/format");
    token.cancel();
    assert.strictEqual(await format, undefined);
    // the server is told
    await new Promise<void>(resolve => request.token.onCancellationRequested(() => resolve()));
    assert.strictEqual(token.listenerCount, 0);
    assert.strictEqual(connection.pendingRequestCount, 0);
  });

  it("doesn't send a format that was cancelled before the server was initialized", async () => {
    const { connection, processes } = createConnection({ initializeResult: null });
    const token = new FakeCancellationToken();

    const format = connection.format({ textDocument: { uri: "file:///file.ts" }, text: "text" }, token);
    const initialize = await processes[0].nextMessage();
    token.cancel();
    assert.strictEqual(await format, undefined);
    initialize.respond(SUPPORTED_RESULT);
    assert.strictEqual((await processes[0].nextMessage()).method, "initialized");

    // the next message is the next request
    connection.fileInfo({ textDocument: { uri: "file:///file.ts" } }).catch(() => {/* ignore */});
    assert.strictEqual((await processes[0].nextMessage()).method, "dprint/fileInfo");
  });

  it("ignores a late response to a cancelled format", async () => {
    const { connection, processes } = createConnection();
    const token = new FakeCancellationToken();

    const format = connection.format({ textDocument: { uri: "file:///file.ts" }, text: "text" }, token);
    const process = processes[0];
    const request = await process.nextRequest("dprint/format");
    token.cancel();
    assert.strictEqual(await format, undefined);
    request.respond({ kind: "formatted", edits: [] });

    // the next request gets its own response
    const fileInfo = connection.fileInfo({ textDocument: { uri: "file:///file.ts" } });
    const result = { configFile: null, plugins: [], status: { kind: "ready" } };
    (await process.nextRequest("dprint/fileInfo")).respond(result);
    assert.deepStrictEqual(await fileInfo, result);
    assert.strictEqual(connection.pendingRequestCount, 0);
    assert.strictEqual(process.killCount, 0);
  });

  it("sends the other requests", async () => {
    const { connection, processes } = createConnection();

    const configInfo = connection.configInfo({ uri: "file:///dprint.json", globalConfig: "never" });
    const process = processes[0];
    const configInfoRequest = await process.nextRequest("dprint/configInfo");
    assert.deepStrictEqual(configInfoRequest.params, { uri: "file:///dprint.json", globalConfig: "never" });
    const configInfoResult = { configFile: null, plugins: null, formatsOtherFiles: false, status: { kind: "ready" } };
    configInfoRequest.respond(configInfoResult);
    assert.deepStrictEqual(await configInfo, configInfoResult);

    const configSchema = connection.configSchema({ uri: "file:///dprint.json" });
    (await process.nextRequest("dprint/configSchema")).respond({ schema: { type: "object" } });
    assert.deepStrictEqual(await configSchema, { schema: { type: "object" } });

    const approve = connection.approve({ id: "id", decision: "alwaysAllow" });
    const approveRequest = await process.nextRequest("dprint/approve");
    assert.deepStrictEqual(approveRequest.params, { id: "id", decision: "alwaysAllow" });
    approveRequest.respond({ approvals: [] });
    assert.deepStrictEqual(await approve, { approvals: [] });
  });

  it("rejects a request with an error response", async () => {
    const { connection, processes } = createConnection();

    const configInfo = connection.configInfo({ uri: "file:///dprint.json" });
    (await processes[0].nextRequest("dprint/configInfo")).fail("Error resolving the config.");
    await assert.rejects(configInfo, /Error resolving the config\./);
  });

  it("rejects the pending requests when the server exits and starts it again on the next request", async () => {
    const { connection, processes } = createConnection();

    const fileInfo = connection.fileInfo({ textDocument: { uri: "file:///file.ts" } });
    await processes[0].nextRequest("dprint/fileInfo");
    processes[0].exit();
    await assert.rejects(fileInfo, /exited while the request was in progress/);
    assert.strictEqual(connection.pendingRequestCount, 0);

    connection.fileInfo({ textDocument: { uri: "file:///file.ts" } }).catch(() => {/* ignore */});
    assert.strictEqual(processes.length, 2);
    // the new process is initialized too
    assert.strictEqual((await processes[1].nextMessage()).method, "initialize");
  });

  it("rejects with what the server wrote when it exits before it's initialized", async () => {
    const { connection, processes } = createConnection({ initializeResult: null });

    const initialize = connection.initialize();
    await processes[0].nextMessage();
    processes[0].stderr.write("error: unrecognized subcommand 'lsp'\n");
    processes[0].exit();
    await assert.rejects(initialize, /exited before it was initialized\. error: unrecognized subcommand 'lsp'$/);
    assert.strictEqual(connection.pendingRequestCount, 0);
  });

  it("rejects the pending requests when the process fails to start", async () => {
    const { connection, processes } = createConnection({ initializeResult: null });

    const fileInfo = connection.fileInfo({ textDocument: { uri: "file:///file.ts" } });
    processes[0].emit("error", new Error("spawn dprint ENOENT"));
    await assert.rejects(fileInfo, /failed to start\. Error: spawn dprint ENOENT/);
    assert.strictEqual(connection.pendingRequestCount, 0);

    // it's started again on the next request
    connection.fileInfo({ textDocument: { uri: "file:///file.ts" } }).catch(() => {/* ignore */});
    assert.strictEqual(processes.length, 2);
  });

  it("kills the process when its output can't be read", async () => {
    const { connection, processes } = createConnection();

    const configInfo = connection.configInfo({ uri: "file:///dprint.json" });
    const process = processes[0];
    await process.nextRequest("dprint/configInfo");
    process.stdout.write("Content-Length: abc\r\n\r\n");
    await assert.rejects(configInfo, /stopped while the request was in progress/);
    assert.strictEqual(process.killCount, 1);
    assert.strictEqual(connection.pendingRequestCount, 0);
  });

  it("shows the messages from the server", async () => {
    const shownMessages: MessageParams[] = [];
    const { connection, processes } = createConnection({ showMessage: params => shownMessages.push(params) });

    await connection.initialize();
    await processes[0].peer.sendNotification("window/showMessage", { type: 2, message: "Some message." });
    await waitUntil(() => shownMessages.length > 0);
    assert.deepStrictEqual(shownMessages, [{ type: 2, message: "Some message." }]);
  });

  it("logs the log messages at their level", async () => {
    const { connection, processes, logs } = createConnection();

    await connection.initialize();
    for (const type of [1, 2, 3, 4, 5]) {
      await processes[0].peer.sendNotification("window/logMessage", { type, message: `Type ${type}.` });
    }
    await waitUntil(() => logs.length === 5);
    assert.deepStrictEqual(logs, [
      ["error", "Type 1."],
      ["warn", "Type 2."],
      ["info", "Type 3."],
      ["debug", "Type 4."],
      // a type that's newer than the extension
      ["info", "Type 5."],
    ]);
  });

  it("logs what the server writes to stderr", async () => {
    const { connection, processes, logs } = createConnection();

    await connection.initialize();
    processes[0].stderr.write("thread 'main' panicked\n");
    await waitUntil(() => logs.length > 0);
    assert.deepStrictEqual(logs, [["log", "thread 'main' panicked"]]);
  });

  it("shows the progress until it ends or the server exits", async () => {
    const { connection, processes, progress } = createConnection();

    await connection.initialize();
    const peer = processes[0].peer;
    assert.strictEqual(await peer.sendRequest("window/workDoneProgress/create", { token: "dprint/1" }), null);
    await peer.sendNotification("$/progress", { token: "dprint/1", value: { kind: "begin", title: "Downloading" } });
    await peer.sendNotification("$/progress", {
      token: "dprint/2",
      value: { kind: "begin", title: "Compiling", percentage: 0 },
    });
    await peer.sendNotification("$/progress", { token: "dprint/1", value: { kind: "report", percentage: 50 } });
    await peer.sendNotification("$/progress", {
      token: "dprint/1",
      value: { kind: "report", message: "No percentage." },
    });
    await peer.sendNotification("$/progress", { token: "dprint/1", value: { kind: "end" } });
    // for a progress that's not shown
    await peer.sendNotification("$/progress", { token: "dprint/3", value: { kind: "report", percentage: 10 } });
    await waitUntil(() => progress[0]?.ended === true);
    await nextTick();
    assert.deepStrictEqual(progress, [
      { title: "Downloading", reports: [undefined, 50], ended: true },
      { title: "Compiling", reports: [0], ended: false },
    ]);

    // the server that exited can't end it
    processes[0].exit();
    assert.strictEqual(progress[1].ended, true);
  });

  it("provides the diagnostics and config changes", async () => {
    const diagnostics: PublishDiagnosticsParams[] = [];
    const configChanges: ConfigChangedParams[] = [];
    const { connection, processes } = createConnection({
      onDiagnostics: params => diagnostics.push(params),
      onConfigChanged: params => configChanges.push(params),
    });

    await connection.initialize();
    const diagnosticsParams = {
      uri: "file:///dprint.json",
      diagnostics: [{
        range: { start: { line: 1, character: 2 }, end: { line: 1, character: 19 } },
        severity: 1,
        message: "Unknown property in configuration",
      }],
    };
    await processes[0].peer.sendNotification("textDocument/publishDiagnostics", diagnosticsParams);
    await processes[0].peer.sendNotification("dprint/configChanged", { uri: "file:///dprint.json" });
    await waitUntil(() => configChanges.length > 0);
    assert.deepStrictEqual(diagnostics, [diagnosticsParams]);
    assert.deepStrictEqual(configChanges, [{ uri: "file:///dprint.json" }]);
  });

  it("sends the settings and workspace folders to a running server", async () => {
    const { connection, processes } = createConnection();

    // a server that's started later is initialized with them
    connection.updateSettings({ useGlobalConfig: true });
    connection.updateWorkspaceFolders([]);
    assert.strictEqual(processes.length, 0);

    await connection.initialize();
    const process = processes[0];
    await process.nextMessage(); // initialize
    await process.nextMessage(); // initialized
    connection.updateSettings({ useGlobalConfig: true, ensureStableFormat: false, verbose: false });
    const settings = await process.nextMessage();
    assert.strictEqual(settings.method, "workspace/didChangeConfiguration");
    assert.deepStrictEqual(settings.params, {
      settings: { useGlobalConfig: true, ensureStableFormat: false, verbose: false },
    });

    const other = { uri: "file:///other", name: "other" };
    connection.updateWorkspaceFolders([other]);
    const folders = await process.nextMessage();
    assert.strictEqual(folders.method, "workspace/didChangeWorkspaceFolders");
    assert.deepStrictEqual(folders.params, { event: { added: [other], removed: INITIALIZE_PARAMS.workspaceFolders } });
    // nothing is sent when they didn't change
    connection.updateWorkspaceFolders([other]);
    connection.updateSettings({ verbose: true });
    assert.strictEqual((await process.nextMessage()).method, "workspace/didChangeConfiguration");
  });

  it("tells a running server that a config file changed", async () => {
    const { connection, processes } = createConnection();
    // a server that's started later reads the config file when it's used
    connection.configFileChanged("file:///dprint.json", FileChangeType.Changed);
    assert.strictEqual(processes.length, 0);

    await connection.initialize();
    const process = processes[0];
    await process.nextMessage(); // initialize
    await process.nextMessage(); // initialized
    connection.configFileChanged("file:///dprint.json", FileChangeType.Deleted);
    const message = await process.nextMessage();
    assert.strictEqual(message.method, "workspace/didChangeWatchedFiles");
    assert.deepStrictEqual(message.params, { changes: [{ uri: "file:///dprint.json", type: 3 }] });
  });

  it("kills the process when it doesn't exit in time", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { connection, processes } = createConnection();

    await connection.initialize();
    const process = processes[0];
    connection.dispose();
    await process.nextRequest("shutdown");
    t.mock.timers.tick(999);
    assert.strictEqual(process.killCount, 0);
    t.mock.timers.tick(1);
    assert.strictEqual(process.killCount, 1);
  });

  it("shuts down the server when disposed", async () => {
    const { connection, processes } = createConnection();

    connection.fileInfo({ textDocument: { uri: "file:///file.ts" } }).catch(() => {/* ignore */});
    const process = processes[0];
    await process.nextRequest("dprint/fileInfo");
    connection.dispose();
    (await process.nextRequest("shutdown")).respond(null);
    assert.strictEqual((await process.nextMessage()).method, "exit");
    process.exit();
    await nextTick();
    assert.strictEqual(process.killCount, 0);
    // the process isn't started again
    await assert.rejects(connection.fileInfo({ textDocument: { uri: "file:///file.ts" } }), /not running/);
    assert.strictEqual(processes.length, 1);
  });

  it("shuts down a replaced server once its requests finish", async () => {
    const { connection, processes } = createConnection();

    const fileInfo = connection.fileInfo({ textDocument: { uri: "file:///file.ts" } });
    const process = processes[0];
    const request = await process.nextRequest("dprint/fileInfo");
    let isDisposed = false;
    const disposed = connection.disposeWhenIdle().then(() => isDisposed = true);
    await nextTick();
    assert.strictEqual(isDisposed, false);

    const result = { configFile: null, plugins: [], status: { kind: "ready" } };
    request.respond(result);
    assert.deepStrictEqual(await fileInfo, result);
    await disposed;
    assert.strictEqual((await process.nextMessage()).method, "shutdown");
  });

  it("doesn't start a replaced server again", async () => {
    const { connection, processes } = createConnection();

    connection.fileInfo({ textDocument: { uri: "file:///file.ts" } }).catch(() => {/* ignore */});
    await processes[0].nextRequest("dprint/fileInfo");
    connection.disposeWhenIdle();
    processes[0].exit();
    await assert.rejects(connection.fileInfo({ textDocument: { uri: "file:///file.ts" } }), /not running/);
    assert.strictEqual(processes.length, 1);
  });

  it("shuts down a replaced server once what was asked of the user for it finishes", async () => {
    const { connection, processes } = createConnection();

    await connection.initialize();
    const process = processes[0];
    let answer!: () => void;
    const answered = new Promise<void>(resolve => answer = resolve);
    connection.trackInteraction((async () => {
      await answered;
      await connection.approve({ id: "id", decision: "allow" });
    })());
    let isDisposed = false;
    const disposed = connection.disposeWhenIdle().then(() => isDisposed = true);
    await nextTick();
    assert.strictEqual(isDisposed, false);

    // the answer reaches the server that needed it
    answer();
    (await process.nextRequest("dprint/approve")).respond({ approvals: [] });
    await disposed;
    assert.strictEqual((await process.nextRequest("shutdown")).method, "shutdown");
  });

  it("shuts down a replaced server after the timeouts", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { connection, processes } = createConnection();

    connection.fileInfo({ textDocument: { uri: "file:///file.ts" } }).catch(() => {/* ignore */});
    const process = processes[0];
    await process.nextRequest("dprint/fileInfo"); // never answered
    connection.trackInteraction(new Promise(() => {/* never answered */}));
    let isDisposed = false;
    const disposed = connection.disposeWhenIdle({ requests: 100, interactions: 1_000 }).then(() => isDisposed = true);
    t.mock.timers.tick(100);
    await nextTick();
    assert.strictEqual(isDisposed, false);
    t.mock.timers.tick(900);
    await disposed;
    assert.strictEqual((await process.nextMessage()).method, "shutdown");
  });
});

const INITIALIZE_PARAMS: ClientInitializeParams = {
  processId: 1234,
  clientInfo: { name: "test" },
  workspaceFolders: [{ uri: "file:///project", name: "project" }],
  initializationOptions: { useGlobalConfig: false },
};

const SUPPORTED_RESULT: InitializeResult = {
  capabilities: { experimental: { dprint: { version: 1 } } },
  serverInfo: { name: "dprint", version: "0.65.0" },
};

function createConnection(options: {
  /** The result of the initialize request, which the test responds with itself when null. */
  initializeResult?: InitializeResult | null;
  showMessage?: (params: MessageParams) => void;
  onDiagnostics?: (params: PublishDiagnosticsParams) => void;
  onConfigChanged?: (params: ConfigChangedParams) => void;
} = {}) {
  const processes: FakeProcess[] = [];
  const logs: [string, string][] = [];
  const progress: { title: string; reports: (number | undefined)[]; ended: boolean }[] = [];
  const connection = new LspConnection({
    spawn: () => {
      const process = new FakeProcess(
        options.initializeResult === undefined ? SUPPORTED_RESULT : options.initializeResult,
      );
      processes.push(process);
      return process as unknown as ServerProcess;
    },
    getInitializeParams: () => INITIALIZE_PARAMS,
    showMessage: options.showMessage ?? (() => {}),
    showProgress(title, percentage) {
      const item = { title, reports: [percentage], ended: false };
      progress.push(item);
      return {
        report: percentage => item.reports.push(percentage),
        end: () => item.ended = true,
      };
    },
    onDiagnostics: options.onDiagnostics ?? (() => {}),
    onConfigChanged: options.onConfigChanged ?? (() => {}),
    logger: {
      log: message => logs.push(["log", message]),
      logDebug: message => logs.push(["debug", message]),
      logInfo: message => logs.push(["info", message]),
      logWarn: message => logs.push(["warn", message]),
      logError: message => logs.push(["error", message]),
    },
  });
  return { connection, processes, logs, progress };
}

/** A request or notification that the connection sent. */
interface ReceivedMessage {
  method: string;
  params: any;
  token: CancellationToken;
  /** Responds to a request. */
  respond(result: unknown): void;
  /** Responds to a request with an error. */
  fail(message: string): void;
}

/** A `dprint lsp` process, which is a JSON-RPC peer that the test responds with. */
class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly peer: MessageConnection;
  readonly #messages: ReceivedMessage[] = [];
  readonly #waiters: ((message: ReceivedMessage) => void)[] = [];
  killCount = 0;

  constructor(initializeResult: InitializeResult | null) {
    super();
    this.peer = createMessageConnection(new StreamMessageReader(this.stdin), new StreamMessageWriter(this.stdout));
    this.peer.onRequest((method, params, token) => {
      return new Promise((resolve, reject) => {
        const message: ReceivedMessage = {
          method,
          params,
          token,
          respond: resolve,
          fail: errorMessage => reject(new ResponseError(-32603, errorMessage)),
        };
        if (method === "initialize" && initializeResult != null) {
          message.respond(initializeResult);
        }
        this.#push(message);
      });
    });
    this.peer.onNotification((method, params) => {
      const ignore = () => {
        throw new Error("Can't respond to a notification.");
      };
      this.#push({ method, params, token: undefined!, respond: ignore, fail: ignore });
    });
    this.peer.listen();
  }

  kill() {
    this.killCount++;
    return true;
  }

  /** Exits the process. */
  exit() {
    this.stderr.end();
    this.emit("exit", 1, null);
  }

  /** Gets the next request or notification that the connection sent. */
  nextMessage() {
    const message = this.#messages.shift();
    if (message != null) {
      return Promise.resolve(message);
    }
    return new Promise<ReceivedMessage>(resolve => this.#waiters.push(resolve));
  }

  /** Gets the next request with the method, skipping the other messages (ex. initialize). */
  async nextRequest(method: string) {
    while (true) {
      const message = await this.nextMessage();
      if (message.method === method) {
        return message;
      }
    }
  }

  #push(message: ReceivedMessage) {
    const waiter = this.#waiters.shift();
    if (waiter != null) {
      waiter(message);
    } else {
      this.#messages.push(message);
    }
  }
}

class FakeCancellationToken {
  readonly #listeners = new Set<() => void>();
  isCancellationRequested = false;

  get listenerCount() {
    return this.#listeners.size;
  }

  onCancellationRequested(listener: () => void) {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  cancel() {
    this.isCancellationRequested = true;
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }
}

/** Waits for the pending promise callbacks and immediates to run. */
function nextTick() {
  return new Promise<void>(resolve => setImmediate(resolve));
}

/** Waits for the condition, which is checked after the pending promise callbacks and immediates run. */
async function waitUntil(condition: () => boolean) {
  for (let i = 0; i < 100 && !condition(); i++) {
    await nextTick();
  }
}
