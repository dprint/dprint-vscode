import type { NotFormattedReason } from "../globalConfigCommand";

// note: this file should not import "vscode" so that it can be unit tested

/** The file dprint formats a document as. */
export interface FormatFile {
  /**
   * The file path to format the document's text as, which differs from the document's
   * for documents that aren't on the file system (ex. untitled documents and notebook cells).
   */
  filePath: string;
  /** The notebook file's path when the document is a notebook cell. */
  notebookPath?: string;
}

/** What's known about the files the config file in use formats. */
export interface FormatFileChecker {
  /** Gets if one of the plugins handles the file based on its file name or extension. */
  hasPluginForFile(filePath: string): boolean;
  /** Asks the cli if it formats the file, which only checks the config file's includes and excludes. */
  canFormat(filePath: string): Promise<boolean>;
}

/**
 * Gets why the file won't be formatted, or undefined when dprint should be asked to format it
 * (it may still not have a plugin for the file, which is only known from the cli not changing it).
 */
export async function getCannotFormatReason(
  file: FormatFile,
  checker: FormatFileChecker,
): Promise<NotFormattedReason | undefined> {
  if (file.notebookPath == null) {
    return await checker.canFormat(file.filePath) ? undefined : "notMatched";
  }
  // The cli formats a notebook's cells when a plugin (the jupyter plugin) formats
  // the notebook, so only format a cell when the notebook would be formatted.
  if (!checker.hasPluginForFile(file.notebookPath) || !checker.hasPluginForFile(file.filePath)) {
    return "noCellPlugin";
  }
  return await checker.canFormat(file.notebookPath) ? undefined : "notMatched";
}
