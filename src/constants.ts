export const DPRINT_CONFIG_FILE_NAME_GLOB = "{dprint,.dprint}.{json,jsonc}";
export const DPRINT_CONFIG_FILEPATH_GLOB = `**/${DPRINT_CONFIG_FILE_NAME_GLOB}`;
export const DPRINT_CONFIG_FILE_NAMES = ["dprint.json", "dprint.jsonc", ".dprint.json", ".dprint.jsonc"];
export const DPRINT_EXTENSION_ID = "dprint.dprint";
/** The scheme of unsaved new documents. */
export const UNTITLED_SCHEME = "untitled";

/** Gets if the value (ex. an `editor.defaultFormatter` setting) is this extension's id. */
export function isDprintExtensionId(value: unknown) {
  // extension ids are case insensitive
  return typeof value === "string" && value.toLowerCase() === DPRINT_EXTENSION_ID;
}
