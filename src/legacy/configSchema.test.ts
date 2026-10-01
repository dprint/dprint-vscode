import * as assert from "node:assert";
import { describe, it } from "node:test";
import { RacyCacheTextDownloader, type TextDownloader } from "../utils/TextDownloader";
import { downloadConfigSchema, getDefaultConfigSchema } from "./configSchema";
import { defaultPluginConfigSchema } from "./pluginConfigSchema";

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

describe("downloadConfigSchema", () => {
  const url = "https://dprint.dev/schemas/v0.json";

  it("parses the downloaded schema", async () => {
    const { downloader } = createDownloader(["{ \"title\": \"dprint configuration file\" }"]);

    assert.deepStrictEqual(await downloadConfigSchema(downloader, url), { title: "dprint configuration file" });
  });

  it("provides a new object each time because the caller modifies it", async () => {
    const { downloader, urls } = createDownloader(["{ \"properties\": {} }"]);

    const first = await downloadConfigSchema(downloader, url);
    first.properties.typescript = {};

    assert.deepStrictEqual(await downloadConfigSchema(downloader, url), { properties: {} });
    assert.deepStrictEqual(urls, [url]);
  });

  it("fails and downloads again the next time when the text is not JSON", async () => {
    const { downloader, urls } = createDownloader([
      "<html>Sign in to the network</html>",
      "{ \"title\": \"dprint configuration file\" }",
    ]);

    await assert.rejects(downloadConfigSchema(downloader, url), SyntaxError);
    assert.deepStrictEqual(await downloadConfigSchema(downloader, url), { title: "dprint configuration file" });
    assert.deepStrictEqual(urls, [url, url]);
  });

  it("fails and downloads again the next time when the JSON is not an object", async () => {
    for (const text of ["null", "\"text\"", "[]", "true", "1"]) {
      const { downloader, urls } = createDownloader([text, "{}"]);

      await assert.rejects(downloadConfigSchema(downloader, url), /Expected the config schema to be an object/);
      assert.deepStrictEqual(await downloadConfigSchema(downloader, url), {});
      assert.deepStrictEqual(urls, [url, url]);
    }
  });

  it("fails and downloads again the next time when the download fails", async () => {
    const { downloader, urls } = createDownloader([new Error("Service unavailable"), "{}"]);

    await assert.rejects(downloadConfigSchema(downloader, url), /Service unavailable/);
    assert.deepStrictEqual(await downloadConfigSchema(downloader, url), {});
    assert.deepStrictEqual(urls, [url, url]);
  });

  function createDownloader(results: (string | Error)[]) {
    const urls: string[] = [];
    const inner: TextDownloader = {
      async get(url) {
        urls.push(url);
        const result = results.shift();
        if (result == null) {
          throw new Error("No more results.");
        }
        if (result instanceof Error) {
          throw result;
        }
        return result;
      },
    };
    return { downloader: new RacyCacheTextDownloader(inner), urls };
  }
});
