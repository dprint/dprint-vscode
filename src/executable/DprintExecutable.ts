import { exec, spawn } from "node:child_process";
import * as process from "node:process";
import * as vscode from "vscode";
import type { ApprovedConfigPaths } from "../ApprovedConfigPaths";
import type { DprintExtensionConfigPathInfo } from "../config";
import type { Environment } from "../environment";
import type { Logger } from "../logger";
import { tryResolveNpmExecutable } from "./npm";

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
  approvedPaths: ApprovedConfigPaths;
  pathInfo: DprintExtensionConfigPathInfo | undefined;
  cwd: vscode.Uri;
  configUri: vscode.Uri | undefined;
  verbose: boolean;
  logger: Logger;
  environment: Environment;
}

export class DprintExecutable {
  readonly #cmdPath: string;
  readonly #cwd: vscode.Uri;
  readonly #configUri: vscode.Uri | undefined;
  readonly #verbose: boolean;
  readonly #logger: Logger;

  private constructor(cmdPath: string, options: DprintExecutableOptions) {
    this.#logger = options.logger;
    this.#cmdPath = cmdPath;
    this.#cwd = options.cwd;
    this.#configUri = options.configUri;
    this.#verbose = options.verbose;
  }

  static async create(options: DprintExecutableOptions) {
    const cmdPath = await DprintExecutable.resolveCmdPath(options);
    return new DprintExecutable(cmdPath, options);
  }

  static async resolveCmdPath(options: DprintExecutableOptions) {
    const { approvedPaths, pathInfo, cwd, logger, environment } = options;

    // if a custom path is configured, check approval
    if (pathInfo != null) {
      const approved = await approvedPaths.promptForApproval(pathInfo);
      if (approved) {
        return getCommandNameOrAbsolutePath(pathInfo.path, cwd);
      }
      // not approved - fall through to regular resolution
    }

    // attempt to use the npm executable if it exists
    if (cwd != null) {
      const npmExec = await tryResolveNpmExecutable(cwd, environment, logger);
      if (npmExec != null) {
        return npmExec;
      }
    }

    // fall back to "dprint" command
    return "dprint";
  }

  get cmdPath() {
    return this.#cmdPath;
  }

  get initializationFolderUri() {
    if (this.#configUri != null) {
      return vscode.Uri.joinPath(this.#configUri, "../");
    }
    return this.#cwd;
  }

  async checkInstalled() {
    try {
      await this.#execShell([this.#cmdPath, "-v"], undefined, undefined);
      return true;
    } catch (err: any) {
      this.#logger.logError(`Problem launching ${this.#cmdPath}.`, err);
      return false;
    }
  }

  async getEditorInfo() {
    const stdout = await this.#execShell(
      [this.#cmdPath, "editor-info", ...this.#getConfigArgs()],
      undefined,
      undefined,
    );
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
    const args = ["editor-service", "--parent-pid", currentProcessId.toString(), ...this.#getConfigArgs()];
    if (this.#verbose) {
      args.push("--verbose");
    }

    return spawn(quoteCommandArg(this.#cmdPath), args.map(quoteCommandArg), {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.#cwd.fsPath,
      // Set to true, to ensure this resolves properly on windows.
      // See https://github.com/denoland/vscode_deno/issues/361
      shell: true,
    });
  }

  #execShell(
    command: string[],
    stdin: string | undefined,
    token: vscode.CancellationToken | undefined,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let cancellationDisposable: vscode.Disposable | undefined;
      try {
        const process = exec(command.map(quoteCommandArg).join(" "), {
          cwd: this.#cwd.fsPath,
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

  #getConfigArgs() {
    if (this.#configUri) {
      return ["--config", this.#configUri.fsPath];
    } else {
      return [];
    }
  }
}

function getCommandNameOrAbsolutePath(cmd: string, cwd: vscode.Uri | undefined) {
  if (cwd != null && (cmd.startsWith("./") || cmd.startsWith("../"))) {
    return vscode.Uri.joinPath(cwd, cmd).fsPath;
  }

  return cmd;
}

function quoteCommandArg(arg: string) {
  return `"${arg.replace(/"/g, "\\\"")}"`;
}
