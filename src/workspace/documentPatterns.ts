import { type ConfigInfoResult, getNotFormatted } from "./messages";

// note: this file should not import "vscode" so that it can be unit tested

/** The glob that matches every file. */
export const ALL_FILES_PATTERN = "**/*";

/**
 * Gets the glob patterns of the files in a config file's directory that it may format, which
 * dprint provides. This is a superset of what it formats because the config file's includes and
 * excludes are left out, which are matched differently than a glob (ex. like a gitignore file).
 *
 * It's every file when the config file formats other files that can't be matched with a glob
 * (ex. with a shebang), and none when it has no plugins, they aren't known (ex. something
 * needs to be approved), or dprint says not to claim its files (ex. what needs to be approved
 * was denied), so that the other formatters of those files are still used.
 */
export function getConfigFilePatterns(
  info: Pick<ConfigInfoResult, "plugins" | "otherFiles" | "filePatterns" | "status">,
): string[] {
  if (info.plugins == null || info.plugins.length === 0 || getNotFormatted(info.status)?.claim === false) {
    return [];
  }
  if (info.otherFiles.length > 0) {
    return [ALL_FILES_PATTERN];
  }
  return info.filePatterns.map(pattern => pattern.glob);
}
