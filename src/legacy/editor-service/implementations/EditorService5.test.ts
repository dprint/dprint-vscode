import * as assert from "node:assert";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, it } from "node:test";
import type * as vscode from "vscode";
import type { DprintExecutable } from "../../../executable/DprintExecutable";
import type { Logger } from "../../../logger";
import { EditorService5 } from "./EditorService5";

describe("EditorService5", () => {
  let service: EditorService5 | undefined;

  afterEach(async () => {
    // stops the read loop, which otherwise keeps restarting the process
    service?.killAndDispose();
    service = undefined;
    await nextTick();
  });

  it("resolves a request with the response from the process", async () => {
    const executable = new FakeExecutable();
    service = new EditorService5(logger, executable.asExecutable());

    const canFormat = service.canFormat("/file.ts");
    const canFormatMessage = await executable.lastProcess.readMessage();
    assert.strictEqual(canFormatMessage.kind, MessageKind.CanFormat);
    executable.lastProcess.respond(MessageKind.CanFormatResponse, [canFormatMessage.id, 1]);
    assert.strictEqual(await canFormat, true);

    const formatText = service.formatText("/file.ts", "text", undefined, new FakeCancellationToken());
    const formatMessage = await executable.lastProcess.readMessage();
    assert.strictEqual(formatMessage.kind, MessageKind.FormatFile);
    executable.lastProcess.respond(MessageKind.FormatFileResponse, [formatMessage.id, 1, "formatted"]);
    assert.strictEqual(await formatText, "formatted");
    assert.strictEqual(executable.processes.length, 1);
    assert.strictEqual(service.pendingMessageCount, 0);
  });

  it("rejects a request when writing it to the process fails", async () => {
    const executable = new FakeExecutable();
    executable.stdinWriteError = new Error("write EPIPE");
    service = new EditorService5(logger, executable.asExecutable());

    await assert.rejects(service.canFormat("/file.ts"), /write EPIPE/);
    // the stream is destroyed after the failed write
    const token = new FakeCancellationToken();
    await assert.rejects(service.formatText("/file.ts", "text", undefined, token), /stream was destroyed/);
    assert.strictEqual(service.pendingMessageCount, 0);
    assert.strictEqual(token.listenerCount, 0);
  });

  it("rejects a request when the process is not running", async () => {
    const executable = new FakeExecutable();
    service = new EditorService5(logger, executable.asExecutable());
    // the process is not started for a request once disposing
    service.killAndDispose();
    await nextTick();

    await assert.rejects(service.canFormat("/file.ts"), /Editor service is not running/);
    await assert.rejects(
      service.formatText("/file.ts", "text", undefined, new FakeCancellationToken()),
      /Editor service is not running/,
    );
    assert.strictEqual(service.pendingMessageCount, 0);
  });

  it("rejects the pending requests when the process fails to spawn and recovers on the next request", async () => {
    const executable = new FakeExecutable();
    service = new EditorService5(logger, executable.asExecutable());

    const failedCanFormat = service.canFormat("/file.ts");
    await executable.lastProcess.readMessage();
    // node emits only an "error" event (no "exit" event) when the executable or the cwd doesn't exist
    executable.lastProcess.emit("error", new Error("spawn dprint ENOENT"));
    await assert.rejects(failedCanFormat, /exited while the message was in progress/);
    assert.strictEqual(service.pendingMessageCount, 0);
    await nextTick();

    const canFormat = service.canFormat("/file.ts");
    assert.strictEqual(executable.processes.length, 2);
    const message = await executable.lastProcess.readMessage();
    executable.lastProcess.respond(MessageKind.CanFormatResponse, [message.id, 1]);
    assert.strictEqual(await canFormat, true);
  });

  it("leaves starting the process to the next request after it fails to spawn", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const executable = new FakeExecutable();
    const errors: string[] = [];
    service = new EditorService5(
      { ...logger, logError: (message: string) => errors.push(message) } as unknown as Logger,
      executable.asExecutable(),
    );

    try {
      executable.lastProcess.emit("error", new Error("spawn dprint ENOENT"));
      await nextTick();
      // the delay the read loop waits before starting the process again after a failed read
      t.mock.timers.tick(500);
      await nextTick();

      assert.strictEqual(executable.processes.length, 1);
      assert.deepStrictEqual(errors, ["Editor service process error:"]);

      // each request tries once
      const failedCanFormat = service.canFormat("/file.ts");
      assert.strictEqual(executable.processes.length, 2);
      executable.lastProcess.emit("error", new Error("spawn dprint ENOENT"));
      await assert.rejects(failedCanFormat, /exited while the message was in progress/);
      t.mock.timers.tick(500);
      await nextTick();

      assert.strictEqual(executable.processes.length, 2);
      assert.deepStrictEqual(errors, ["Editor service process error:", "Editor service process error:"]);
    } finally {
      t.mock.timers.reset();
    }
  });

  it("starts the process again after it exits", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const executable = new FakeExecutable();
    service = new EditorService5(logger, executable.asExecutable());

    try {
      executable.lastProcess.exit();
      await nextTick();
      await nextTick();
      assert.strictEqual(executable.processes.length, 1);
      t.mock.timers.tick(500);
      await nextTick();

      assert.strictEqual(executable.processes.length, 2);
    } finally {
      t.mock.timers.reset();
    }
  });

  it("ignores the events of a killed process once a new process is running", async () => {
    const executable = new FakeExecutable();
    executable.exitsWhenKilled = false;
    service = new EditorService5(logger, executable.asExecutable());
    const killedProcess = executable.lastProcess;

    const failedCanFormat = assert.rejects(service.canFormat("/file.ts"), /exited while the message was in progress/);
    const failedMessage = await killedProcess.readMessage();
    // the read loop kills the process when a message doesn't end with the success bytes
    killedProcess.stdout.write(Buffer.concat([
      uint32(1),
      uint32(MessageKind.CanFormatResponse),
      uint32(8),
      uint32(failedMessage.id),
      uint32(1),
      Buffer.alloc(4, 0),
    ]));
    await nextTick();
    assert.strictEqual(killedProcess.killCount, 1);
    // the request is rejected without waiting on the exit of the killed process
    assert.strictEqual(service.pendingMessageCount, 0);
    await failedCanFormat;

    const canFormat = service.canFormat("/file.ts");
    assert.strictEqual(executable.processes.length, 2);
    const message = await executable.lastProcess.readMessage();
    // output of the killed process is not read as output of the new process
    killedProcess.respond(MessageKind.CanFormatResponse, [message.id, 0]);
    killedProcess.exit();
    await nextTick();
    await nextTick();

    assert.strictEqual(service.pendingMessageCount, 1);
    executable.lastProcess.respond(MessageKind.CanFormatResponse, [message.id, 1]);
    assert.strictEqual(await canFormat, true);
    assert.strictEqual(executable.processes.length, 2);
    assert.strictEqual(executable.lastProcess.killCount, 0);
  });

  it("rejects a request when the executable does not exist", async () => {
    const missingExecutable = {
      spawnEditorService: () => spawn(path.join(__dirname, "does-not-exist"), [], { stdio: ["pipe", "pipe", "pipe"] }),
    } as unknown as DprintExecutable;
    service = new EditorService5(logger, missingExecutable);

    await assert.rejects(service.canFormat("/file.ts"));
    assert.strictEqual(service.pendingMessageCount, 0);
  });

  it("does not throw when the process's stdin emits an error", () => {
    const executable = new FakeExecutable();
    service = new EditorService5(logger, executable.asExecutable());

    // an "error" event without a listener is thrown by the emitter
    executable.lastProcess.stdin.emit("error", new Error("write EPIPE"));
  });

  it("does not keep a cancelled format request pending", async () => {
    const executable = new FakeExecutable();
    service = new EditorService5(logger, executable.asExecutable());
    const token = new FakeCancellationToken();

    const formatText = service.formatText("/file.ts", "text", undefined, token);
    const formatMessage = await executable.lastProcess.readMessage();
    assert.strictEqual(service.pendingMessageCount, 1);
    token.cancel();

    // the process sends no response for a cancelled format
    assert.strictEqual(await formatText, undefined);
    assert.strictEqual(service.pendingMessageCount, 0);
    assert.strictEqual(token.listenerCount, 0);
    const cancelMessage = await executable.lastProcess.readMessage();
    assert.strictEqual(cancelMessage.kind, MessageKind.CancelFormat);
    assert.strictEqual(cancelMessage.body.readUInt32BE(0), formatMessage.id);
  });

  it("stops listening for cancellation once a format request finishes", async () => {
    const executable = new FakeExecutable();
    service = new EditorService5(logger, executable.asExecutable());
    const token = new FakeCancellationToken();

    const formatText = service.formatText("/file.ts", "text", undefined, token);
    const formatMessage = await executable.lastProcess.readMessage();
    executable.lastProcess.respond(MessageKind.FormatFileResponse, [formatMessage.id, 0]);

    assert.strictEqual(await formatText, undefined);
    assert.strictEqual(token.listenerCount, 0);
  });

  it("disposes without an unhandled rejection when the process is not running", async () => {
    const executable = new FakeExecutable();
    service = new EditorService5(logger, executable.asExecutable());
    executable.lastProcess.emit("error", new Error("spawn dprint ENOENT"));
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (err: unknown) => unhandledRejections.push(err);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      service.killAndDispose();
      await nextTick();

      assert.deepStrictEqual(unhandledRejections, []);
      assert.strictEqual(service.pendingMessageCount, 0);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});

