import type { ChildProcessByStdio } from "child_process";
import type { Readable, Writable } from "stream";
import { TextDecoder } from "util";
import type { DprintExecutable } from "../../../executable/DprintExecutable";
import type { Logger } from "../../../logger";

const textDecoder = new TextDecoder();

/** Error a pending read is rejected with when the process it was waiting on failed to spawn. */
export class SpawnFailedError extends Error {
}

export class EditorProcess {
  // lazily initialize the process
  private _process: ChildProcessByStdio<Writable, Readable, Readable> | undefined;
  private _bufs: Buffer[] = [];
  private _listener: {
    resolve: () => void;
    reject: (err: unknown) => void;
  } | undefined;
  private _onExitHandlers: (() => void)[] = [];
  private _onStartListeners: (() => void)[] = [];
  private _hasSpawnFailed = false;

  constructor(private readonly logger: Logger, private readonly dprintExecutable: DprintExecutable) {
  }

  get isRunning() {
    return this._process != null;
  }

  /** Whether the last process failed to spawn and no process was started since. */
  get hasSpawnFailed() {
    return this._hasSpawnFailed;
  }

  onExit(handler: () => void) {
    this._onExitHandlers.push(handler);
  }

  kill() {
    const process = this._process;
    if (process == null) {
      return;
    }
    try {
      process.kill();
    } catch {
      // ignore
    }
    // the events of a killed process are ignored, so this is where its exit is handled
    this._handleExit(new Error("Operation cancelled."));
  }

  startProcessIfNotRunning() {
    if (this._process == null) {
      this.kill();
      this._hasSpawnFailed = false;
      this._process = this.createNewProcess();
      for (const listener of this._onStartListeners.splice(0)) {
        listener();
      }
    }
    return this._process;
  }

  /** Resolves once a process is running, which is right away when one already is. */
  waitUntilRunning() {
    if (this._process != null) {
      return Promise.resolve();
    }
    return new Promise<void>(resolve => this._onStartListeners.push(resolve));
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
      if (this._process !== childProcess) {
        return; // output of a killed process
      }
      this._bufs.push(data);
      const listener = this._listener;
      this._listener = undefined;
      listener?.resolve();
    });

    // Only the current process is handled, which it stops being once handled here. An event
    // of a process that was killed or already handled must not clear a newer process.
    childProcess.on("exit", () => {
      if (this._process === childProcess) {
        this._handleExit(new Error("Operation cancelled."));
      }
    });
    // A process that fails to spawn (ex. the executable or the cwd no longer exists) emits
    // only this event. Without handling it the process would be considered running forever.
    childProcess.on("error", err => {
      this.logger.logError("Editor service process error:", err);
      if (this._process === childProcess) {
        this._hasSpawnFailed = true;
        this._handleExit(new SpawnFailedError("Operation cancelled."));
      }
    });
    // a failed write is reported to the writer, so this only prevents an uncaught exception
    childProcess.stdin.on("error", err => {
      this.logger.logDebug("Error writing to the editor service:", err);
    });

    this._bufs.length = 0; // clear

    return childProcess;
  }

  private _handleExit(readError: Error) {
    this._clearInternal(readError);
    for (const handler of this._onExitHandlers) {
      try {
        handler();
      } catch (err) {
        this.logger.logError("Error in exit handler.", err);
      }
    }
  }

  private _clearInternal(readError: Error) {
    const listener = this._listener;
    this._listener = undefined;
    this._bufs.length = 0; // clear
    this._process = undefined;
    listener?.reject(readError);
  }

  async readInt() {
    const buf = await this.readBufferExact(4);
    return buf.readUInt32BE();
  }

  async readBufferExact(size: number) {
    let i = 0;
    let finalBuffer: Buffer | undefined;
    while (i < size) {
      const remainingSize = size - i;
      const buffer = await this.readBufferWithMaxSize(remainingSize);
      if (i == 0 && buffer.length === size) {
        return buffer;
      } else if (finalBuffer == null) {
        finalBuffer = Buffer.alloc(size);
      }
      buffer.copy(finalBuffer, i, 0);
      i += buffer.length;
    }
    return finalBuffer ?? Buffer.alloc(0);
  }

  readBufferWithMaxSize(maxSize: number) {
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
    const process = this._throwIfNotRunning();
    return new Promise<void>((resolve, reject) => {
      process.stdin.write(buf, err => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  private _throwIfNotRunning() {
    if (this._process == null) {
      throw new Error("Editor service is not running.");
    }
    return this._process;
  }
}
