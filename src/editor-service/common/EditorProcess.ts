import { ChildProcessByStdio } from "child_process";
import { Readable, Writable } from "stream";
import { TextDecoder, TextEncoder } from "util";
import { DprintExecutable } from "../../executable/DprintExecutable";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class EditorProcess {
  private _process: ChildProcessByStdio<Writable, Readable, Readable>;
  private _bufs: Buffer[] = [];
  private _listener: (() => void) | undefined;
  private _onExitHandlers: (() => void)[] = [];
  private _isRunning = false;

  constructor(private readonly dprintExecutable: DprintExecutable) {
    this._process = this.createNewProcess();
  }

  onExit(handler: () => void) {
    this._onExitHandlers.push(handler);
  }

  kill() {
    try {
      this._process.kill();
    } catch {
      // ignore
    }
  }

  startProcessIfNotRunning() {
    if (!this._isRunning) {
      this.kill();
      this._process = this.createNewProcess();
    }
  }

  private createNewProcess() {
    const childProcess = this.dprintExecutable.spawnEditorService();

    childProcess.stderr.on("data", data => {
      const dataText = getDataAsString();
      if (dataText != null) {
        console.error("[dprint-editor-service]:", dataText);
      }

      function getDataAsString() {
        if (typeof data === "string") {
          return data;
        }
        try {
          return textDecoder.decode(data);
        } catch {
          return undefined;
        }
      }
    });

    // really dislike this api... just allow me to await a result please
    childProcess.stdout.on("data", data => {
      this._bufs.push(data);
      const listener = this._listener;
      this._listener = undefined;
      listener?.();
    });

    childProcess.on("exit", () => {
      this._listener = undefined;
      this._bufs.length = 0; // clear
      this._isRunning = false;
      for (const handler of this._onExitHandlers) {
        try {
          handler();
        } catch (err) {
          console.error("[dprint-vscode]: Error in exit handler.", err);
        }
      }
    });

    this._bufs.length = 0; // clear
    this._isRunning = true;

    return childProcess;
  }

  async writeString(value: string) {
    const BUFFER_SIZE = 1024;
    const bytes = Buffer.from(textEncoder.encode(value));
    await this.writeInt(bytes.length);
    if (bytes.length < BUFFER_SIZE) {
      await this.writeBuffer(bytes);
    } else {
      // dislike how it doesn't seem to be possible to say "write this slice of this buffer to a stream"
      let index = 0;
      const fullBuffer = Buffer.alloc(1024);

      while (index < bytes.length) {
        if (index > 0) {
          // wait for "ready" from CLI
          await this.readInt();
        }
        const bufferSize = Math.min(BUFFER_SIZE, bytes.length - index);
        const buffer = bufferSize === BUFFER_SIZE ? fullBuffer : Buffer.alloc(bufferSize); // reuse already allocated buffer if able
        bytes.copy(buffer, 0, index, index + bufferSize);
        await this.writeBuffer(buffer);
        index += bufferSize;
      }
    }
  }

  async readString() {
    const stringSize = await this.readInt();
    const bytes = Buffer.alloc(stringSize);
    let index = 0;
    while (index < stringSize) {
      if (index > 0) {
        // send "ready" to CLI
        await this.writeInt(0);
      }
      const nextBuffer = await this.readBuffer(stringSize - index);
      nextBuffer.copy(bytes, index, 0, nextBuffer.length);
      index += nextBuffer.length;
    }
    return textDecoder.decode(bytes);
  }

  async readInt() {
    const buf = await this.readBuffer(4);
    return buf.readUInt32BE();
  }

  readBuffer(maxSize: number) {
    return new Promise<Buffer>(resolve => {
      const buf = this.shiftBuffer(maxSize);
      if (buf != null) {
        resolve(buf);
      } else {
        this._listener = () => {
          const buf = this.shiftBuffer(maxSize)!;
          resolve(buf);
        };
      }
    });
  }

  private shiftBuffer(maxSize: number) {
    const buf = this._bufs.shift();
    if (buf != null) {
      if (buf.length > maxSize) {
        // insert the portion of the buffer back at the start
        this._bufs.unshift(buf.slice(maxSize));
      }
    }
    return buf;
  }

  writeInt(value: number) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(value);
    return this.writeBuffer(buf);
  }

  writeBuffer(buf: Buffer) {
    return new Promise<void>((resolve, reject) => {
      this._process.stdin.write(buf, err => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
}
