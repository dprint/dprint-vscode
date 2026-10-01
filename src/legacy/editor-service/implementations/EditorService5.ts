import { Buffer } from "node:buffer";
import { TextDecoder, TextEncoder } from "node:util";
import type * as vscode from "vscode";
import type { DprintExecutable } from "../../../executable/DprintExecutable";
import type { Logger } from "../../../logger";
import type { ByteRange } from "../byteRange";
import { EditorProcess } from "../common";
import type { EditorService } from "../EditorService";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class EditorService5 implements EditorService {
  private _process: EditorProcess;
  private _pendingMessages = new PendingMessages();
  private _currentMessageId = 0;
  private _logger: Logger;
  private _disposed = false;
  private _disposing = false;

  constructor(logger: Logger, dprintExecutable: DprintExecutable) {
    this._logger = logger;
    this._process = new EditorProcess(logger, dprintExecutable);
    this._process.onExit(() => {
      for (const message of this._pendingMessages.drain()) {
        message.reject(new Error("dprint's process exited while the message was in progress."));
      }
    });

    this.startReadingStdout();
  }

  /** The number of requests that are waiting on a response from the process. */
  get pendingMessageCount() {
    return this._pendingMessages.size;
  }

  private async startReadingStdout() {
    while (!this._disposed) {
      try {
        this.startProcessIfNotRunning();
        const messageId = await this._process.readInt();
        const messageKind = await this._process.readInt();
        const bodyLength = await this._process.readInt();

        const body = new BodyReader(await this._process.readBufferExact(bodyLength));
        await assertSuccessBytes(this._process);

        switch (messageKind) {
          case MessageKind.SuccessResponse:
            {
              const respondingMessageId = body.readInt();
              this._pendingMessages.take(respondingMessageId)?.resolve(undefined);
            }
            break;
          case MessageKind.ErrorResponse:
            {
              const respondingMessageId = body.readInt();
              const errorMessage = body.readSizedString();
              this._pendingMessages.take(respondingMessageId)?.reject(new Error(errorMessage));
            }
            break;
          case MessageKind.Active:
            this.sendSuccess(messageId);
            break;
          case MessageKind.CanFormatResponse:
            {
              const respondingMessageId = body.readInt();
              const canFormat = body.readInt();
              this._pendingMessages.take(respondingMessageId)?.resolve(canFormat === 1);
            }
            break;
          case MessageKind.FormatFileResponse:
            {
              const respondingMessageId = body.readInt();
              const hadChange = body.readInt();
              const text = hadChange === 1 ? body.readSizedString() : undefined;
              this._pendingMessages.take(respondingMessageId)?.resolve(text);
            }
            break;
          default:
            this.sendError(messageId, `Can't respond to message kind: ${messageKind}`);
            break;
        }
      } catch (err) {
        if (this._disposed || this._disposing) {
          return;
        }
        this._logger.logError("Read task failed:", err);
        this._process.kill();

        // wait a little bit before reading again (in case this gets caught in an infinite failure)
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    async function assertSuccessBytes(process: EditorProcess) {
      const buf = await process.readBufferExact(4);
      if (buf.length !== 4) {
        throw new Error(`Expected success byte array with length 4, but had length ${buf.length}.`);
      }
      for (let i = 0; i < 4; i++) {
        if (buf[i] !== 255) {
          throw new Error(`Expected success bytes, but found: [${buf.join(", ")}]`);
        }
      }
    }
  }

  killAndDispose() {
    this._disposing = true;

    // If graceful shutdown doesn't work soon enough
    // then kill the process
    const killTimeout = setTimeout(() => {
      this._disposed = true;
      this._process.kill();
    }, 1_000);

    // send a graceful shutdown signal
    this.gracefulClose().finally(() => {
      this._disposed = true;
      this._process.kill();
      clearTimeout(killTimeout);
    }).catch(() => {/* ignore */});
  }

  canFormat(filePath: string) {
    const message = this.getMessageForKind(MessageKind.CanFormat);
    message.addPart(textEncoder.encode(filePath));
    this.startProcessIfNotRunning();
    return this.sendRequest<boolean>(message);
  }

  formatText(filePath: string, fileText: string, range: ByteRange | undefined, token: vscode.CancellationToken) {
    const message = this.getMessageForKind(MessageKind.FormatFile);
    const encodedFileText = textEncoder.encode(fileText);
    message.addPart(textEncoder.encode(filePath));
    message.addPart(range?.start ?? 0); // start byte index
    message.addPart(range?.end ?? encodedFileText.byteLength); // end byte index
    message.addPart(new Uint8Array(0)); // override config
    message.addPart(encodedFileText);
    this.startProcessIfNotRunning();
    const request = this.sendRequest<string | undefined>(message);
    const disposable = token.onCancellationRequested(() => {
      // the process doesn't respond to a cancelled format, so stop waiting on it here
      const pendingMessage = this._pendingMessages.take(message.id);
      if (pendingMessage == null) {
        return; // already finished
      }
      pendingMessage.resolve(undefined);
      this.cancelFormat(message.id).catch(_err => {
        // ignore
      });
    });
    return request.finally(() => disposable.dispose());
  }

  private async cancelFormat(messageId: number) {
    const message = this.getMessageForKind(MessageKind.CancelFormat);
    message.addPart(messageId);
    await this.sendResponse(message);
  }

  private async sendSuccess(messageId: number) {
    const message = this.getMessageForKind(MessageKind.SuccessResponse);
    message.addPart(messageId);
    await this.sendResponse(message);
  }

  private async sendError(messageId: number, errorMessage: string) {
    const message = this.getMessageForKind(MessageKind.ErrorResponse);
    message.addPart(messageId);
    message.addPart(textEncoder.encode(errorMessage));
    await this.sendResponse(message);
  }

  private async sendResponse(message: Message) {
    if (this._process.isRunning) {
      await this._process.writeBuffer(message.build());
    }
  }

  private gracefulClose() {
    const message = this.getMessageForKind(MessageKind.ShutDownProcess);
    return this.sendRequest<void>(message);
  }

  /** Sends the message, resolving with its response and rejecting when it could not be written. */
  private sendRequest<T>(message: Message) {
    const buf = message.build();
    return new Promise<T>((resolve, reject) => {
      this._pendingMessages.store(message.id, { resolve, reject });
      this.writeBuffer(buf).catch(err => {
        // no response will arrive for a message that was not sent
        this._pendingMessages.take(message.id)?.reject(err);
      });
    });
  }

  /** Writes to the process, rejecting instead of throwing when it's not running. */
  private async writeBuffer(buf: Buffer) {
    await this._process.writeBuffer(buf);
  }

  private getMessageForKind(kind: MessageKind) {
    return new Message(++this._currentMessageId, kind);
  }

  private startProcessIfNotRunning() {
    if (this._disposed || this._disposing) {
      return;
    }

    this._process.startProcessIfNotRunning();
  }
}

enum MessageKind {
  SuccessResponse = 0,
  ErrorResponse = 1,
  ShutDownProcess = 2,
  Active = 3,
  CanFormat = 4,
  CanFormatResponse = 5,
  FormatFile = 6,
  FormatFileResponse = 7,
  CancelFormat = 8,
}

interface PendingMessage {
  resolve: (value: any) => void;
  reject: (err: any) => void;
}

class PendingMessages {
  #pending = new Map<number, PendingMessage>();

  get size() {
    return this.#pending.size;
  }

  store(mesageId: number, pendingMessage: PendingMessage) {
    this.#pending.set(mesageId, pendingMessage);
  }

  take(messageId: number) {
    const message = this.#pending.get(messageId);
    if (message != null) {
      this.#pending.delete(messageId);
    }
    return message;
  }

  drain() {
    const pendingMessages = Array.from(this.#pending.values());
    this.#pending.clear();
    return pendingMessages;
  }
}

class BodyReader {
  #body: Buffer;
  #index = 0;

  constructor(body: Buffer) {
    this.#body = body;
    this.#index = 0;
  }

  readInt() {
    const val = this.#body.readUInt32BE(this.#index);
    this.#index += 4;
    return val;
  }

  readSizedString() {
    const length = this.readInt();
    const buf = this.#body.slice(this.#index, this.#index + length);
    this.#index += length;
    return textDecoder.decode(buf);
  }
}

class Message {
  private _parts: (Uint8Array | number)[] = [];

  constructor(private readonly messageId: number, private readonly kind: MessageKind) {
  }

  get id() {
    return this.messageId;
  }

  addPart(part: Uint8Array | number) {
    this._parts.push(part);
  }

  build(): Buffer {
    const bodyLength = this._parts.map(p => typeof p === "number" ? 4 : (p.byteLength + 4)).reduce((a, b) => a + b, 0);
    const byteLength = bodyLength + 4 * 4;
    const buf = Buffer.alloc(byteLength);
    buf.writeUInt32BE(this.messageId, 0);
    buf.writeUInt32BE(this.kind, 4);
    buf.writeUInt32BE(bodyLength, 8);
    let index = 12;
    for (const part of this._parts) {
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
    buf.fill(255, index, index + 4);
    index += 4;
    if (index != byteLength) {
      throw new Error(`Invalid index: ${index} (expected ${byteLength})`);
    }
    return buf;
  }
}
