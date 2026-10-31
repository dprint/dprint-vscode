// note: this file should not import "vscode" so that it can be unit tested

import * as path from "node:path";

/**
 * The dprint executable to launch.
 *
 * A `dprint.path` setting is interpreted by the shell (ex. `$HOME/bin/dprint`), or
 * expanded like a shell would on Windows, which is fine because it's from the
 * user's settings or they approved it. Other
 * paths (ex. one found in node_modules) are used as-is.
 */
export type DprintCommand =
  | { kind: "path"; path: string }
  | { kind: "setting"; path: string; cwd: string | undefined };

/** How to launch a command. */
export interface CommandLaunchInfo {
  command: string;
  args: string[];
  shell: boolean;
}

/**
 * Replaces each `$(command)` in the text with the command's trimmed output like a
 * POSIX shell does. This is used on Windows because cmd.exe doesn't support it.
 */
export async function substituteCommands(text: string, runCommand: (command: string) => Promise<string>) {
  let result = "";
  let index = 0;
  for (const match of text.matchAll(/\$\(([^)]*)\)/g)) {
    result += text.slice(index, match.index) + (await runCommand(match[1])).trim();
    index = match.index! + match[0].length;
  }
  return result + text.slice(index);
}

/**
 * Replaces each `%NAME%` in the text with the environment variable's value like
 * cmd.exe does, leaving undefined variables as-is. This is used on Windows because
 * dprint is launched without cmd.exe when possible.
 */
export function expandWindowsEnvVars(text: string, env: { [name: string]: string | undefined }) {
  return text.replace(/%([^%]+)%/g, (match, name: string) => env[name] ?? match);
}

/**
 * Resolves the executable file of a command on Windows (ex. `dprint` to
 * `C:\bin\dprint.exe`) so that it can be launched without cmd.exe when possible.
 * The command is kept as-is when the file isn't found.
 *
 * Like cmd.exe, a file with an executable extension is preferred over the file at
 * a path without one (ex. `bin/dprint.bat` over a `bin/dprint` shell script that's
 * there for other platforms).
 */
export async function resolveWindowsCommand(
  command: DprintCommand,
  which: (command: string) => Promise<string | undefined>,
  pathExt?: string,
): Promise<DprintCommand> {
  const commandPath = getWindowsCommandPath(command);
  for (const candidate of [...getWindowsExecutableCandidates(commandPath, pathExt), commandPath]) {
    const filePath = await which(candidate);
    if (filePath != null) {
      return { ...command, path: filePath };
    }
  }
  return command;
}

/** Gets the text to display for the command. */
export function getCommandDisplayText(command: DprintCommand) {
  return command.kind === "setting" && command.cwd != null && isRelativePath(command.path)
    ? path.join(command.cwd, command.path)
    : command.path;
}

/**
 * Identifies the command and how it's launched, which is the same for the
 * commands that can share a dprint process.
 */
export function getProcessKey(
  command: DprintCommand,
  options: { cwd: string; env: NodeJS.ProcessEnv | undefined; verbose: boolean },
) {
  const displayText = getCommandDisplayText(command);
  // a relative path in the setting may resolve from the cwd (ex. `bin/dprint` on posix)
  const isCwdRelative = command.kind === "setting" && /[\\/]/.test(displayText) && !path.isAbsolute(displayText);
  const cwd = isCwdRelative ? options.cwd : null;
  return JSON.stringify([displayText, cwd, options.env ?? null, options.verbose]);
}

/**
 * Gets how to launch a command so that its arguments are passed as-is.
 *
 * On Windows, a shell is only used to launch a batch file such as an npm `dprint.cmd`
 * (see https://github.com/denoland/vscode_deno/issues/361), so the command and its
 * quoted arguments are provided as a single command line. It's otherwise avoided
 * because cmd.exe outputs its errors in the system's code page instead of UTF-8
 * (see https://github.com/dprint/dprint-vscode/issues/2). Elsewhere, a shell is only
 * used for a `dprint.path` setting and the arguments are quoted so it doesn't
 * interpret them.
 */
export function getCommandLaunchInfo(
  command: DprintCommand,
  args: string[],
  platform: NodeJS.Platform,
): CommandLaunchInfo {
  if (platform === "win32") {
    const commandPath = getWindowsCommandPath(command);
    if (!/\.(cmd|bat)$/i.test(commandPath)) {
      return { command: commandPath, args, shell: false };
    }
    return {
      command: [commandPath, ...args].map(quoteWindowsArg).join(" "),
      args: [],
      shell: true,
    };
  } else if (command.kind === "setting") {
    return {
      command: [getPosixSettingCommand(command), ...args.map(quotePosixArg)].join(" "),
      args: [],
      shell: true,
    };
  } else {
    return { command: command.path, args, shell: false };
  }
}

/** How to kill a process together with the processes it started. */
export type ProcessTreeKill =
  /** A command to run. */
  | { kind: "command"; command: string; args: string[] }
  /** The process group to signal, which is the negative process id of its leader. */
  | { kind: "group"; pid: number };

/**
 * Gets how to kill a process together with the processes it started, because killing only a shell,
 * a batch file such as an npm `dprint.cmd`, or npm's Node.js wrapper leaves dprint running. That's
 * `taskkill /T /F` on Windows, by its absolute path so it isn't looked for in the workspace folder,
 * and the process group elsewhere, which needs the process to be started in its own group.
 */
