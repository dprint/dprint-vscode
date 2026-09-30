// note: this file should not import "vscode" so that it can be unit tested

/** How to launch a command. */
export interface CommandLaunchInfo {
  command: string;
  args: string[];
  shell: boolean;
}

/**
 * Gets how to launch a command so that its arguments are passed as-is.
 *
 * On Windows, a shell is used so that commands such as an npm `dprint.cmd` resolve
 * (see https://github.com/denoland/vscode_deno/issues/361), so the command and its
 * quoted arguments are provided as a single command line. Elsewhere, a shell isn't
 * used so that the arguments aren't interpreted by it.
 */
export function getCommandLaunchInfo(command: string, args: string[], platform: NodeJS.Platform): CommandLaunchInfo {
  if (platform === "win32") {
    return {
      command: [command, ...args].map(quoteWindowsArg).join(" "),
      args: [],
      shell: true,
    };
  } else {
    return { command, args, shell: false };
  }
}

function quoteWindowsArg(arg: string) {
  // file paths on Windows can't contain a double quote, so there's nothing to escape
  return `"${arg}"`;
}
