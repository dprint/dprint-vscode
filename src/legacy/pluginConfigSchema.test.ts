import * as assert from "node:assert";
import { describe, it } from "node:test";
import { defaultPluginConfigSchema, getPluginConfigSchema } from "./pluginConfigSchema";

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
