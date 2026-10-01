import * as path from "node:path";
import { FILE_SCHEME, NOTEBOOK_CELL_SCHEME, UNTITLED_SCHEME, USER_DATA_SCHEME } from "./constants";
import { getNoConfigMessage } from "./legacy/noConfigMessage";

// note: this file should not import "vscode" so that it can be unit tested

/** The parts of a document used for deciding if the global config commands apply to it. */
export interface GlobalConfigCommandDocument {
  scheme: string;
  fsPath: string;
  /** The notebook's uri when the document is a notebook cell and its notebook is open. */
  notebook?: { scheme: string; fsPath: string };
}

export interface GlobalConfigCommandEnvironment {
  /** The directory untitled documents are formatted in (the first workspace folder or the home directory). */
  untitledDirPath: string | undefined;
  /** Whether the extension runs on a remote machine. */
  isRemote: boolean;
  /** Finds the config file in the directory or its closest ancestor directory. */
  findAncestorConfigFile(dirPath: string): Promise<string | undefined>;
}

/** Why an explicitly run format command didn't format the document. */
export type NotFormattedReason =
  /** A file path to format the document as couldn't be determined (ex. an untitled document in an unknown language). */
  | "noFilePath"
  /** There's no config file in an ancestor directory and no global config file. */
  | "noConfigFile"
  /** The config file's includes and excludes don't match the file. */
  | "notMatched"
  /** The config file has no plugins. */
  | "noPlugins"
  /**
   * Nothing changed and none of the config file's plugins handle the file's name or extension. The
   * extension doesn't know the config file's associations and shebangs or the file's shebang, so a
   * plugin may still have formatted it.
   */
  | "noPlugin"
  /**
   * None of the config file's plugins handle the notebook cell's notebook file or the file the cell
   * is formatted as based on its language. The extension doesn't format a cell in that case.
   */
  | "noCellPlugin"
  /** Starting dprint or formatting failed, which is logged. */
  | "failed";

/**
 * Gets if the commands to format using the global config file should be shown for
 * the document, which is when it's a document the extension can format that has no
 * config file in an ancestor directory. This isn't based on the setting to always use
 * the global config file because that only makes dprint a formatter for the languages
 * it's the default formatter of, so the commands are still needed for other languages.
 */
export async function canFormatWithGlobalConfig(
  document: GlobalConfigCommandDocument | undefined,
  env: GlobalConfigCommandEnvironment,
) {
  const dirPath = document == null ? undefined : getFormatDirPath(document, env);
  return dirPath != null && await env.findAncestorConfigFile(dirPath) == null;
}

/** Gets the message to show when an explicitly run format command didn't format the document. */
export function getNotFormattedMessage(reason: NotFormattedReason) {
  switch (reason) {
    case "noFilePath":
      return "dprint could not determine a file path to format this document as, which it needs to select a plugin "
        + "(ex. it's an untitled document in a language without a file extension or a cell of an unsaved notebook).";
    case "noConfigFile":
      return getNoConfigMessage({ useGlobalConfig: true, hasGlobalConfig: false });
    case "notMatched":
      return "dprint did not format this document because the \"includes\" and \"excludes\" of the "
        + "configuration file in use don't match it.";
    case "noPlugins":
      return "dprint did not format this document because the configuration file in use has no plugins.";
    case "noPlugin":
      return "dprint did not change this document. No plugin in the configuration file in use handles its file name "
        + "or extension, so it's only formatted when the \"associations\" or \"shebangs\" of the configuration "
        + "file match it to a plugin.";
    case "noCellPlugin":
      return "dprint did not format this notebook cell. A cell is only formatted when the plugins in the "
        + "configuration file in use handle both the notebook file (ex. the jupyter plugin) and the cell's language.";
    case "failed":
      return "dprint failed to format this document. See the dprint output for details.";
  }
}

/**
 * Gets the directory of the file the document is formatted as, which is where the search for
 * its config file starts, or undefined when it's not a document the extension can format. This
 * needs to be kept in sync with how the backend resolves the file (see `WorkspaceService`).
 */
function getFormatDirPath(document: GlobalConfigCommandDocument, env: GlobalConfigCommandEnvironment) {
  switch (document.scheme) {
    case FILE_SCHEME:
      return path.dirname(document.fsPath);
    case USER_DATA_SCHEME:
      // the user data files are on the local machine, so they can't be formatted from a remote extension host
      return env.isRemote ? undefined : path.dirname(document.fsPath);
    case UNTITLED_SCHEME:
      return env.untitledDirPath;
    case NOTEBOOK_CELL_SCHEME:
      // only the cells of notebooks on the file system are formatted
      return document.notebook?.scheme === FILE_SCHEME ? path.dirname(document.notebook.fsPath) : undefined;
    default:
      return undefined;
  }
}
