import * as assert from "node:assert";
import { describe, it } from "node:test";
import {
  getServerSupport,
  getUnsupportedError,
  isUnknownSubcommandError,
  isUnsupportedServer,
  type UnsupportedServer,
} from "./serverSupport";

describe("getServerSupport", () => {
  it("is the version of dprint when the server has the dprint methods", () => {
    assert.deepStrictEqual(
      getServerSupport({
        capabilities: { experimental: { dprint: { version: 1 } } },
        serverInfo: { name: "dprint", version: "0.65.0" },
      }),
      { version: "0.65.0" },
    );
    // a newer version of the methods
    assert.deepStrictEqual(
      getServerSupport({
        capabilities: { experimental: { dprint: { version: 2 } } },
        serverInfo: { name: "dprint", version: "0.70.0" },
      }),
      { version: "0.70.0" },
    );
  });

  it("is why it can't be used when the server doesn't have them", () => {
    assert.deepStrictEqual(getServerSupport({ capabilities: {}, serverInfo: { name: "dprint", version: "0.64.0" } }), {
      error: "dprint 0.64.0 doesn't support the dprint methods of its language server.",
      isUnavailable: false,
    });
    assert.deepStrictEqual(getServerSupport({ capabilities: { experimental: { dprint: {} } } }), {
      error: "dprint unknown doesn't support the dprint methods of its language server.",
      isUnavailable: false,
    });
  });
});

describe("getUnsupportedError", () => {
  const supported = { connection: "connection" };
  const unsupported: UnsupportedServer = { error: "dprint 0.50.0 doesn't support it.", isUnavailable: false };
  const unavailable: UnsupportedServer = { error: "dprint isn't installed.", isUnavailable: true };

  it("is undefined when the default executable supports it", () => {
    assert.strictEqual(getUnsupportedError(supported, true), undefined);
    assert.strictEqual(getUnsupportedError(supported, false), undefined);
  });

  it("is the error of the default executable when it's a version that doesn't support it", () => {
    // otherwise the files without a config file in the workspace wouldn't be formatted
    assert.strictEqual(getUnsupportedError(unsupported, true), unsupported.error);
    assert.strictEqual(getUnsupportedError(unsupported, false), unsupported.error);
  });

  it("ignores a default executable that can't run unless there's nothing else to format with", () => {
    assert.strictEqual(getUnsupportedError(unavailable, true), undefined);
    assert.strictEqual(getUnsupportedError(unavailable, false), unavailable.error);
  });
});

describe("isUnsupportedServer", () => {
  it("is true for an error", () => {
    assert.strictEqual(isUnsupportedServer({ error: "error", isUnavailable: false }), true);
    assert.strictEqual(isUnsupportedServer({ connection: "connection" }), false);
  });
});

describe("isUnknownSubcommandError", () => {
  it("is true when dprint doesn't know the subcommand", () => {
    assert.strictEqual(isUnknownSubcommandError("error: unrecognized subcommand 'lsp'"), true);
    assert.strictEqual(isUnknownSubcommandError("error: Found argument 'lsp' which wasn't expected"), true);
  });

  it("is false when dprint didn't run", () => {
    assert.strictEqual(
      isUnknownSubcommandError(Object.assign(new Error("spawn dprint ENOENT"), { code: "ENOENT" })),
      false,
    );
    assert.strictEqual(
      isUnknownSubcommandError("'dprint' is not recognized as an internal or external command"),
      false,
    );
  });
});
