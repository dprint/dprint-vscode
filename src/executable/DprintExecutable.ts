import { execFile, spawn } from "node:child_process";
import * as process from "node:process";
import * as vscode from "vscode";
import type { ApprovedConfigPaths } from "../ApprovedConfigPaths";
import type { DprintExtensionConfigPathInfo } from "../config";
import type { Environment } from "../environment";
import type { Logger } from "../logger";
import { getCliEnv } from "./cliEnv";
import { getCommandLaunchInfo } from "./command";
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

/** A config discovery mode supported by the cli. */
export type ConfigDiscovery = "ignore-descendants";

export interface DprintExecutableOptions {
  approvedPaths: ApprovedConfigPaths;
  pathInfo: DprintExtensionConfigPathInfo | undefined;
  cwd: vscode.Uri;
  configUri: vscode.Uri | undefined;
  /** Whether to use a dprint executable found in node_modules. Defaults to true. */
  resolveNpmExecutable?: boolean;
  /** Directory to start searching node_modules for a dprint executable from. Defaults to the cwd. */
  npmSearchDir?: vscode.Uri;
  /** The cli's config discovery mode. Defaults to the cli's default. */
  configDiscovery?: ConfigDiscovery;
  /** Whether to format again until the output is stable. Defaults to false. */
  ensureStableFormat?: boolean;
  verbose: boolean;
  logger: Logger;
  environment: Environment;
}

export class DprintExecutable {
  readonly #cmdPath: string;
  readonly #cwd: vscode.Uri;
  readonly #configUri: vscode.Uri | undefined;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #verbose: boolean;
  readonly #logger: Logger;

  private constructor(cmdPath: string, options: DprintExecutableOptions) {
    this.#logger = options.logger;
    this.#cmdPath = cmdPath;
    this.#cwd = options.cwd;
    this.#configUri = options.configUri;
    this.#env = getCliEnv(process.env, options);
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
    const npmSearchDir = options.npmSearchDir ?? cwd;
    if (npmSearchDir != null && (options.resolveNpmExecutable ?? true)) {
      const npmExec = await tryResolveNpmExecutable(npmSearchDir.fsPath, environment, logger);
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

    const launchInfo = getCommandLaunchInfo(this.#cmdPath, args, process.platform);
    return spawn(launchInfo.command, launchInfo.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.#cwd.fsPath,
      env: this.#env,
      shell: launchInfo.shell,
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
        const [cmd, ...args] = command;
        const launchInfo = getCommandLaunchInfo(cmd, args, process.platform);
        const childProcess = execFile(launchInfo.command, launchInfo.args, {
          cwd: this.#cwd.fsPath,
          env: this.#env,
          encoding: "utf8",
          shell: launchInfo.shell,
        }, (err, stdout, stderr) => {
          if (err) {
            cancellationDisposable?.dispose();
            reject(stderr);
            return;
          }
          resolve(stdout.replace(/\r?\n$/, "")); // remove the last newline
          cancellationDisposable?.dispose();
        });
        cancellationDisposable = token?.onCancellationRequested(() => childProcess.kill());
        if (stdin != null) {
          childProcess.stdin!.write(stdin);
          childProcess.stdin!.end();
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