// the message kinds of the editor service's wire protocol
enum MessageKind {
  SuccessResponse = 0,
  ShutDownProcess = 2,
  CanFormat = 4,
  CanFormatResponse = 5,
  FormatFile = 6,
  FormatFileResponse = 7,
  CancelFormat = 8,
}

interface ReceivedMessage {
  id: number;
  kind: number;
  body: Buffer;
}

class FakeExecutable {
  readonly processes: FakeEditorProcess[] = [];
  /** Error to fail every write to the stdin of the spawned processes with. */
  stdinWriteError: Error | undefined;
  /** Whether the spawned processes exit when killed, rather than only once `exit()` is called. */
  exitsWhenKilled = true;

  get lastProcess() {
    const process = this.processes[this.processes.length - 1];
    assert.ok(process != null, "expected a process to have been spawned");
    return process;
  }

  asExecutable() {
    return this as unknown as DprintExecutable;
  }

  spawnEditorService() {
    const process = new FakeEditorProcess(this.stdinWriteError, this.exitsWhenKilled);
    this.processes.push(process);
    return process;
  }
}

/** Stands in for the `dprint editor-service` child process. */
class FakeEditorProcess extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  #received = Buffer.alloc(0);
  #messages: ReceivedMessage[] = [];
  #waiters: ((message: ReceivedMessage) => void)[] = [];
  #nextMessageId = 0;
  #hasExited = false;
  #exitsWhenKilled: boolean;
  killCount = 0;

  constructor(stdinWriteError: Error | undefined, exitsWhenKilled: boolean) {
    super();
    this.#exitsWhenKilled = exitsWhenKilled;
    if (stdinWriteError == null) {
      this.stdin = new PassThrough();
      this.stdin.on("data", (data: Buffer) => this.#onStdinData(data));
    } else {
      this.stdin = new Writable({
        write: (_chunk, _encoding, callback) => callback(stdinWriteError),
      });
    }
  }

  kill() {
    this.killCount++;
    if (this.#exitsWhenKilled) {
      this.exit();
    }
    return true;
  }

  /** Emits the "exit" event some time after this is called, as a process does when asked to exit. */
  exit() {
    if (this.#hasExited) {
      return;
    }
    this.#hasExited = true;
    setImmediate(() => this.emit("exit", 0, null));
  }

  /** Gets the next message the extension sent to the process. */
  readMessage() {
    const message = this.#messages.shift();
    if (message != null) {
      return Promise.resolve(message);
    }
    return new Promise<ReceivedMessage>(resolve => this.#waiters.push(resolve));
  }

  /** Sends a message to the extension. */
  respond(kind: MessageKind, parts: (number | string)[]) {
    const bodyParts = parts.map(part => {
      if (typeof part === "number") {
        return uint32(part);
      }
      const text = Buffer.from(part, "utf8");
      return Buffer.concat([uint32(text.byteLength), text]);
    });
    const body = Buffer.concat(bodyParts);
    this.stdout.write(Buffer.concat([
      uint32(++this.#nextMessageId),
      uint32(kind),
      uint32(body.byteLength),
      body,
      Buffer.alloc(4, 255),
    ]));
  }

  #onStdinData(data: Buffer) {
    this.#received = Buffer.concat([this.#received, data]);
    // a message is the id, kind and body length followed by the body and the four success bytes
    while (this.#received.byteLength >= 12) {
      const bodyLength = this.#received.readUInt32BE(8);
      const messageLength = 12 + bodyLength + 4;
      if (this.#received.byteLength < messageLength) {
        break;
      }
      const message: ReceivedMessage = {
        id: this.#received.readUInt32BE(0),
        kind: this.#received.readUInt32BE(4),
        body: this.#received.subarray(12, 12 + bodyLength),
      };
      this.#received = this.#received.subarray(messageLength);
      this.#onMessage(message);
    }
  }

  #onMessage(message: ReceivedMessage) {
    if (message.kind === MessageKind.ShutDownProcess) {
      this.respond(MessageKind.SuccessResponse, [message.id]);
      this.exit();
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter != null) {
      waiter(message);
    } else {
      this.#messages.push(message);
    }
  }
}

class FakeCancellationToken implements vscode.CancellationToken {
  #listeners = new Set<() => void>();
  isCancellationRequested = false;

  get listenerCount() {
    return this.#listeners.size;
  }

  onCancellationRequested = (listener: (e: any) => any) => {
    const callback = () => listener(undefined);
    this.#listeners.add(callback);
    return { dispose: () => this.#listeners.delete(callback) };
  };

  cancel() {
    this.isCancellationRequested = true;
    for (const listener of Array.from(this.#listeners)) {
      listener();
    }
  }
}

const logger = {
  log() {},
  logDebug() {},
  logError() {},
} as unknown as Logger;

function uint32(value: number) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value);
  return buf;
}

/** Waits for the pending promise callbacks and immediates to run. */
function nextTick() {
  return new Promise<void>(resolve => setImmediate(resolve));
}
