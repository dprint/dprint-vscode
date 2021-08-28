import { exec, spawn } from "child_process";
import * as vscode from "vscode";

interface EditorInfo {
  schemaVersion: number;
  plugins: PluginInfo[];
}

export interface PluginInfo {
  name: string;
  fileExtensions: string[];
}

export interface DprintExecutableOptions {
  /** The path to the dprint executable. */
  cmdPath?: string;
  workspaceFolder: string;
}

export class DprintExecutable {
  private readonly _cmdPath: string;
  private readonly _workspaceFolder: string;

  constructor(options: DprintExecutableOptions) {
    this._cmdPath = options.cmdPath ?? "dprint";
    this._workspaceFolder = options.workspaceFolder;
  }

  async checkInstalled() {
    try {
      await this.execShell(`${this._cmdPath} -v`, undefined, undefined);
      return true;
    } catch (err) {
      console.error("[dprint]:", err);
      return false;
    }
  }

  async getEditorInfo() {
    const stdout = await this.execShell(`${this._cmdPath} editor-info`, undefined, undefined);
    const editorInfo = parseEditorInfo();

    if (
      !(editorInfo.plugins instanceof Array) || typeof editorInfo.schemaVersion !== "number"
      || isNaN(editorInfo.schemaVersion)
    ) {
      throw new Error("Error getting editor info. Your editor extension or dprint CLI might be out of date.");
    }

    return editorInfo;

    function parseEditorInfo() {
      try {
        return JSON.parse(stdout) as EditorInfo;
      } catch (err) {
        throw new Error(`Error parsing editor info. Output was: ${stdout}\n\nError: ${err}`);
      }
    }
  }

  spawnEditorService() {
    const currentProcessId = process.pid;
    return spawn(this._cmdPath, ["editor-service", "--parent-pid", currentProcessId.toString()], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this._workspaceFolder,
      // Set to true, to ensure this resolves properly on windows.
      // See https://github.com/denoland/vscode_deno/issues/361
      shell: true,
    });
  }

  private execShell(
    command: string,
    stdin: string | undefined,
    token: vscode.CancellationToken | undefined,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let cancellationDisposable: vscode.Disposable | undefined;
      try {
        const process = exec(command, {
          cwd: this._workspaceFolder,
          encoding: "utf8",
        }, (err, stdout, stderr) => {
          if (err) {
            cancellationDisposable?.dispose();
            reject(stderr);
            return;
          }
          resolve(stdout.replace(/\r?\n$/, "")); // remove the last newline
          cancellationDisposable?.dispose();
        });
        cancellationDisposable = token?.onCancellationRequested(() => process.kill());
        if (stdin != null) {
          process.stdin!.write(stdin);
          process.stdin!.end();
        }
      } catch (err) {
        reject(err);
        cancellationDisposable?.dispose();
      }
    });
  }
}
