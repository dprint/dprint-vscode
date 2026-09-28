import * as path from "node:path";

// note: this file should not import "vscode" so that it can be unit tested

/** The files a plugin handles (a subset of the plugin info from `dprint editor-info`). */
export interface PluginFileInfo {
  fileExtensions: readonly string[];
  fileNames: readonly string[];
}

/**
 * Gets if one of the plugins handles the file based on its file name or
 * extension. This mirrors how the dprint CLI resolves plugins for a file
 * path, except for config associations, which aren't known to the extension.
 */
export function hasPluginForFile(
  plugins: readonly PluginFileInfo[],
  filePath: string,
) {
  const fileName = path.basename(filePath).toLowerCase();
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return plugins.some(plugin =>
    plugin.fileNames.some(name => name.toLowerCase() === fileName)
    || (extension.length > 0 && plugin.fileExtensions.some(ext => ext.toLowerCase() === extension))
  );
}
