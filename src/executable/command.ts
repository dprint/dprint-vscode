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
