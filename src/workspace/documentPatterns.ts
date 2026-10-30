import type { ConfigInfoResult } from "./messages";

// note: this file should not import "vscode" so that it can be unit tested

/** The glob that matches every file. */
export const ALL_FILES_PATTERN = "**/*";

/**
 * Gets the glob patterns of the files in a config file's directory that it may format, which
 * are the ones its plugins format by their file extension or file name. This is a superset of
 * what it formats because the config file's includes and excludes are left out, which are
 * matched differently than a glob (ex. like a gitignore file).
 *
 * It's every file when the config file formats other files that can't be matched with a glob
 * (ex. with the associations of a plugin or a shebang), and none when it has no plugins or
 * they aren't known (ex. something needs to be approved), so that the other formatters of
 * those files are still used.
 */
export function getConfigFilePatterns(
  info: Pick<ConfigInfoResult, "plugins" | "formatsOtherFiles" | "filePatterns">,
): string[] {
  if (info.plugins == null || info.plugins.length === 0) {
    return [];
  }
  if (info.formatsOtherFiles) {
    return [ALL_FILES_PATTERN];
  }
  // dprint provides them when it's a version that does
  if (info.filePatterns != null) {
    return info.filePatterns;
  }
  const extensions = new Set(info.plugins.flatMap(plugin => plugin.fileExtensions).map(ext => ext.toLowerCase()));
  const fileNames = new Set(info.plugins.flatMap(plugin => plugin.fileNames).map(name => name.toLowerCase()));
  if ([...extensions, ...fileNames].some(value => value.length === 0 || /[\\/*?[\]{},!]/.test(value))) {
    return [ALL_FILES_PATTERN];
  }
  const patterns: string[] = [];
  if (extensions.size > 0) {
    patterns.push(`**/*.${getAlternatives([...extensions])}`);
  }
  if (fileNames.size > 0) {
    patterns.push(`**/${getAlternatives([...fileNames])}`);
  }
  return patterns;
}

/** Gets a glob that matches any of the values ignoring their case, like dprint does. */
function getAlternatives(values: string[]) {
  const patterns = values.sort().map(getCaseInsensitivePattern);
  return patterns.length === 1 ? patterns[0] : `{${patterns.join(",")}}`;
}

function getCaseInsensitivePattern(value: string) {
  return [...value].map(c => {
    const upper = c.toUpperCase();
    return upper === c ? c : `[${c}${upper}]`;
  }).join("");
}
