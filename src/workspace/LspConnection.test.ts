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
import { combineIsOnAnotherMachine, FileChangeType, LspConnection, type ServerProcess } from "./LspConnection";
import type {
  ClientInitializeParams,
  ConfigChangedParams,
  ConfigFileInfo,
  InitializeResult,
  MessageParams,
  PublishDiagnosticsParams,
} from "./messages";

describe("combineIsOnAnotherMachine", () => {
  it("is on another machine when one says so, and unknown when none has a result", () => {
    assert.strictEqual(combineIsOnAnotherMachine([false, true, undefined]), true);
    assert.strictEqual(combineIsOnAnotherMachine([undefined, false]), false);
    assert.strictEqual(combineIsOnAnotherMachine([undefined]), undefined);
    assert.strictEqual(combineIsOnAnotherMachine([]), undefined);
  });
});

describe("LspConnection", () => {
  it("initializes the server before sending a request", async () => {
    const { connection, processes } = createConnection();

    const fileInfo = connection.fileInfo({ textDocument: { uri: "file:///file.ts" } });
    const process = processes[0];
    const initialize = await process.nextMessage();
    assert.strictEqual(initialize.method, "initialize");
    // the session id identifies the session to dprint, which keeps what the user decided when it's started again
    const sessionId = initialize.params.capabilities.experimental.dprint.sessionId;
    assert.match(sessionId, /^[0-9a-f-]{36}$/);
    assert.deepStrictEqual(initialize.params, {
      ...INITIALIZE_PARAMS,
      capabilities: { experimental: { dprint: { versions: [1], sessionId } }, window: { workDoneProgress: true } },
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
    request.respond({ configFile: null, result });
    // the result is with the config file that was used
    assert.deepStrictEqual(await format, { configFile: null, ...result });

    const notFormatted = connection.format(
      { textDocument: { uri: "file:///file.ts" }, text: "text" },
      new FakeCancellationToken(),
    );
    const notFormattedResult = { kind: "notFormatted", reason: "notMatched", message: "Not matched." };
    const configFile = { uri: "file:///dprint.json", dirUri: "file:///", kind: "local", inWorkspace: true };
    (await process.nextRequest("dprint/format")).respond({ configFile, result: notFormattedResult });
    assert.deepStrictEqual(await notFormatted, { configFile, ...notFormattedResult });
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

    const configInfo = connection.configInfo({ configFile: { uri: "file:///dprint.json" }, globalConfig: "never" });
    const process = processes[0];
    const configInfoRequest = await process.nextRequest("dprint/configInfo");
    assert.deepStrictEqual(configInfoRequest.params, {
      configFile: { uri: "file:///dprint.json" },
      globalConfig: "never",
    });
    const configInfoResult = {
      configFile: null,
      plugins: null,
      filePatterns: [],
      otherFiles: [],
      status: { kind: "ready" },
    };
    configInfoRequest.respond(configInfoResult);
    assert.deepStrictEqual(await configInfo, configInfoResult);

    const configSchema = connection.configSchema({ configFile: { uri: "file:///dprint.json" } });
    (await process.nextRequest("dprint/configSchema")).respond({ schema: { type: "object" } });
    assert.deepStrictEqual(await configSchema, { schema: { type: "object" } });

    const approve = connection.approve({ id: "id", decision: "alwaysAllow" });
    const approveRequest = await process.nextRequest("dprint/approve");
    assert.deepStrictEqual(approveRequest.params, { id: "id", decision: "alwaysAllow" });
    approveRequest.respond({ approvals: [] });
    assert.deepStrictEqual(await approve, { approvals: [] });
  });

  it("keeps whether the latest configInfo or fileInfo result of a config file says it's on another machine", async () => {
    const { connection, processes } = createConnection();
    assert.strictEqual(connection.isConfigFileOnAnotherMachine("file:///a/dprint.json"), undefined);

    const configInfo = connection.configInfo({ configFile: { uri: "file:///a/dprint.json" } });
    const process = processes[0];
    (await process.nextRequest("dprint/configInfo")).respond(
      configInfoResult(configFile("file:///a/dprint.json", false)),
    );
    await configInfo;
    assert.strictEqual(connection.isConfigFileOnAnotherMachine("file:///a/dprint.json"), false);

    // a fileInfo result is the server's view of it too
    const fileInfo = connection.fileInfo({ textDocument: { uri: "file:///a/file.ts" } });
    (await process.nextRequest("dprint/fileInfo")).respond({
      configFile: configFile("file:///a/dprint.json", true),
      plugins: [],
      status: { kind: "ready" },
    });
    await fileInfo;
    assert.strictEqual(connection.isConfigFileOnAnotherMachine("file:///a/dprint.json"), true);
  });

  it("forgets the latest result of a config file once configChanged names it, or no config file", async () => {
    const { connection, processes } = createConnection();
    const getConfigInfo = async (uri: string) => {
      const configInfo = connection.configInfo({ configFile: { uri } });
      (await processes[0].nextRequest("dprint/configInfo")).respond(configInfoResult(configFile(uri, false)));
      await configInfo;
    };
    await getConfigInfo("file:///a/dprint.json");
    await getConfigInfo("file:///b/dprint.json");

    const process = processes[0];
    // not when only the schema changed
    process.peer.sendNotification("dprint/configChanged", {
      configFile: { uri: "file:///a/dprint.json" },
      schemaOnly: true,
    });
    await nextTick();
    assert.strictEqual(connection.isConfigFileOnAnotherMachine("file:///a/dprint.json"), false);
    process.peer.sendNotification("dprint/configChanged", { configFile: { uri: "file:///a/dprint.json" } });
    await waitUntil(() => connection.isConfigFileOnAnotherMachine("file:///a/dprint.json") == null);
    assert.strictEqual(connection.isConfigFileOnAnotherMachine("file:///a/dprint.json"), undefined);
    assert.strictEqual(connection.isConfigFileOnAnotherMachine("file:///b/dprint.json"), false);
    process.peer.sendNotification("dprint/configChanged", {});
    await waitUntil(() => connection.isConfigFileOnAnotherMachine("file:///b/dprint.json") == null);
    assert.strictEqual(connection.isConfigFileOnAnotherMachine("file:///b/dprint.json"), undefined);
  });

  it("doesn't keep the result of a request that was sent before configChanged", async () => {
    // ex. it said it isn't on another machine right before it became a symlink to a share
    const { connection, processes } = createConnection();
    const configInfo = connection.configInfo({ configFile: { uri: "file:///a/dprint.json" } });
    const process = processes[0];
    const request = await process.nextRequest("dprint/configInfo");
    process.peer.sendNotification("dprint/configChanged", { configFile: { uri: "file:///a/dprint.json" } });
    await nextTick();
    request.respond(configInfoResult(configFile("file:///a/dprint.json", false)));
    await configInfo;
    assert.strictEqual(connection.isConfigFileOnAnotherMachine("file:///a/dprint.json"), undefined);
  });

  it("forgets the latest results when the server is started again", async () => {
    const { connection, processes } = createConnection();
    const configInfo = connection.configInfo({ configFile: { uri: "file:///a/dprint.json" } });
    (await processes[0].nextRequest("dprint/configInfo")).respond(
      configInfoResult(configFile("file:///a/dprint.json", false)),
    );
    await configInfo;
    processes[0].exit();
    connection.fileInfo({ textDocument: { uri: "file:///a/file.ts" } }).catch(() => {/* ignore */});
    await waitUntil(() => processes.length === 2);
    assert.strictEqual(connection.isConfigFileOnAnotherMachine("file:///a/dprint.json"), undefined);
  });

  it("rejects a request with an error response", async () => {
    const { connection, processes } = createConnection();

    const configInfo = connection.configInfo({ configFile: { uri: "file:///dprint.json" } });
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
    processes[0].pid = undefined;
    processes[0].emit("error", new Error("spawn dprint ENOENT"));
    await assert.rejects(fileInfo, /failed to start\. Error: spawn dprint ENOENT/);
    assert.strictEqual(connection.pendingRequestCount, 0);

    // it's started again on the next request
    connection.fileInfo({ textDocument: { uri: "file:///file.ts" } }).catch(() => {/* ignore */});
    assert.strictEqual(processes.length, 2);
  });

  it("kills the process when its output can't be read", async () => {
    const { connection, processes } = createConnection();

    const configInfo = connection.configInfo({ configFile: { uri: "file:///dprint.json" } });
    const process = processes[0];
    await process.nextRequest("dprint/configInfo");
    process.stdout.write("Content-Length: abc\r\n\r\n");
    await assert.rejects(configInfo, /stopped while the request was in progress/);
    assert.strictEqual(process.killCount, 1);
    assert.strictEqual(connection.pendingRequestCount, 0);
    process.exit();
  });

  it("starts the server again only once the one that was killed exited", async () => {
    const { connection, processes } = createConnection();

    const process = await killWithUnreadableOutput(connection, processes);

    const fileInfo = connection.fileInfo({ textDocument: { uri: "file:///file.ts" } });
    await nextTick();
    // the new one has the same session id, whose lock the one that was killed may still hold
    assert.strictEqual(processes.length, 1);
    process.exit();
    await waitUntil(() => processes.length === 2);
    assert.strictEqual(processes.length, 2);
    const result = { configFile: null, plugins: [], status: { kind: "ready" } };
    (await processes[1].nextRequest("dprint/fileInfo")).respond(result);
    assert.deepStrictEqual(await fileInfo, result);
  });

  it("kills the process with SIGKILL when it doesn't exit after it was killed", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { connection, processes, logs } = createConnection();

    const process = await killWithUnreadableOutput(connection, processes);
    connection.fileInfo({ textDocument: { uri: "file:///file.ts" } }).catch(() => {/* ignore */});

    t.mock.timers.tick(999);
    await nextTick();
    assert.deepStrictEqual(process.killSignals, [undefined]);
    t.mock.timers.tick(1);
    await nextTick();
    assert.deepStrictEqual(process.killSignals, [undefined, "SIGKILL"]);
    assert.strictEqual(processes.length, 1);
    // another is started when that doesn't work either
    t.mock.timers.tick(1_000);
    await waitUntil(() => processes.length === 2);
    assert.strictEqual(processes.length, 2);
    assert.ok(logs.some(([level, message]) => level === "warn" && /didn't exit after it was killed/.test(message)));
  });

  it("doesn't start the server again while the one that couldn't be killed is running", async () => {
    const { connection, processes } = createConnection();

    const configInfo = connection.configInfo({ configFile: { uri: "file:///dprint.json" } });
    const process = processes[0];
    // ex. killing it fails with EPERM, which node emits from within `kill()`
    process.killError = new Error("kill EPERM");
    await process.nextRequest("dprint/configInfo");
    process.stdout.write("Content-Length: abc\r\n\r\n");
    // its requests aren't rejected as if it failed to start
    await assert.rejects(configInfo, /stopped while the request was in progress/);
    assert.strictEqual(process.killCount, 1);
    connection.fileInfo({ textDocument: { uri: "file:///file.ts" } }).catch(() => {/* ignore */});
    await nextTick();
    assert.strictEqual(processes.length, 1);
    process.exit();
    await waitUntil(() => processes.length === 2);
    assert.strictEqual(processes.length, 2);
  });

  it("kills the processes the server's process started, and starts another once that's done", async () => {
    // ex. the dprint that the shell of an npm `dprint.cmd` started
    const kills: { process: ServerProcess; signal: NodeJS.Signals | undefined }[] = [];
    let finishKill!: () => void;
    const { connection, processes } = createConnection({
      killProcess: (process, signal) => {
        kills.push({ process, signal });
        return new Promise(resolve => finishKill = resolve);
      },
    });

    const process = await killWithUnreadableOutput(connection, processes);
    assert.strictEqual(kills.length, 1);
    assert.strictEqual(kills[0].process, process as unknown as ServerProcess);
    assert.strictEqual(kills[0].signal, undefined);
    connection.fileInfo({ textDocument: { uri: "file:///file.ts" } }).catch(() => {/* ignore */});
    process.exit();
    await nextTick();
    // the process it started may still hold the session's lock
    assert.strictEqual(processes.length, 1);
    finishKill();
    await waitUntil(() => processes.length === 2);
    assert.strictEqual(processes.length, 2);
  });

  it("doesn't kill the process again once it exited", async t => {
    // ex. taskkill was slow to start, and the pid may be another process's once it exited
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const signals: (NodeJS.Signals | undefined)[] = [];
    const { connection, processes, logs } = createConnection({
      killProcess: (_process, signal) => {
        signals.push(signal);
        return new Promise(() => {/* never finishes */});
      },
    });

    const process = await killWithUnreadableOutput(connection, processes);
    connection.fileInfo({ textDocument: { uri: "file:///file.ts" } }).catch(() => {/* ignore */});
    process.exit();
    await nextTick();
    t.mock.timers.tick(1_000);
    await nextTick();
    assert.deepStrictEqual(signals, [undefined]);
    // and another is started after the timeout
    t.mock.timers.tick(1_000);
    await waitUntil(() => processes.length === 2);
    assert.strictEqual(processes.length, 2);
    assert.deepStrictEqual(signals, [undefined]);
    // what didn't exit is what it started
    assert.ok(
      logs.some(([level, message]) => level === "warn" && /processes the dprint language server started/.test(message)),
    );
  });

  it("doesn't kill the process again with SIGKILL itself when it's given how to kill it", async t => {
    // `killProcess` escalates the kill itself (ex. the process tree with SIGKILL)
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const signals: (NodeJS.Signals | undefined)[] = [];
    const { connection, processes } = createConnection({
      killProcess: (_process, signal) => {
        signals.push(signal);
        return new Promise(() => {/* never finishes */});
      },
    });

    await killWithUnreadableOutput(connection, processes);
    connection.fileInfo({ textDocument: { uri: "file:///file.ts" } }).catch(() => {/* ignore */});
    // the process never exits
    t.mock.timers.tick(1_000);
    await nextTick();
    t.mock.timers.tick(1_000);
    await waitUntil(() => processes.length === 2);
    assert.strictEqual(processes.length, 2);
    assert.deepStrictEqual(signals, [undefined]);
  });

  it("doesn't start the server again when disposed while the one that was killed exits", async () => {
    for (const dispose of [(c: LspConnection) => c.dispose(), (c: LspConnection) => c.disposeWhenIdle()]) {
      const { connection, processes } = createConnection();

      const process = await killWithUnreadableOutput(connection, processes);
      const fileInfo = connection.fileInfo({ textDocument: { uri: "file:///file.ts" } });
      await nextTick();
      dispose(connection);
      process.exit();
      await assert.rejects(fileInfo, /not running/);
      assert.strictEqual(processes.length, 1);
    }
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
  capabilities: { experimental: { dprint: { version: 1, versions: [1] } } },
  serverInfo: { name: "dprint", version: "0.65.0" },
};

function createConnection(options: {
  /** The result of the initialize request, which the test responds with itself when null. */
  initializeResult?: InitializeResult | null;
  showMessage?: (params: MessageParams) => void;
  onDiagnostics?: (params: PublishDiagnosticsParams) => void;
  onConfigChanged?: (params: ConfigChangedParams) => void;
  killProcess?: (process: ServerProcess, signal: NodeJS.Signals | undefined) => Promise<void> | void;
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
    killProcess: options.killProcess,
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
  /** The signals it was killed with, which is undefined for the default one. */
  readonly killSignals: (NodeJS.Signals | undefined)[] = [];
  /** The process id, which is undefined when it failed to spawn. */
  pid: number | undefined = 1234;
  /** The error that killing it emits from within `kill()` like node does (ex. EPERM), which keeps it running. */
  killError: Error | undefined;

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

  get killCount() {
    return this.killSignals.length;
  }

  kill(signal?: NodeJS.Signals) {
    this.killSignals.push(signal);
    if (this.killError != null) {
      this.emit("error", this.killError);
      return false;
    }
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

/** Kills the process a request starts by having it write what can't be read, which resolves with the process. */
async function killWithUnreadableOutput(connection: LspConnection, processes: FakeProcess[]) {
  const configInfo = connection.configInfo({ configFile: { uri: "file:///dprint.json" } });
  const process = processes[processes.length - 1];
  await process.nextRequest("dprint/configInfo");
  process.stdout.write("Content-Length: abc\r\n\r\n");
  await assert.rejects(configInfo, /stopped while the request was in progress/);
  return process;
}

function configFile(uri: string, onAnotherMachine: boolean): ConfigFileInfo {
  return {
    uri,
    dirUri: uri.slice(0, uri.lastIndexOf("/")),
    kind: "local",
    inWorkspace: true,
    ...(onAnotherMachine ? { onAnotherMachine } : {}),
  };
}

function configInfoResult(configFile: ConfigFileInfo) {
  return { configFile, plugins: [], filePatterns: [], otherFiles: [], watchUris: [], status: { kind: "ready" } };
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
