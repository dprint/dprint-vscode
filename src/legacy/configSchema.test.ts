import * as assert from "node:assert";
import { describe, it } from "node:test";
import { downloadConfigSchema } from "./configSchema";
import { RacyCacheTextDownloader, type TextDownloader } from "./TextDownloader";

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
