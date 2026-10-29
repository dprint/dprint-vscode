import { which } from "@dsherret/which";
import { exec, execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as process from "node:process";
import * as vscode from "vscode";
import type { ApprovedConfigPaths } from "../ApprovedConfigPaths";
import type { DprintExtensionConfigPathInfo } from "../config";
import type { Environment } from "../environment";
import type { Logger } from "../logger";
import {
  type DprintCommand,
  expandWindowsEnvVars,
  getCommandDisplayText,
  getCommandLaunchInfo,
  getProcessKey,
  resolveWindowsCommand,
  substituteCommands,
} from "./command";
import { tryResolveNpmExecutable } from "./npm";

export interface DprintExecutableOptions {
  approvedPaths: ApprovedConfigPaths;
  pathInfo: DprintExtensionConfigPathInfo | undefined;
  cwd: vscode.Uri;
  /** Whether to use a dprint executable found in node_modules. Defaults to true. */
  resolveNpmExecutable?: boolean;
  /** Directory to start searching node_modules for a dprint executable from. Defaults to the cwd. */
  npmSearchDir?: vscode.Uri;
  /** The environment variables to launch the cli with. Defaults to this process' environment. */
  env?: NodeJS.ProcessEnv;
  verbose: boolean;
  logger: Logger;
  environment: Environment;
}

export class DprintExecutable {
  readonly #command: DprintCommand;
  readonly #cwd: vscode.Uri;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #verbose: boolean;

  private constructor(command: DprintCommand, options: DprintExecutableOptions) {
    this.#command = command;
    this.#cwd = options.cwd;
    this.#env = options.env;
    this.#verbose = options.verbose;
  }

  static async create(options: DprintExecutableOptions) {
    const command = await DprintExecutable.resolveCommand(options);
    return new DprintExecutable(command, options);
  }

  static async resolveCommand(options: DprintExecutableOptions): Promise<DprintCommand> {
    const command = await getCommand(options);
    return process.platform === "win32"
      ? await resolveWindowsCommand(
        command,
        commandPath => which(commandPath, whichEnvironment),
        process.env.PATHEXT,
      )
      : command;
  }

  get cmdPath() {
    return getCommandDisplayText(this.#command);
  }

  /**
   * Identifies the executable and how it's launched, which is the same for the
   * executables that can share a dprint process.
   */
  get processKey() {
    return getProcessKey(this.#command, { cwd: this.#cwd.fsPath, env: this.#env, verbose: this.#verbose });
  }

  /**
   * Starts dprint's language server, which an editor extension uses with the `dprint/*`
   * methods. It exits with the process of the `processId` it's initialized with.
   */
  spawnLanguageServer() {
    const args = ["lsp"];
    if (this.#verbose) {
      args.push("--verbose");
    }
    return this.spawn(args);
  }

  /** Starts the cli with the arguments and pipes for its stdio. */
  spawn(args: string[]) {
    const launchInfo = getCommandLaunchInfo(this.#command, args, process.platform);
    return spawn(launchInfo.command, launchInfo.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.#cwd.fsPath,
      env: this.#env,
      shell: launchInfo.shell,
    });
  }

  /** Runs the cli with the arguments and gets its stdout without the last newline. */
  execShell(
    args: string[],
    stdin: string | undefined,
    token: vscode.CancellationToken | undefined,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let cancellationDisposable: vscode.Disposable | undefined;
      try {
        const launchInfo = getCommandLaunchInfo(this.#command, args, process.platform);
        const childProcess = execFile(launchInfo.command, launchInfo.args, {
          cwd: this.#cwd.fsPath,
          env: this.#env,
          encoding: "utf8",
          shell: launchInfo.shell,
        }, (err, stdout, stderr) => {
          if (err) {
            cancellationDisposable?.dispose();
            // there's no stderr when the executable couldn't be launched (ex. ENOENT)
            reject(stderr || err);
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
}

async function getCommand(options: DprintExecutableOptions): Promise<DprintCommand> {
  const { approvedPaths, pathInfo, cwd, logger, environment } = options;

  // if a custom path is configured, check approval
  if (pathInfo != null) {
    const approved = await approvedPaths.promptForApproval(pathInfo);
    if (approved) {
      // on Windows, dprint is usually launched without cmd.exe, so expand the setting like it would
      const settingPath = process.platform === "win32"
        ? expandWindowsEnvVars(
          await substituteCommands(pathInfo.path, command => runShellCommand(command, cwd?.fsPath)),
          process.env,
        )
        : pathInfo.path; // the shell substitutes commands
      return { kind: "setting", path: settingPath, cwd: cwd?.fsPath };
    }
    // not approved - fall through to regular resolution
  }

  // attempt to use the npm executable if it exists
  const npmSearchDir = options.npmSearchDir ?? cwd;
  if (npmSearchDir != null && (options.resolveNpmExecutable ?? true)) {
    const npmExec = await tryResolveNpmExecutable(npmSearchDir.fsPath, environment, logger);
    if (npmExec != null) {
      return { kind: "path", path: npmExec };
    }
  }

  // fall back to "dprint" command
  return { kind: "path", path: "dprint" };
}

function runShellCommand(command: string, cwd: string | undefined) {
  return new Promise<string>((resolve, reject) => {
    exec(command, { cwd, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`Failed running \`${command}\` from the dprint.path setting: ${stderr || err.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

/** File system access for `which` that works with the older Node.js versions of vscode. */
const whichEnvironment: Parameters<typeof which>[1] = {
  isWindows: process.platform === "win32",
  env(key) {
    return process.env[key];
  },
  async stat(filePath) {
    const info = await fs.promises.stat(filePath);
    return { isFile: info.isFile() };
  },
  async lstat(filePath) {
    const info = await fs.promises.lstat(filePath);
    return { isFile: info.isFile(), isSymlink: info.isSymbolicLink() };
  },
  readLink(filePath) {
    return fs.promises.readlink(filePath);
  },
};
