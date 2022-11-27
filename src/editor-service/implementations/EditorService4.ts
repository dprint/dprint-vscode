import { TextDecoder, TextEncoder } from "util";
import * as vscode from "vscode";
import { DprintExecutable } from "../../executable";
import { Logger } from "../../logger";
import { EditorProcess, SerialExecutor } from "../common";
import { EditorService } from "../EditorService";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class EditorService4 implements EditorService {
  private _process: EditorProcess;
  private _serialExecutor = new SerialExecutor();

  constructor(logger: Logger, dprintExecutable: DprintExecutable) {
    this._process = new EditorProcess(logger, dprintExecutable);
    this._process.onExit(() => this._serialExecutor.clear());
  }

  kill() {
    // If graceful shutdown doesn't work soon enough
    // then kill the process
    const killTimeout = setTimeout(() => {
      this._process.kill();
    }, 1_000);

    // send a graceful shutdown signal
    writeInt(this._process, 0).finally(() => {
      this._process.kill();
      clearTimeout(killTimeout);
    }).catch(() => {/* ignore */});
  }

  canFormat(filePath: string) {
    this._process.startProcessIfNotRunning();
    return this._serialExecutor.execute(async () => {
      await writeInt(this._process, 1);
      await writeString(this._process, filePath);
      await this.writeSuccessBytes();
      const result = (await this._process.readInt()) === 1;
      await this.assertSuccessBytes();
      return result;
    });
  }

  formatText(filePath: string, fileText: string, token: vscode.CancellationToken) {
    this._process.startProcessIfNotRunning();
    return this._serialExecutor.execute(async () => {
      await writeInt(this._process, 2);
      await writeString(this._process, filePath);
      await writeString(this._process, fileText);
      await this.writeSuccessBytes();
      const response = await this._process.readInt();
      switch (response) {
        case 0: // no change
          await this.assertSuccessBytes();
          return undefined;
        case 1: // formatted
          let result = await readString(this._process);
          await this.assertSuccessBytes();
          return result;
        case 2: // error
          const errorText = await readString(this._process);
          await this.assertSuccessBytes();
          throw errorText;
        default:
          throw new Error(`Unknown format text response kind: ${response}`);
      }
    });
  }

  private async assertSuccessBytes() {
    // the editor service 4 still needs to use this max size method
    const buf = await this._process.readBufferWithMaxSize(4);
    if (buf.length !== 4) {
      throw new Error(`Expected success byte array with length 4, but had length ${buf.length}.`);
    }
    for (let i = 0; i < 4; i++) {
      if (buf[i] !== 255) {
        throw new Error(`Expected success bytes, but found: [${buf.join(", ")}]`);
      }
    }
  }

  private writeSuccessBytes() {
    const buf = Buffer.alloc(4, 255); // fill 4 bytes with value 255
    return this._process.writeBuffer(buf);
  }
}

async function writeString(process: EditorProcess, value: string) {
  const BUFFER_SIZE = 1024;
  const bytes = Buffer.from(textEncoder.encode(value));
  await writeInt(process, bytes.length);
  if (bytes.length < BUFFER_SIZE) {
    await process.writeBuffer(bytes);
  } else {
    // dislike how it doesn't seem to be possible to say "write this slice of this buffer to a stream"
    let index = 0;
    const fullBuffer = Buffer.alloc(1024);

    while (index < bytes.length) {
      if (index > 0) {
        // wait for "ready" from CLI
        await process.readInt();
      }
      const bufferSize = Math.min(BUFFER_SIZE, bytes.length - index);
      const buffer = bufferSize === BUFFER_SIZE ? fullBuffer : Buffer.alloc(bufferSize); // reuse already allocated buffer if able
      bytes.copy(buffer, 0, index, index + bufferSize);
      await process.writeBuffer(buffer);
      index += bufferSize;
    }
  }
}

async function readString(process: EditorProcess) {
  const stringSize = await process.readInt();
  const bytes = Buffer.alloc(stringSize);
  let index = 0;
  while (index < stringSize) {
    if (index > 0) {
      // send "ready" to CLI
      await writeInt(process, 0);
    }
    // the editor service 4 still needs to use this max size method
    const nextBuffer = await process.readBufferWithMaxSize(stringSize - index);
    nextBuffer.copy(bytes, index, 0, nextBuffer.length);
    index += nextBuffer.length;
  }
  return textDecoder.decode(bytes);
}

function writeInt(process: EditorProcess, value: number) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value);
  return process.writeBuffer(buf);
}
