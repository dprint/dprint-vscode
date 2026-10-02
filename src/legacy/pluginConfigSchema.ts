const pluginConfigOverrideSchema = {
  type: "object",
  required: ["files"],
  minProperties: 2,
  properties: {
    files: {
      description: "File patterns this override applies to.",
      anyOf: [{
        type: "string",
      }, {
        type: "array",
        minItems: 1,
        items: {
          type: "string",
        },
      }],
    },
  },
};

/** Schema for the properties the CLI accepts in every plugin's configuration. */
export const defaultPluginConfigSchema = {
  description: "Plugin configuration.",
  type: "object",
  properties: {
    locked: {
      description: "Whether this plugin configuration is locked against overrides from extending configurations.",
      type: "boolean",
    },
    associations: {
      description:
        "File patterns to associate with this plugin, in addition to the file extensions and file names it matches by default. Use a negated glob (ex. \"!**/*.js\") to stop matching a default extension or file name.",
      anyOf: [{
        type: "string",
      }, {
        type: "array",
        items: {
          type: "string",
        },
      }],
    },
    overrides: {
      description: "Plugin configuration overrides for specific file patterns.",
      anyOf: [pluginConfigOverrideSchema, {
        type: "array",
        items: pluginConfigOverrideSchema,
      }],
    },
  },
};

/**
 * Gets the schema for a plugin's configuration property.
 *
 * Combines the plugin's schema with the CLI's schema for plugin configuration
 * (the config schema's `additionalProperties`) so that properties the CLI handles
 * for every plugin, such as `associations` and `locked`, are still provided.
 */
export function getPluginConfigSchema(pluginSchemaUri: string, cliPluginConfigSchema: unknown): object {
  const pluginSchema = { $ref: pluginSchemaUri };
  if (cliPluginConfigSchema == null || typeof cliPluginConfigSchema !== "object") {
    return pluginSchema;
  }
  return { allOf: [pluginSchema, cliPluginConfigSchema] };
}

/**
 * Gets the url of each plugin's schema by the plugin's config key.
 *
 * Between workspace folders, the same plugin might appear with a different version.
 * The first one found is the one used.
 */
export function getPluginSchemaUrls(
  pluginsByFolder: Iterable<Iterable<{ configKey: string; configSchemaUrl: string | undefined }>>,
): Map<string, string> {
  const urls = new Map<string, string>();
  for (const plugins of pluginsByFolder) {
    for (const plugin of plugins) {
      if (plugin.configSchemaUrl != null && !urls.has(plugin.configKey)) {
        urls.set(plugin.configKey, plugin.configSchemaUrl);
      }
    }
  }
  return urls;
}

/**
 * Gets the uri that the extension provides a plugin's schema at.
 *
 * vscode only downloads schemas from the domains the user trusts, so the config
 * schema references these instead of the urls of the plugin schemas, which the
 * extension then downloads itself. The uri has the plugin's config key instead of
 * the url of its schema so that a uri can't be used to download from any url.
 */
export function getPluginSchemaUri(configKey: string) {
  return `dprint://schemas${PLUGIN_SCHEMA_PATH_PREFIX}${encodeURIComponent(configKey)}${PLUGIN_SCHEMA_PATH_SUFFIX}`;
}

/** Gets the plugin's config key from the decoded path of a uri from `getPluginSchemaUri`. */
export function getPluginSchemaUriConfigKey(uriPath: string): string | undefined {
  const keyLength = uriPath.length - PLUGIN_SCHEMA_PATH_PREFIX.length - PLUGIN_SCHEMA_PATH_SUFFIX.length;
  if (
    keyLength <= 0 || !uriPath.startsWith(PLUGIN_SCHEMA_PATH_PREFIX) || !uriPath.endsWith(PLUGIN_SCHEMA_PATH_SUFFIX)
  ) {
    return undefined;
  }
  return uriPath.substring(PLUGIN_SCHEMA_PATH_PREFIX.length, PLUGIN_SCHEMA_PATH_PREFIX.length + keyLength);
}

const PLUGIN_SCHEMA_PATH_PREFIX = "/plugins/";
const PLUGIN_SCHEMA_PATH_SUFFIX = ".json";
