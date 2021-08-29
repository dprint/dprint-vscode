import * as vscode from "vscode";
import { DprintExecutable } from "../../executable";
import { Logger } from "../../logger";
import { EditorProcess, SerialExecutor } from "../common";
import { EditorService } from "../EditorService";

export class EditorService3 implements EditorService {
  private _process: EditorProcess;
  private _serialExecutor = new SerialExecutor();

  constructor(logger: Logger, dprintExecutable: DprintExecutable) {
    this._process = new EditorProcess(logger, dprintExecutable);
    this._process.onExit(() => this._serialExecutor.clear());
  }

  kill() {
    this._process.kill();
  }

  canFormat(filePath: string) {
    this._process.startProcessIfNotRunning();
    return this._serialExecutor.execute(async () => {
      await this._process.writeInt(1);
      await this._process.writeString(filePath);
      await this.writeSuccessBytes();
      const result = (await this._process.readInt()) === 1;
      await this.assertSuccessBytes();
      return result;
    });
  }

  formatText(filePath: string, fileText: string, token: vscode.CancellationToken) {
    this._process.startProcessIfNotRunning();
    return this._serialExecutor.execute(async () => {
      await this._process.writeInt(2);
      await this._process.writeString(filePath);
      await this._process.writeString(fileText);
      await this.writeSuccessBytes();
      const response = await this._process.readInt();
      switch (response) {
        case 0: // no change
          await this.assertSuccessBytes();
          return fileText;
        case 1: // formatted
          let result = await this._process.readString();
          await this.assertSuccessBytes();
          return result;
        case 2: // error
          const errorText = await this._process.readString();
          await this.assertSuccessBytes();
          throw errorText;
        default:
          throw new Error(`Unknown format text response kind: ${response}`);
      }
    });
  }

  private async assertSuccessBytes() {
    const buf = await this._process.readBuffer(4);
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
