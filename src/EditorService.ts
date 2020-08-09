import * as vscode from "vscode";
import { spawn, ChildProcessByStdio } from "child_process";
import { Writable, Readable } from "stream";
import { TextEncoder, TextDecoder } from "util";
import { SerialExecutor } from "./SerialExecutor";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class EditorService {
    private _process: ChildProcessByStdio<Writable, Readable, Readable>;
    private _bufs: Buffer[] = [];
    private _listener: (() => void) | undefined;
    private _serialExecutor = new SerialExecutor();
    private _isRunning = false;

    constructor() {
        this._process = this.createNewProcess();
    }

    kill() {
        this._process.kill();
    }

    canFormat(filePath: string) {
        this.startProcessIfNotRunning();
        return this._serialExecutor.execute(async () => {
            await this.writeInt(1);
            await this.writeString(filePath);
            const result = (await this.readInt()) == 1;
            return result;
        });
    }

    formatText(filePath: string, fileText: string, token: vscode.CancellationToken) {
        this.startProcessIfNotRunning();
        return this._serialExecutor.execute(async () => {
            await this.writeInt(2);
            await this.writeString(filePath);
            await this.writeString(fileText);
            const response = await this.readInt();
            switch (response) {
                case 0: // no change
                    return fileText;
                case 1: // formatted
                    return await this.readString();
                case 2: // error
                    const errorText = await this.readString();
                    throw new Error(errorText);
                default:
                    throw new Error(`Unknown format text response kind: ${response}`);
            }
        })
    }

    private startProcessIfNotRunning() {
        if (!this._isRunning)
            this._process = this.createNewProcess();
    }

    private createNewProcess() {
        const currentProcessId = process.pid;
        const childProcess = spawn("dprint", ["editor-service", "--parent-pid", currentProcessId.toString()], {
            stdio: ["pipe", "pipe", "pipe"],
            cwd: vscode.workspace.rootPath,
        });

        childProcess.stderr.on("data", data => {
            const dataText = getDataAsString();
            if (dataText != null) {
                console.error("[dprint]:", dataText);
            }

            function getDataAsString() {
                if (typeof data === "string")
                    return data;
                try {
                    return textDecoder.decode(data);
                } catch {
                    return undefined;
                }
            }
        })

        // really dislike this api... just allow me to await a result please
        childProcess.stdout.on("data", data => {
            this._bufs.push(data);
            const listener = this._listener;
            this._listener = undefined;
            listener?.();
        });

        childProcess.on("exit", () => {
            this._listener = undefined;
            this._serialExecutor.clear();
            this._bufs.length = 0; // clear
            this._isRunning = false;
        });

        this._isRunning = true;

        return childProcess;
    }

    private async writeString(value: string) {
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

    private async readString() {
        const stringSize = await this.readInt();
        const bytes = Buffer.alloc(stringSize);
        let index = 0;
        while (index < stringSize) {
            if (index > 0) {
                // send "ready" to CLI
                await this.writeInt(0);
            }
            const nextBuffer = await this.readBuffer();
            nextBuffer.copy(bytes, index, 0, nextBuffer.length);
            index += nextBuffer.length;
        }
        return textDecoder.decode(bytes);
    }

    private async readInt() {
        const buf = await this.readBuffer();
        if (buf.length > 4) {
            this._bufs.unshift(buf.slice(4));
        }
        return buf.readUInt32BE();
    }

    private readBuffer() {
        return new Promise<Buffer>(resolve => {
            const buf = this._bufs.shift();
            if (buf != null) {
                resolve(buf);
            } else {
                this._listener = () => {
                    const buf = this._bufs.shift()!;
                    resolve(buf);
                };
            }
        });
    }

    private writeInt(value: number) {
        const buf = Buffer.alloc(4);
        buf.writeUInt32BE(value);
        return this.writeBuffer(buf);
    }

    private writeBuffer(buf: Buffer) {
        return new Promise((resolve, reject) => {
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
