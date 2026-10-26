import * as assert from "node:assert";
import { describe, it } from "node:test";
import {
  defaultPluginConfigSchema,
  getPluginConfigSchema,
  getPluginSchemaUri,
  getPluginSchemaUriConfigKey,
  getPluginSchemaUrls,
} from "./pluginConfigSchema";

describe("defaultPluginConfigSchema", () => {
  it("has the properties the cli handles for every plugin", () => {
    assert.deepStrictEqual(Object.keys(defaultPluginConfigSchema.properties).sort(), [
      "associations",
      "locked",
      "overrides",
    ]);
  });

  it("accepts a single override or an array of overrides that have files", () => {
    const overrideSchema = {
      type: "object",
      required: ["files"],
      minProperties: 2,
      properties: {
        files: {
          description: "File patterns this override applies to.",
          anyOf: [{ type: "string" }, { type: "array", minItems: 1, items: { type: "string" } }],
        },
      },
    };
    assert.deepStrictEqual(defaultPluginConfigSchema.properties.overrides.anyOf, [
      overrideSchema,
      { type: "array", items: overrideSchema },
    ]);
  });
});

describe("getPluginConfigSchema", () => {
  const url = "https://plugins.dprint.dev/example/schema.json";

  it("combines the plugin schema with the cli's plugin config schema", () => {
    assert.deepStrictEqual(getPluginConfigSchema(url, defaultPluginConfigSchema), {
      allOf: [{ $ref: url }, defaultPluginConfigSchema],
    });
  });

  it("only references the plugin schema when the cli's plugin config schema is not an object", () => {
    assert.deepStrictEqual(getPluginConfigSchema(url, undefined), { $ref: url });
    assert.deepStrictEqual(getPluginConfigSchema(url, true), { $ref: url });
  });
});

describe("getPluginSchemaUrls", () => {
  it("gets the schema url of each plugin by its config key", () => {
    const urls = getPluginSchemaUrls([[
      { configKey: "typescript", configSchemaUrl: "https://plugins.dprint.dev/typescript/schema.json" },
      { configKey: "json", configSchemaUrl: "https://plugins.dprint.dev/json/schema.json" },
    ]]);
    assert.deepStrictEqual([...urls], [
      ["typescript", "https://plugins.dprint.dev/typescript/schema.json"],
      ["json", "https://plugins.dprint.dev/json/schema.json"],
    ]);
  });

  it("skips plugins without a schema", () => {
    const urls = getPluginSchemaUrls([[{ configKey: "exec", configSchemaUrl: undefined }]]);
    assert.deepStrictEqual([...urls], []);
  });

  it("uses the first plugin with a schema when folders have the same plugin", () => {
    const urls = getPluginSchemaUrls([
      [{ configKey: "json", configSchemaUrl: undefined }],
      [{ configKey: "json", configSchemaUrl: "https://plugins.dprint.dev/json-1/schema.json" }],
      [{ configKey: "json", configSchemaUrl: "https://plugins.dprint.dev/json-2/schema.json" }],
    ]);
    assert.deepStrictEqual([...urls], [["json", "https://plugins.dprint.dev/json-1/schema.json"]]);
  });
});

describe("getPluginSchemaUri", () => {
  it("has the config key of the plugin", () => {
    assert.strictEqual(getPluginSchemaUri("typescript"), "dprint://schemas/plugins/typescript.json");
  });

  it("encodes the config key", () => {
    assert.strictEqual(getPluginSchemaUri("my plugin/#1?"), "dprint://schemas/plugins/my%20plugin%2F%231%3F.json");
  });
});

describe("getPluginSchemaUriConfigKey", () => {
  it("gets the config key from the path of a plugin schema uri", () => {
    for (const configKey of ["typescript", "my plugin/#1?", "a.json", "plugins", "é"]) {
      const uri = new URL(getPluginSchemaUri(configKey));
      assert.strictEqual(getPluginSchemaUriConfigKey(decodeURIComponent(uri.pathname)), configKey);
    }
  });

  it("is undefined for other paths", () => {
    for (const path of ["/config.json", "/plugins/.json", "/plugins/typescript", "/plugins.json", "", "/"]) {
      assert.strictEqual(getPluginSchemaUriConfigKey(path), undefined);
    }
  });
});
