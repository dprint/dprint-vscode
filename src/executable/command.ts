// note: this file should not import "vscode" so that it can be unit tested

import * as path from "node:path";

/**
 * The dprint executable to launch.
 *
 * A `dprint.path` setting is interpreted by the shell (ex. `$HOME/bin/dprint`),
 * which is fine because it's from the user's settings or they approved it. Other
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

/** Gets the text to display for the command. */
export function getCommandDisplayText(command: DprintCommand) {
  return command.kind === "setting" && command.cwd != null && isRelativePath(command.path)
    ? path.join(command.cwd, command.path)
    : command.path;
}

/**
 * Gets how to launch a command so that its arguments are passed as-is.
 *
 * On Windows, a shell is used so that commands such as an npm `dprint.cmd` resolve
 * (see https://github.com/denoland/vscode_deno/issues/361), so the command and its
 * quoted arguments are provided as a single command line. Elsewhere, a shell is only
 * used for a `dprint.path` setting and the arguments are quoted so it doesn't
 * interpret them.
 */
export function getCommandLaunchInfo(
  command: DprintCommand,
  args: string[],
  platform: NodeJS.Platform,
): CommandLaunchInfo {
  if (platform === "win32") {
    const commandPath = command.kind === "setting" && command.cwd != null && isRelativePath(command.path)
      ? path.win32.join(command.cwd, command.path)
      : command.path;
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
