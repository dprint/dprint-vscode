import { exec, spawn } from "child_process";
import * as vscode from "vscode";
import { Logger } from "../logger";

export interface EditorInfo {
  schemaVersion: number;
  cliVersion: string;
  configSchemaUrl: string;
  plugins: PluginInfo[];
}

export interface PluginInfo {
  name: string;
  version: string;
  configKey: string;
  fileExtensions: string[];
  fileNames: string[];
  configSchemaUrl: string | undefined;
  helpUrl: string;
}

export interface DprintExecutableOptions {
  /** The path to the dprint executable. */
  cmdPath: string | undefined;
  workspaceFolder: string;
  debug: boolean;
}

export class DprintExecutable {
  readonly #cmdPath: string;
  readonly #workspaceFolder: string;
  readonly #debug: boolean;
  readonly #logger: Logger;

  constructor(logger: Logger, options: DprintExecutableOptions) {
    this.#logger = logger;
    this.#cmdPath = options.cmdPath ?? "dprint";
    this.#workspaceFolder = options.workspaceFolder;
    this.#debug = options.debug;
  }

  async checkInstalled() {
    try {
      await this.execShell(`${this.#cmdPath} -v`, undefined, undefined);
      return true;
    } catch (err: any) {
      this.#logger.logError(err.toString());
      return false;
    }
  }

  async getEditorInfo() {
    const stdout = await this.execShell(`${this.#cmdPath} editor-info`, undefined, undefined);
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
    const args = ["editor-service", "--parent-pid", currentProcessId.toString()];
    if (this.#debug) {
      args.push("--verbose");
    }

    return spawn(this.#cmdPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.#workspaceFolder,
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
          cwd: this.#workspaceFolder,
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
