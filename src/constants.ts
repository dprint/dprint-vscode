export const DPRINT_CONFIG_FILE_NAME_GLOB = "{dprint,.dprint}.{json,jsonc}";
export const DPRINT_CONFIG_FILEPATH_GLOB = `**/${DPRINT_CONFIG_FILE_NAME_GLOB}`;
export const DPRINT_CONFIG_FILE_NAMES = ["dprint.json", "dprint.jsonc", ".dprint.json", ".dprint.jsonc"];
/**
 * The directory a config file may be put in instead of the directory it applies to
 * (ex. `.config/dprint.json`), which the cli treats as part of its parent directory.
 */
export const DOT_CONFIG_DIR_NAME = ".config";
/** The config file names the cli searches for within a `.config` directory. */
export const DOT_CONFIG_FILE_NAMES = ["dprint.json", "dprint.jsonc"];
/** Matches the config files the cli searches for in a directory, including in its `.config` directory. */
export const DPRINT_DIR_CONFIG_FILE_GLOB =
  "{dprint.json,dprint.jsonc,.dprint.json,.dprint.jsonc,.config/dprint.json,.config/dprint.jsonc}";
export const DPRINT_EXTENSION_ID = "dprint.dprint";
/** The scheme of documents on the file system. */
export const FILE_SCHEME = "file";
/** The scheme of unsaved new documents. */
export const UNTITLED_SCHEME = "untitled";
/** The scheme of notebook cell documents. */
export const NOTEBOOK_CELL_SCHEME = "vscode-notebook-cell";
/** The scheme of user data files such as the user settings.json. */
export const USER_DATA_SCHEME = "vscode-userdata";
/** The notebook type of jupyter notebooks (.ipynb files). */
export const JUPYTER_NOTEBOOK_TYPE = "jupyter-notebook";

/** Gets if the value (ex. an `editor.defaultFormatter` setting) is this extension's id. */
export function isDprintExtensionId(value: unknown) {
  // extension ids are case insensitive
  return typeof value === "string" && value.toLowerCase() === DPRINT_EXTENSION_ID;
}