export function getProcessTreeKill(
  pid: number,
  platform: NodeJS.Platform,
  systemRoot: string | undefined,
): ProcessTreeKill {
  if (platform === "win32") {
    return {
      kind: "command",
      command: path.win32.join(systemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      args: ["/T", "/F", "/PID", String(pid)],
    };
  }
  return { kind: "group", pid: -pid };
}

/** The parts of a child process that killing it uses, which is a subset so this can be unit tested. */
export interface KillableProcess {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  /** Kills it by its handle, which never reaches another process that has its pid once it exited. */
  kill(signal?: NodeJS.Signals): boolean;
}

/** What killing a process tree uses, which is provided so it can be unit tested. */
export interface ProcessTreeKillEnvironment {
  platform: NodeJS.Platform;
  systemRoot: string | undefined;
  /** Sends a signal to a process or a process group like `process.kill`, which throws when there's none. */
  signal(pid: number, signal: NodeJS.Signals | 0): void;
  /** Runs a command, which resolves with whether it succeeded. */
  run(command: string, args: string[]): Promise<boolean>;
  delay(ms: number): Promise<void>;
}

/** How long to wait for the processes of a group to exit after it's signalled (see `killProcessTreeWith`). */
const GROUP_EXIT_TIMEOUT = 5_000;
/** How often to check whether the processes of a group exited. */
const GROUP_EXIT_POLL_INTERVAL = 50;
/** How long the processes of a group get to exit after a signal before they're killed with SIGKILL. */
const GROUP_KILL_GRACE = 1_000;

/**
 * Kills a process with the processes it started (see `getProcessTreeKill`), which resolves once that
 * was done: once `taskkill` finished on Windows, and once every process of the group exited (or after
 * a timeout) elsewhere, where the group is killed with SIGKILL when it doesn't exit in time (ex. a
 * process that a plugin started ignores SIGTERM). Only the process is killed when that fails. Nothing
 * is done once the process exited, because its pid (and so the root of the tree) may be another
 * process's then, apart from the group, which isn't reused while it has a process.
 *
 * Note that `taskkill` opens the process by its pid a little after it's checked that it's running,
 * so a process that exits in between may have its pid reused by then, which this can't rule out.
 */
export async function killProcessTreeWith(
  childProcess: KillableProcess,
  signal: NodeJS.Signals | undefined,
  env: ProcessTreeKillEnvironment,
): Promise<void> {
  const pid = childProcess.pid;
  if (pid == null || hasExited(childProcess)) {
    childProcess.kill(signal); // by its handle, which does nothing once it exited
    return;
  }
  const treeKill = getProcessTreeKill(pid, env.platform, env.systemRoot);
  if (treeKill.kind === "command") {
    if (!await env.run(treeKill.command, treeKill.args) && !hasExited(childProcess)) {
      // ex. taskkill wasn't found
      childProcess.kill(signal);
    }
    return;
  }
  try {
    env.signal(treeKill.pid, signal ?? "SIGTERM");
  } catch {
    childProcess.kill(signal);
    return;
  }
  // the group isn't reused while any of its processes is running, so it's safe to check and signal it
  // after its leader exited as long as it still has a process
  let isKilled = signal === "SIGKILL";
  for (let waited = 0; waited < GROUP_EXIT_TIMEOUT; waited += GROUP_EXIT_POLL_INTERVAL) {
    try {
      env.signal(treeKill.pid, 0);
      if (!isKilled && waited >= GROUP_KILL_GRACE) {
        isKilled = true;
        env.signal(treeKill.pid, "SIGKILL");
      }
    } catch {
      return; // every process of the group exited
    }
    await env.delay(GROUP_EXIT_POLL_INTERVAL);
  }
}

function hasExited(childProcess: KillableProcess) {
  return childProcess.exitCode != null || childProcess.signalCode != null;
}

function getWindowsCommandPath(command: DprintCommand) {
  return command.kind === "setting" && command.cwd != null && isWindowsRelativePath(command.path)
    // resolve instead of join for a drive-relative path (ex. `C:bin\dprint`)
    ? path.win32.resolve(command.cwd, command.path)
    : command.path;
}

/** Gets the path with each executable extension when it's a file path without one. */
function getWindowsExecutableCandidates(commandPath: string, pathExt: string | undefined) {
  if (!/[\\/]/.test(commandPath)) {
    return []; // a command name, which is searched for on the path with the extensions
  }
  const extensions = (pathExt ?? ".EXE;.CMD;.BAT;.COM").split(";").map(ext => ext.trim()).filter(ext => ext.length > 0);
  const lowerCasePath = commandPath.toLowerCase();
  if (extensions.some(ext => lowerCasePath.endsWith(ext.toLowerCase()))) {
    return [];
  }
  // only the extensions that can be launched (ex. not a `dprint.js` beside the file)
  return extensions.filter(ext => /^\.(exe|com|cmd|bat)$/i.test(ext)).map(ext => commandPath + ext);
}

/** If it's a file path relative to the folder (ex. `bin/dprint`) rather than a command name. */
function isWindowsRelativePath(commandPath: string) {
  return /[\\/]/.test(commandPath) && !path.win32.isAbsolute(commandPath);
}

function getPosixSettingCommand(command: DprintCommand & { kind: "setting" }) {
  // double quotes so the shell expands the setting (ex. `$HOME`)
  const settingText = `"${command.path.replace(/"/g, "\\\"")}"`;
  // the directory isn't from the setting, so don't let the shell interpret it
  return command.cwd != null && isRelativePath(command.path)
    ? quotePosixArg(command.cwd + "/") + settingText
    : settingText;
}

function isRelativePath(commandPath: string) {
  return commandPath.startsWith("./") || commandPath.startsWith("../");
}

function quotePosixArg(arg: string) {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function quoteWindowsArg(arg: string) {
  // file paths on Windows can't contain a double quote, so there's nothing to escape
  return `"${arg}"`;
}
