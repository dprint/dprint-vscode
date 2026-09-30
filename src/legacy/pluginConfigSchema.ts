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
  },
};

/**
 * Gets the schema for a plugin's configuration property.
 *
 * Combines the plugin's schema with the CLI's schema for plugin configuration
 * (the config schema's `additionalProperties`) so that properties the CLI handles
 * for every plugin, such as `associations` and `locked`, are still provided.
 */
export function getPluginConfigSchema(pluginSchemaUrl: string, cliPluginConfigSchema: unknown): object {
  const pluginSchema = { $ref: pluginSchemaUrl };
  if (cliPluginConfigSchema == null || typeof cliPluginConfigSchema !== "object") {
    return pluginSchema;
  }
  return { allOf: [pluginSchema, cliPluginConfigSchema] };
}
