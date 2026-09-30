import * as assert from "node:assert";
import { describe, it } from "node:test";
import { defaultPluginConfigSchema, getPluginConfigSchema } from "./pluginConfigSchema";

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
