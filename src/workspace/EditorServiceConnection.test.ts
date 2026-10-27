import * as assert from "node:assert";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { EditorServiceConnection, type EditorServiceProcess } from "./EditorServiceConnection";
import {
  BodyReader,
  type ConfigChangedData,
  type ConfigDiagnosticsData,
  encodeMessage,
  type MessageAction,
  MessageDecoder,
  MessageKind,
  type RawMessage,
  type ShowMessageData,
  type ShowMessageRequestData,
} from "./messages";

describe("EditorServiceConnection", () => {
  it("initializes the process before sending a request", async () => {
    const { connection, processes } = createConnection();

    const fileInfo = connection.fileInfo({ uri: "file:///file.ts" });
    const process = processes[0];
    const initialize = await process.readMessage();
    assert.strictEqual(initialize.kind, MessageKind.Initialize);
    assert.deepStrictEqual(new BodyReader(initialize.body).readSizedJson(), INITIALIZE_DATA);
    const request = await process.readMessage();
    assert.strictEqual(request.kind, MessageKind.FileInfo);
    assert.deepStrictEqual(new BodyReader(request.body).readSizedJson(), { uri: "file:///file.ts" });

    process.send(MessageKind.SuccessResponse, [initialize.id]);
    const response = { configFile: null, canFormat: false, reason: "noConfigFile" };
    process.send(MessageKind.FileInfoResponse, [request.id, JSON.stringify(response)]);
    assert.deepStrictEqual(await fileInfo, response);
    assert.strictEqual(connection.pendingRequestCount, 0);
  });

  it("formats with the data and text", async () => {
    const { connection, processes } = createConnection();

    const data = {
      uri: "untitled:Untitled-1",
      language: { id: "typescript", fileExtensions: [".ts"], fileNames: [] },
      range: { start: 1, end: 3 },
      allowGlobalConfig: true,
    };
    const format = connection.formatFile(data, "text", new FakeCancellationToken());
    const process = processes[0];
    await process.readMessage(); // initialize
    const request = await process.readMessage();
    const body = new BodyReader(request.body);
    assert.deepStrictEqual([body.readSizedJson(), body.readSizedString()], [data, "text"]);
    const edits = [{ start: 4, end: 4, newText: "_formatted" }];
    process.send(MessageKind.FormatFileResponse, [request.id, 1, JSON.stringify({ edits })]);
    assert.deepStrictEqual(await format, { edits });

    const notFormatted = connection.formatFile({ uri: "file:///file.ts" }, "text", new FakeCancellationToken());
    const secondRequest = await process.readMessage();
    const notFormattedData = { reason: "notMatched", message: "Not matched." };
    process.send(MessageKind.FormatFileResponse, [secondRequest.id, 0, JSON.stringify(notFormattedData)]);
    assert.deepStrictEqual(await notFormatted, notFormattedData);
  });

  it("cancels a format", async () => {
    const { connection, processes } = createConnection();
    const token = new FakeCancellationToken();

    const format = connection.formatFile({ uri: "file:///file.ts" }, "text", token);
    const process = processes[0];
    process.send(MessageKind.SuccessResponse, [(await process.readMessage()).id]); // initialize
    const request = await process.readMessage();
    token.cancel();
    assert.strictEqual(await format, undefined);
    const cancel = await process.readMessage();
    assert.strictEqual(cancel.kind, MessageKind.CancelFormat);
    assert.strictEqual(new BodyReader(cancel.body).readInt(), request.id);
    assert.strictEqual(token.listenerCount, 0);
    assert.strictEqual(connection.pendingRequestCount, 0);
  });

  it("provides the diagnostics of a file that wasn't formatted", async () => {
    const { connection, processes } = createConnection();

    const format = connection.formatFile({ uri: "file:///file.ts" }, "text", new FakeCancellationToken());
    const process = processes[0];
    await process.readMessage(); // initialize
    const request = await process.readMessage();
    const data = {
      reason: "configDiagnostics",
      message: "The configuration has errors.",
      diagnostics: [{
        pluginName: "test-plugin",
        propertyName: "lineWidth",
        message: "Expected a number.",
        range: { start: { line: 1, character: 2 }, end: { line: 1, character: 13 } },
      }],
    };
    process.send(MessageKind.FormatFileResponse, [request.id, 0, JSON.stringify(data)]);
    assert.deepStrictEqual(await format, data);
  });

  it("ignores a late response to a cancelled format", async () => {
    const { connection, processes } = createConnection();
    const token = new FakeCancellationToken();

    const format = connection.formatFile({ uri: "file:///file.ts" }, "text", token);
    const process = processes[0];
    process.send(MessageKind.SuccessResponse, [(await process.readMessage()).id]); // initialize
    const request = await process.readMessage();
    token.cancel();
    assert.strictEqual(await format, undefined);
    await process.readMessage(); // cancel
    process.send(MessageKind.FormatFileResponse, [request.id, 1, JSON.stringify({ edits: [] })]);

    // the next request gets its own response
    const fileInfo = connection.fileInfo({ uri: "file:///file.ts" });
    const fileInfoRequest = await process.readMessage();
    const response = { configFile: null, canFormat: false };
    process.send(MessageKind.FileInfoResponse, [fileInfoRequest.id, JSON.stringify(response)]);
    assert.deepStrictEqual(await fileInfo, response);
    assert.strictEqual(connection.pendingRequestCount, 0);
    assert.strictEqual(process.killCount, 0);
  });

  it("ignores the output of a process that was replaced", async () => {
    const { connection, processes } = createConnection();

    connection.fileInfo({ uri: "file:///file.ts" }).catch(() => {/* ignore */});
    await processes[0].readMessage(); // initialize
    await processes[0].readMessage(); // file info
    processes[0].emit("exit", 1, null);
    const fileInfo = connection.fileInfo({ uri: "file:///file.ts" });
    await processes[1].readMessage(); // initialize
    const request = await processes[1].readMessage();
    // the replaced process responding to the new request's id
    processes[0].send(MessageKind.FileInfoResponse, [request.id, JSON.stringify({ stale: true })]);
    await nextTick();
    const response = { configFile: null, canFormat: false };
    processes[1].send(MessageKind.FileInfoResponse, [request.id, JSON.stringify(response)]);
    assert.deepStrictEqual(await fileInfo, response);
  });

  it("rejects the pending requests when the process fails to start", async () => {
    const { connection, processes } = createConnection();

    const fileInfo = connection.fileInfo({ uri: "file:///file.ts" });
    processes[0].emit("error", new Error("spawn dprint ENOENT"));
    await assert.rejects(fileInfo, /failed to start\. Error: spawn dprint ENOENT/);
    assert.strictEqual(connection.pendingRequestCount, 0);

    // it's started again on the next request
    connection.fileInfo({ uri: "file:///file.ts" }).catch(() => {/* ignore */});
    assert.strictEqual(processes.length, 2);
  });

  it("rejects a request that can't be written to the process", async () => {
    const { connection, processes } = createConnection();

    const process = startProcess(connection, processes);
    await respondToStart(process);
    process.stdin.destroy();
    await assert.rejects(connection.configInfo({ uri: "file:///dprint.json" }), /destroyed/);
    assert.strictEqual(connection.pendingRequestCount, 0);
  });

  it("rejects a request with an error response", async () => {
    const { connection, processes } = createConnection();

    const configInfo = connection.configInfo({ uri: "file:///dprint.json" });
    const process = processes[0];
    await process.readMessage(); // initialize
    const request = await process.readMessage();
    process.send(MessageKind.ErrorResponse, [request.id, "Error resolving the config."]);
    await assert.rejects(configInfo, /Error resolving the config\./);
  });

  it("rejects a request with a malformed response", async () => {
    const { connection, processes } = createConnection();

    const configInfo = connection.configInfo({ uri: "file:///dprint.json" });
    const process = processes[0];
    await process.readMessage(); // initialize
    const request = await process.readMessage();
    process.send(MessageKind.ConfigInfoResponse, [request.id, "{"]);
    await assert.rejects(configInfo, /stopped while the request was in progress/);
    assert.strictEqual(process.killCount, 1);
    assert.strictEqual(connection.pendingRequestCount, 0);
  });

  it("shows the messages from the process and responds with the chosen action", async () => {
    const shownMessages: ShowMessageData[] = [];
    const { connection, processes } = createConnection({
      showMessage: data => shownMessages.push(data),
      showMessageRequest: async data => data.actions[1],
    });

    connection.fileInfo({ uri: "file:///file.ts" }).catch(() => {/* ignore */});
    const process = processes[0];
    await process.readMessage(); // initialize
    await process.readMessage(); // file info
    process.send(MessageKind.ShowMessage, [JSON.stringify({ kind: "warning", message: "Some message." })]);
    const requestId = process.send(MessageKind.ShowMessageRequest, [JSON.stringify({
      kind: "info",
      message: "Choose.",
      actions: [{ title: "First" }, { title: "Second" }],
    })]);
    const response = await process.readMessage();
    assert.strictEqual(response.kind, MessageKind.ShowMessageRequestResponse);
    const body = new BodyReader(response.body);
    assert.deepStrictEqual([body.readInt(), body.readSizedJson()], [requestId, { action: { title: "Second" } }]);
    assert.deepStrictEqual(shownMessages, [{ kind: "warning", message: "Some message." }]);

    const activeId = process.send(MessageKind.Active, []);
    const activeResponse = await process.readMessage();
    assert.strictEqual(activeResponse.kind, MessageKind.SuccessResponse);
    assert.strictEqual(new BodyReader(activeResponse.body).readInt(), activeId);
  });

  it("logs the log messages at their level", async () => {
    const { connection, processes, logs } = createConnection();

    const process = startProcess(connection, processes);
    await respondToStart(process);
    for (const level of ["error", "warn", "info", "debug", "newLevel"]) {
      process.send(MessageKind.Log, [JSON.stringify({ level, message: `A ${level} message.` })]);
    }
    await nextTick();
    assert.deepStrictEqual(logs, [
      ["error", "A error message."],
      ["warn", "A warn message."],
      ["info", "A info message."],
      ["debug", "A debug message."],
      // a level that's newer than the extension
      ["info", "A newLevel message."],
    ]);
  });

  it("shows the progress until it ends or the process exits", async () => {
    const { connection, processes, progress } = createConnection();

    const process = startProcess(connection, processes);
    await respondToStart(process);
    process.send(MessageKind.Progress, [JSON.stringify({ id: 1, kind: "begin", title: "Downloading a.wasm" })]);
    process.send(MessageKind.Progress, [JSON.stringify({ id: 2, kind: "begin", title: "Compiling b", percentage: 0 })]);
    process.send(MessageKind.Progress, [JSON.stringify({ id: 1, kind: "report", percentage: 50 })]);
    process.send(MessageKind.Progress, [JSON.stringify({ id: 1, kind: "end" })]);
    // for a progress that's not shown
    process.send(MessageKind.Progress, [JSON.stringify({ id: 3, kind: "report", percentage: 10 })]);
    await nextTick();
    assert.deepStrictEqual(progress, [
      { title: "Downloading a.wasm", reports: [undefined, 50], ended: true },
      { title: "Compiling b", reports: [0], ended: false },
    ]);

    // the process that exited can't end it
    process.emit("exit", 1, null);
    assert.strictEqual(progress[1].ended, true);
  });

  it("provides the config diagnostics and config changes", async () => {
    const configDiagnostics: ConfigDiagnosticsData[] = [];
    const configChanges: ConfigChangedData[] = [];
    const { connection, processes } = createConnection({
      onConfigDiagnostics: data => configDiagnostics.push(data),
      onConfigChanged: data => configChanges.push(data),
    });

    const process = startProcess(connection, processes);
    await respondToStart(process);
    const diagnosticsData = {
      uri: "file:///dprint.json",
      diagnostics: [{ message: "Unknown property in configuration.", propertyName: "other" }],
    };
    process.send(MessageKind.ConfigDiagnostics, [JSON.stringify(diagnosticsData)]);
    process.send(MessageKind.ConfigChanged, [JSON.stringify({ uri: "file:///dprint.json" })]);
    await nextTick();
    assert.deepStrictEqual(configDiagnostics, [diagnosticsData]);
    assert.deepStrictEqual(configChanges, [{ uri: "file:///dprint.json" }]);
  });

  it("doesn't respond to a show message request of a process that exited", async () => {
    let chooseAction: ((action: MessageAction | undefined) => void) | undefined;
    const { connection, processes } = createConnection({
      showMessageRequest: () => new Promise(resolve => chooseAction = resolve),
    });

    connection.fileInfo({ uri: "file:///file.ts" }).catch(() => {/* ignore */});
    await processes[0].readMessage(); // initialize
    await processes[0].readMessage(); // file info
    processes[0].send(MessageKind.ShowMessageRequest, [JSON.stringify({
      kind: "info",
      message: "Choose.",
      actions: [{ title: "First" }],
    })]);
    await nextTick();
    processes[0].emit("exit", 1, null);
    connection.fileInfo({ uri: "file:///file.ts" }).catch(() => {/* ignore */});
    await processes[1].readMessage(); // initialize
    await processes[1].readMessage(); // file info
    chooseAction!({ title: "First" });
    await nextTick();

    // the next message the new process receives is the next request
    connection.configInfo({ uri: "file:///dprint.json" }).catch(() => {/* ignore */});
    assert.strictEqual((await processes[1].readMessage()).kind, MessageKind.ConfigInfo);
  });

  it("rejects the pending requests when the process exits and starts it again on the next request", async () => {
    const { connection, processes } = createConnection();

    const fileInfo = connection.fileInfo({ uri: "file:///file.ts" });
    await processes[0].readMessage(); // initialize
    await processes[0].readMessage(); // file info
    processes[0].emit("exit", 1, null);
    await assert.rejects(fileInfo, /exited while the request was in progress/);
    assert.strictEqual(connection.pendingRequestCount, 0);

    connection.fileInfo({ uri: "file:///file.ts" }).catch(() => {/* ignore */});
    assert.strictEqual(processes.length, 2);
    // the new process is initialized too
    assert.strictEqual((await processes[1].readMessage()).kind, MessageKind.Initialize);
  });

  it("kills the process when it doesn't shut down in time", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { connection, processes } = createConnection();

    const process = startProcess(connection, processes);
    await respondToStart(process);
    connection.dispose();
    assert.strictEqual((await process.readMessage()).kind, MessageKind.ShutDownProcess);
    t.mock.timers.tick(999);
    assert.strictEqual(process.killCount, 0);
    t.mock.timers.tick(1);
    assert.strictEqual(process.killCount, 1);
  });

  it("shuts down a replaced process once its requests finish", async () => {
    const { connection, processes } = createConnection();

    const fileInfo = connection.fileInfo({ uri: "file:///file.ts" });
    const process = processes[0];
    process.send(MessageKind.SuccessResponse, [(await process.readMessage()).id]); // initialize
    const request = await process.readMessage();
    let isDisposed = false;
    const disposed = connection.disposeWhenIdle().then(() => isDisposed = true);
    // a replaced connection doesn't handle new requests
    await assert.rejects(connection.configInfo({ uri: "file:///dprint.json" }), /not running/);
    await nextTick();
    assert.strictEqual(isDisposed, false);

    const response = { configFile: null, canFormat: false };
    process.send(MessageKind.FileInfoResponse, [request.id, JSON.stringify(response)]);
    assert.deepStrictEqual(await fileInfo, response);
    await disposed;
    assert.strictEqual((await process.readMessage()).kind, MessageKind.ShutDownProcess);
  });

  it("shuts down a replaced process once the user answers its messages", async () => {
    let chooseAction: ((action: MessageAction | undefined) => void) | undefined;
    const { connection, processes } = createConnection({
      showMessageRequest: () => new Promise(resolve => chooseAction = resolve),
    });

    const process = startProcess(connection, processes);
    await respondToStart(process);
    const requestId = process.send(MessageKind.ShowMessageRequest, [JSON.stringify({
      kind: "info",
      message: "Choose.",
      actions: [{ title: "Don't show again" }],
    })]);
    await nextTick();
    let isDisposed = false;
    const disposed = connection.disposeWhenIdle().then(() => isDisposed = true);
    await nextTick();
    assert.strictEqual(isDisposed, false);

    // the answer reaches the process that asked
    chooseAction!({ title: "Don't show again" });
    const response = await process.readMessage();
    assert.strictEqual(response.kind, MessageKind.ShowMessageRequestResponse);
    const body = new BodyReader(response.body);
    assert.deepStrictEqual([body.readInt(), body.readSizedJson()], [requestId, {
      action: { title: "Don't show again" },
    }]);
    await disposed;
    assert.strictEqual((await process.readMessage()).kind, MessageKind.ShutDownProcess);
  });

  it("shuts down a replaced process after the timeouts", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { connection, processes } = createConnection({
      showMessageRequest: () => new Promise(() => {/* never answered */}),
    });

    connection.fileInfo({ uri: "file:///file.ts" }).catch(() => {/* ignore */});
    const process = processes[0];
    process.send(MessageKind.SuccessResponse, [(await process.readMessage()).id]); // initialize
    await process.readMessage(); // file info, which is never answered
    process.send(MessageKind.ShowMessageRequest, [JSON.stringify({ kind: "info", message: "Choose.", actions: [] })]);
    await nextTick();
    let isDisposed = false;
    const disposed = connection.disposeWhenIdle({ requests: 100, messageRequests: 1_000 })
      .then(() => isDisposed = true);
    t.mock.timers.tick(100);
    await nextTick();
    assert.strictEqual(isDisposed, false);
    t.mock.timers.tick(900);
    await disposed;
    assert.strictEqual((await process.readMessage()).kind, MessageKind.ShutDownProcess);
  });

  it("shuts down the process when disposed", async () => {
    const { connection, processes } = createConnection();

    connection.fileInfo({ uri: "file:///file.ts" }).catch(() => {/* ignore */});
    const process = processes[0];
    await process.readMessage(); // initialize
    await process.readMessage(); // file info
    connection.dispose();
    const shutDown = await process.readMessage();
    assert.strictEqual(shutDown.kind, MessageKind.ShutDownProcess);
    process.send(MessageKind.SuccessResponse, [shutDown.id]);
    await nextTick();
    assert.strictEqual(process.killCount, 1);
    // the process isn't started again
    await assert.rejects(connection.fileInfo({ uri: "file:///file.ts" }), /not running/);
    assert.strictEqual(processes.length, 1);
  });
});

