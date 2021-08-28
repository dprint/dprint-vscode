import * as vscode from "vscode";
import { DprintExecutable } from "../../executable";
import { EditorProcess, SerialExecutor } from "../common";
import { EditorService } from "../EditorService";

export class EditorService2 implements EditorService {
  private _process: EditorProcess;
  private _serialExecutor = new SerialExecutor();

  constructor(dprintExecutable: DprintExecutable) {
    this._process = new EditorProcess(dprintExecutable);
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
      const result = (await this._process.readInt()) === 1;
      return result;
    });
  }

  formatText(filePath: string, fileText: string, token: vscode.CancellationToken) {
    this._process.startProcessIfNotRunning();
    return this._serialExecutor.execute(async () => {
      await this._process.writeInt(2);
      await this._process.writeString(filePath);
      await this._process.writeString(fileText);
      const response = await this._process.readInt();
      switch (response) {
        case 0: // no change
          return fileText;
        case 1: // formatted
          return await this._process.readString();
        case 2: // error
          const errorText = await this._process.readString();
          throw errorText;
        default:
          throw new Error(`Unknown format text response kind: ${response}`);
      }
    });
  }
}
