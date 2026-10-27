import * as assert from "node:assert";
import { describe, it } from "node:test";
import { defaultPluginConfigSchema, getDefaultConfigSchema } from "./configSchema";

describe("getDefaultConfigSchema", () => {
  const schema = getDefaultConfigSchema("dprint://schemas/config.json");

  it("uses the provided id", () => {
    assert.strictEqual(schema.$id, "dprint://schemas/config.json");
  });

  it("has the properties the cli handles itself", () => {
    // these are the properties the cli takes out of the config before
    // treating what remains as plugin configuration
    assert.deepStrictEqual(Object.keys(schema.properties).sort(), [
      "$schema",
      "excludes",
      "extends",
      "includes",
      "incremental",
      "indentWidth",
      "inherit",
      "lineWidth",
      "newLineKind",
      "plugins",
      "shebangs",
      "useTabs",
    ]);
  });

  it("accepts a boolean for inherit", () => {
    assert.strictEqual(schema.properties.inherit.type, "boolean");
  });

  it("maps shebang lines to file extensions", () => {
    assert.deepStrictEqual(schema.properties.shebangs.propertyNames, { pattern: "^#!" });
    assert.strictEqual(schema.properties.shebangs.additionalProperties.type, "string");
  });

  it("treats the other properties as plugin configuration", () => {
    assert.strictEqual(schema.additionalProperties, defaultPluginConfigSchema);
  });

  it("returns a new object each time because the caller modifies it", () => {
    assert.notStrictEqual(getDefaultConfigSchema("id"), getDefaultConfigSchema("id"));
    assert.notStrictEqual(getDefaultConfigSchema("id").properties, getDefaultConfigSchema("id").properties);
  });
});

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
