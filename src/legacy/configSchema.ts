import type { RacyCacheTextDownloader } from "../utils/TextDownloader";
import { defaultPluginConfigSchema } from "./pluginConfigSchema";

/**
 * Downloads and parses the config schema.
 *
 * Fails when the downloaded text is not a JSON object, in which case the text
 * is removed from the cache so that it's downloaded again the next time.
 */
export async function downloadConfigSchema(
  downloader: RacyCacheTextDownloader,
  url: string,
): Promise<{ [key: string]: any }> {
  const text = await downloader.get(url);
  try {
    const schema: unknown = JSON.parse(text);
    if (schema == null || typeof schema !== "object" || Array.isArray(schema)) {
      throw new Error(`Expected the config schema to be an object, but found: ${text.substring(0, 100)}`);
    }
    return schema;
  } catch (err) {
    // ex. the page of a captive portal, which would otherwise be used for the rest of the session
    downloader.forget(url);
    throw err;
  }
}

/**
 * Gets the schema to use for a config file when the CLI's schema is not available.
 *
 * This should have the properties of the schema embedded in the CLI.
 */
export function getDefaultConfigSchema(id: string) {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: id,
    title: "dprint configuration file",
    description: "Schema for a dprint configuration file.",
    type: "object",
    properties: {
      $schema: {
        description:
          "The JSON schema reference. Normally you shouldn't bother to provide this as the dprint vscode editor extension will handle constructing the schema for you based on the plugins provided.",
        type: "string",
      },
      incremental: {
        description: "Whether to format files only when they change.",
        type: "boolean",
        default: true,
      },
      inherit: {
        description:
          "For a nested (directory specific) configuration file, whether to inherit the plugins and configuration of the ancestor configuration file. Has no effect on a root configuration file.",
        type: "boolean",
        default: false,
      },
      extends: {
        description: "Configurations to extend.",
        anyOf: [{
          description: "A file path or url to a configuration file to extend.",
          type: "string",
        }, {
          description: "A collection of file paths and/or urls to configuration files to extend.",
          type: "array",
          items: {
            type: "string",
          },
        }],
      },
      lineWidth: {
        description:
          "The width of a line the printer will try to stay under. Note that the printer may exceed this width in certain cases.",
        type: "number",
        default: 120,
      },
      indentWidth: {
        description: "The number of characters for an indent.",
        type: "number",
        default: 4,
      },
      useTabs: {
        description: "Whether to use tabs (true) or spaces (false) for indentation.",
        type: "boolean",
        default: false,
      },
      newLineKind: {
        description: "The kind of newline to use.",
        type: "string",
        oneOf: [{
          const: "auto",
          description: "For each file, uses the newline kind found at the end of the last line.",
        }, {
          const: "crlf",
          description: "Uses carriage return, line feed.",
        }, {
          const: "lf",
          description: "Uses line feed.",
        }, {
          const: "system",
          description: "Uses the system standard (ex. crlf on Windows).",
        }],
      },
      includes: {
        description: "Array of patterns (globs) to use to find files to format.",
        type: "array",
        items: {
          type: "string",
        },
      },
      excludes: {
        description: "Array of patterns (globs) to exclude files or directories to format.",
        type: "array",
        items: {
          type: "string",
        },
      },
      shebangs: {
        description:
          "Maps a shebang line (ex. \"#!/usr/bin/env bash\") to a file extension so extensionless scripts can be routed to a plugin.",
        type: "object",
        propertyNames: {
          pattern: "^#!",
        },
        additionalProperties: {
          description: "The file extension to treat matching files as (ex. \"sh\" or \".sh\").",
          type: "string",
        },
      },
      plugins: {
        description: "Array of plugin URLs to format files.",
        type: "array",
        items: {
          type: "string",
        },
      },
    },
    additionalProperties: defaultPluginConfigSchema,
    allowTrailingCommas: true,
  };
}