const INITIALIZE_DATA = { clientInfo: { name: "test" }, settings: { workspaceFolders: ["/project"] } };

/** Starts the process with a request that's answered by `respondToStart`. */
function startProcess(connection: EditorServiceConnection, processes: FakeProcess[]) {
  connection.fileInfo({ uri: "file:///file.ts" }).catch(() => {/* ignore */});
  return processes[processes.length - 1];
}

/** Responds to the initialize message and the request that started the process. */
async function respondToStart(process: FakeProcess) {
  process.send(MessageKind.SuccessResponse, [(await process.readMessage()).id]);
  const request = await process.readMessage();
  process.send(MessageKind.FileInfoResponse, [request.id, JSON.stringify({ configFile: null, canFormat: false })]);
  await nextTick();
}

function createConnection(options: {
  showMessage?: (data: ShowMessageData) => void;
  showMessageRequest?: (data: ShowMessageRequestData) => Promise<MessageAction | undefined>;
  onConfigDiagnostics?: (data: ConfigDiagnosticsData) => void;
  onConfigChanged?: (data: ConfigChangedData) => void;
} = {}) {
  const processes: FakeProcess[] = [];
  const logs: [string, string][] = [];
  const progress: { title: string; reports: (number | undefined)[]; ended: boolean }[] = [];
  const connection = new EditorServiceConnection({
    spawn: () => {
      const process = new FakeProcess();
      processes.push(process);
      return process as unknown as EditorServiceProcess;
    },
    getInitializeData: () => INITIALIZE_DATA,
    showMessage: options.showMessage ?? (() => {}),
    showMessageRequest: options.showMessageRequest ?? (async () => undefined),
    showProgress(title, percentage) {
      const item = { title, reports: [percentage], ended: false };
      progress.push(item);
      return {
        report: percentage => item.reports.push(percentage),
        end: () => item.ended = true,
      };
    },
    onConfigDiagnostics: options.onConfigDiagnostics ?? (() => {}),
    onConfigChanged: options.onConfigChanged ?? (() => {}),
    logger: {
      log() {},
      logDebug: message => logs.push(["debug", message]),
      logInfo: message => logs.push(["info", message]),
      logWarn: message => logs.push(["warn", message]),
      logError: message => logs.push(["error", message]),
    },
  });
  return { connection, processes, logs, progress };
}

/** A process of the editor service that the test sends the messages of. */
class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly #decoder = new MessageDecoder();
  readonly #messages: RawMessage[] = [];
  readonly #waiters: ((message: RawMessage) => void)[] = [];
  #lastMessageId = 1000;
  killCount = 0;

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const message of this.#decoder.push(chunk)) {
        const waiter = this.#waiters.shift();
        if (waiter != null) {
          waiter(message);
        } else {
          this.#messages.push(message);
        }
      }
    });
  }

  kill() {
    this.killCount++;
    return true;
  }

  /** Gets the next message that the connection sent. */
  readMessage() {
    const message = this.#messages.shift();
    if (message != null) {
      return Promise.resolve(message);
    }
    return new Promise<RawMessage>(resolve => this.#waiters.push(resolve));
  }

  /** Sends a message to the connection and returns its id. */
  send(kind: MessageKind, parts: (number | string)[]) {
    const id = ++this.#lastMessageId;
    this.stdout.write(encodeMessage(id, kind, parts));
    return id;
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
