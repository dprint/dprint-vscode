import * as assert from "node:assert";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { HttpsTextDownloader, RacyCacheTextDownloader, type TextDownloader } from "./TextDownloader";

describe("HttpsTextDownloader", () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    const currentServer = server;
    server = undefined;
    if (currentServer != null) {
      await new Promise<void>(resolve => {
        currentServer.close(() => resolve());
        // some of the tests leave a connection hanging
        currentServer.closeAllConnections();
      });
    }
  });

  it("resolves the body of a successful response", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{ \"title\": ");
      res.end("\"dprint ✓\" }");
    });

    assert.strictEqual(await createDownloader().get(url), "{ \"title\": \"dprint ✓\" }");
  });

  it("decodes a character that is split between two chunks", async () => {
    const text = "{ \"title\": \"dprint ✓\" }";
    const bytes = Buffer.from(text, "utf8");
    // one byte into the three byte check mark
    const splitIndex = bytes.indexOf(Buffer.from("✓", "utf8")) + 1;
    const url = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // wait for the first part to be sent so the two parts can't arrive together
      res.write(bytes.subarray(0, splitIndex), () => res.end(bytes.subarray(splitIndex)));
    });

    assert.strictEqual(await createDownloader().get(url), text);
  });

  it("rejects on a server error", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(503);
      res.end("{ \"message\": \"Service unavailable\" }");
    });

    await assert.rejects(createDownloader().get(url), /status code 503/);
  });

  it("rejects when rate limited", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(429);
      res.end("Too many requests");
    });

    await assert.rejects(createDownloader().get(url), /status code 429/);
  });

  it("follows redirects", async () => {
    const paths: (string | undefined)[] = [];
    const url = await serve((req, res) => {
      paths.push(req.url);
      if (req.url === "/schema.json") {
        res.writeHead(302, { location: "/asset/schema.json" });
        res.end("Found");
      } else if (req.url === "/asset/schema.json") {
        // an absolute url
        res.writeHead(307, { location: new URL("/final.json", `http://${req.headers.host}`).href });
        res.end();
      } else {
        res.writeHead(200);
        res.end("{}");
      }
    });

    assert.strictEqual(await createDownloader().get(url), "{}");
    assert.deepStrictEqual(paths, ["/schema.json", "/asset/schema.json", "/final.json"]);
  });

  it("rejects when redirected too many times", async () => {
    let requestCount = 0;
    const url = await serve((_req, res) => {
      requestCount++;
      res.writeHead(302, { location: "/schema.json" });
      res.end();
    });

    await assert.rejects(createDownloader().get(url), /too many redirects/);
    assert.strictEqual(requestCount, 6);
  });

  it("rejects when redirected to another protocol", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(302, { location: "https://127.0.0.1/schema.json" });
      res.end();
    });

    await assert.rejects(createDownloader().get(url), /redirected to another protocol: https:/);
  });

  it("rejects on the status code of the response it was redirected to", async () => {
    const url = await serve((req, res) => {
      if (req.url === "/schema.json") {
        res.writeHead(301, { location: "/missing.json" });
      } else {
        res.writeHead(404);
      }
      res.end();
    });

    await assert.rejects(createDownloader().get(url), /missing\.json \(status code 404\)/);
  });

  it("rejects on a redirect status code without a location", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(302);
      res.end();
    });

    await assert.rejects(createDownloader().get(url), /status code 302/);
  });

  it("rejects when a redirect takes longer than the timeout", async () => {
    const url = await serve((req, res) => {
      if (req.url === "/schema.json") {
        res.writeHead(302, { location: "/slow.json" });
        res.end();
      }
      // otherwise leave the request hanging
    });

    await assert.rejects(createDownloader({ timeoutMs: 100 }).get(url), /Timed out after 100ms/);
  });

  it("rejects when the server never responds", async () => {
    const url = await serve(() => {
      // leave the request hanging
    });

    await assert.rejects(createDownloader({ timeoutMs: 100 }).get(url), /Timed out after 100ms/);
  });

  it("rejects when the response stalls part way through the body", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200);
      res.write("{ \"title\": ");
    });

    await assert.rejects(createDownloader({ timeoutMs: 100 }).get(url), /Timed out after 100ms/);
  });

  it("rejects when the connection is lost part way through the body", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("{ \"title\": ", () => res.destroy());
    });

    await assert.rejects(createDownloader().get(url));
  });

  it("rejects when the connection fails", async () => {
    const url = await serve(() => {});
    const currentServer = server!;
    server = undefined;
    await new Promise<void>(resolve => currentServer.close(() => resolve()));

    await assert.rejects(createDownloader().get(url));
  });

  function createDownloader(options: { timeoutMs?: number } = {}) {
    // the test server doesn't have a certificate, so use http instead
    return new HttpsTextDownloader({ ...options, request: http.get });
  }

  async function serve(handler: http.RequestListener) {
    const newServer = http.createServer(handler);
    server = newServer;
    await new Promise<void>(resolve => newServer.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(newServer.address() as AddressInfo).port}/schema.json`;
  }
});

describe("RacyCacheTextDownloader", () => {
  const url = "https://dprint.dev/schemas/v0.json";

  it("caches a downloaded text", async () => {
    const inner = new TestTextDownloader(["first", "second"]);
    const downloader = new RacyCacheTextDownloader(inner);

    assert.strictEqual(await downloader.get(url), "first");
    assert.strictEqual(await downloader.get(url), "first");
    assert.deepStrictEqual(inner.urls, [url]);
  });

  it("does not cache a failed download", async () => {
    const inner = new TestTextDownloader([new Error("Service unavailable"), "second"]);
    const downloader = new RacyCacheTextDownloader(inner);

    await assert.rejects(downloader.get(url), /Service unavailable/);
    assert.strictEqual(await downloader.get(url), "second");
    assert.strictEqual(await downloader.get(url), "second");
    assert.deepStrictEqual(inner.urls, [url, url]);
  });

  it("downloads again after a text is forgotten", async () => {
    const inner = new TestTextDownloader(["first", "second"]);
    const downloader = new RacyCacheTextDownloader(inner);

    assert.strictEqual(await downloader.get(url), "first");
    downloader.forget(url);
    assert.strictEqual(await downloader.get(url), "second");
    assert.deepStrictEqual(inner.urls, [url, url]);
  });
});

class TestTextDownloader implements TextDownloader {
  readonly urls: string[] = [];
  #results: (string | Error)[];

  constructor(results: (string | Error)[]) {
    this.#results = results;
  }

  async get(url: string) {
    this.urls.push(url);
    const result = this.#results.shift();
    if (result == null) {
      throw new Error("No more results.");
    }
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }
}
