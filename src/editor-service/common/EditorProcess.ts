import { ChildProcessByStdio } from "child_process";
import { Readable, Writable } from "stream";
import { TextDecoder } from "util";
import { DprintExecutable } from "../../executable/DprintExecutable";
import { Logger } from "../../logger";

const textDecoder = new TextDecoder();

export class EditorProcess {
  private _process: ChildProcessByStdio<Writable, Readable, Readable>;
  private _bufs: Buffer[] = [];
  private _listener: {
    resolve: (() => void);
    reject: (err: unknown) => void;
  } | undefined;
  private _onExitHandlers: (() => void)[] = [];
  private _isRunning = false;

  constructor(private readonly logger: Logger, private readonly dprintExecutable: DprintExecutable) {
    this._process = this.createNewProcess();
  }

  get isRunning() {
    return this._isRunning;
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
    this._clearInternal();
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
        this.logger.log(dataText.trim());
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
      listener?.resolve();
    });

    childProcess.on("exit", () => {
      this._clearInternal();
      for (const handler of this._onExitHandlers) {
        try {
          handler();
        } catch (err) {
          this.logger.logError("Error in exit handler.", err);
        }
      }
    });

    this._bufs.length = 0; // clear
    this._isRunning = true;

    return childProcess;
  }

  private _clearInternal() {
    const listener = this._listener;
    this._listener = undefined;
    this._bufs.length = 0; // clear
    this._isRunning = false;
    listener?.reject(new Error("Operation cancelled."));
  }

  async readInt() {
    const buf = await this.readBuffer(4);
    return buf.readUInt32BE();
  }

  readBuffer(maxSize: number) {
    this._throwIfNotRunning();

    if (maxSize === 0) {
      return Promise.resolve(Buffer.alloc(0));
    }

    return new Promise<Buffer>((resolve, reject) => {
      const buf = this.shiftBuffer(maxSize);
      if (buf != null) {
        resolve(buf);
      } else {
        this._listener = {
          resolve: () => {
            const buf = this.shiftBuffer(maxSize)!;
            resolve(buf);
          },
          reject,
        };
      }
    });
  }

  private shiftBuffer(maxSize: number) {
    let buf = this._bufs.shift();
    if (buf != null) {
      if (buf.length > maxSize) {
        // insert the portion of the buffer back at the start
        this._bufs.unshift(buf.slice(maxSize));
        buf = buf.slice(0, maxSize);
      }
    }
    return buf;
  }

  writeBuffer(buf: Buffer) {
    this._throwIfNotRunning();
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

  private _throwIfNotRunning() {
    if (!this._isRunning) {
      throw new Error("Editor service is not running.");
    }
  }
}
