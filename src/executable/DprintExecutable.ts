import { which } from "@dsherret/which";
import { exec, execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
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
    if (process.platform !== "win32") {
      // a bare name is found on the absolute directories of the path, which an empty or relative
      // one (ex. ".") would otherwise make the workspace folder
      if (isBareCommand(command.path) && /^[\w.-]+$/.test(command.path)) {
        const filePath = await which(command.path, whichEnvironment);
        if (filePath == null) {
          throw new Error(`${command.path} wasn't found on the path.`);
        }
        // a plain name doesn't need the shell
        return { kind: "path", path: filePath };
      }
      return command;
    }
    const resolved = await resolveWindowsCommand(
      command,
      commandPath => which(commandPath, whichEnvironment),
      process.env.PATHEXT,
    );
    // Windows looks for a bare command in the current directory first, which is the workspace
    // folder, so one that isn't found on the path isn't started
    if (isBareCommand(resolved.path)) {
      throw new Error(`${resolved.path} wasn't found on the path.`);
    }
    return resolved;
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
      env: getLaunchEnv(this.#env),
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
          env: getLaunchEnv(this.#env),
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
    exec(command, { cwd, encoding: "utf8", env: getLaunchEnv(undefined) }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`Failed running \`${command}\` from the dprint.path setting: ${stderr || err.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Gets the environment to launch a process with, which has cmd.exe not look for the commands it
 * runs in the current directory first (the workspace folder) on Windows.
 */
function getLaunchEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined {
  if (process.platform !== "win32") {
    return env;
  }
  return { ...(env ?? process.env), NoDefaultCurrentDirectoryInExePath: "1" };
}

/** Gets if the command is a name without a directory, which is looked for on the path. */
function isBareCommand(command: string) {
  return !/[\\/]/.test(command);
}

/**
 * File system access for `which` that works with the older Node.js versions of vscode, which only
 * looks in the absolute directories of the path so a relative one can't be the workspace folder.
 */
const whichEnvironment: Parameters<typeof which>[1] = {
  isWindows: process.platform === "win32",
  env(key) {
    const value = process.env[key];
    if (key.toUpperCase() !== "PATH" || value == null) {
      return value;
    }
    return value.split(path.delimiter).filter(dir => path.isAbsolute(dir)).join(path.delimiter);
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
