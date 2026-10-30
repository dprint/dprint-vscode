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
  });

  it("isn't supported when the server uses a version the extension didn't say it supports", () => {
    assert.strictEqual(
      "error" in getServerSupport({
        capabilities: { experimental: { dprint: { version: 2 } } },
        serverInfo: { name: "dprint", version: "0.70.0" },
      }),
      true,
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

  it("uses what dprint says to tell the user when it doesn't support the extension's versions", () => {
    assert.deepStrictEqual(
      getServerSupport({
        capabilities: { experimental: { dprint: { versions: [2], message: "Update the extension." } } },
      }),
      { error: "Update the extension.", isUnavailable: false, isVersionMismatch: true },
    );
  });

  it("says what to update when the server doesn't support the extension's versions", () => {
    const result = (versions: number[]) => ({
      capabilities: { experimental: { dprint: { versions } } },
      serverInfo: { name: "dprint", version: "1.0.0" },
    });
    assert.deepStrictEqual(getServerSupport(result([2])), {
      error: "dprint 1.0.0 doesn't support the versions of the dprint methods that the extension does. "
        + "Update the dprint extension to use it.",
      isUnavailable: false,
      isVersionMismatch: true,
    });
    assert.deepStrictEqual(getServerSupport(result([0])), {
      error: "dprint 1.0.0 doesn't support the versions of the dprint methods that the extension does. "
        + "Update dprint to use it with this version of the extension.",
      isUnavailable: false,
      isVersionMismatch: true,
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
