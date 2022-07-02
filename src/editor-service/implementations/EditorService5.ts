import { TextDecoder, TextEncoder } from "util";
import * as vscode from "vscode";
import { DprintExecutable } from "../../executable";
import { Logger } from "../../logger";
import { EditorProcess } from "../common";
import { EditorService } from "../EditorService";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class EditorService5 implements EditorService {
  private _process: EditorProcess;
  private _pendingMessages = new PendingMessages();
  private _currentMessageId = 0;
  private _logger: Logger;

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

  private async startReadingStdout() {
    while (true) {
      try {
        this._process.startProcessIfNotRunning();
        const messageId = await this._process.readInt();
        const messageKind = await this._process.readInt();
        const bodyLength = await this._process.readInt();

        const body = new BodyReader(await this._process.readBuffer(bodyLength));
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
        this._logger.logError("Read task failed:", err);
        this._process.kill();

        // wait a little bit before reading again (in case this gets caught in an infinite failure)
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    async function assertSuccessBytes(process: EditorProcess) {
      const buf = await process.readBuffer(4);
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

  kill() {
    // If graceful shutdown doesn't work soon enough
    // then kill the process
    const killTimeout = setTimeout(() => {
      this._process.kill();
    }, 1_000);

    // send a graceful shutdown signal
    this.gracefulClose().finally(() => {
      this._process.kill();
      clearTimeout(killTimeout);
    }).catch(() => {/* ignore */});
  }

  async canFormat(filePath: string) {
    const message = this.getMessageForKind(MessageKind.CanFormat);
    message.addPart(textEncoder.encode(filePath));
    const buf = message.build();
    this._process.startProcessIfNotRunning();
    return new Promise<boolean>(async (resolve, reject) => {
      this._pendingMessages.store(message.id, { resolve, reject });
      await this._process.writeBuffer(buf);
    });
  }

  formatText(filePath: string, fileText: string, token: vscode.CancellationToken) {
    const message = this.getMessageForKind(MessageKind.FormatFile);
    const encodedFileText = textEncoder.encode(fileText);
    message.addPart(textEncoder.encode(filePath));
    message.addPart(0); // start byte index (no range format support yet in the vscode plugin)
    message.addPart(encodedFileText.byteLength); // end byte index
    message.addPart(new Uint8Array(0)); // override config
    message.addPart(encodedFileText);
    const buf = message.build();
    this._process.startProcessIfNotRunning();
    return new Promise<string | undefined>(async (resolve, reject) => {
      const disposable = token.onCancellationRequested(() => {
        resolve(undefined);
        disposable.dispose();
        this.cancelFormat(message.id).catch(_err => {
          // ignore
        });
      });
      this._pendingMessages.store(message.id, {
        resolve: (value) => {
          resolve(value);
          disposable.dispose();
        },
        reject: (err) => {
          reject(err);
          disposable.dispose();
        },
      });
      await this._process.writeBuffer(buf);
    });
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
    const buf = message.build();
    return new Promise<void>(async (resolve, reject) => {
      this._pendingMessages.store(message.id, { resolve, reject });
      await this._process.writeBuffer(buf);
    });
  }

  private getMessageForKind(kind: MessageKind) {
    return new Message(++this._currentMessageId, kind);
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
