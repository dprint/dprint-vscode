import * as assert from "node:assert";
import { describe, it } from "node:test";
import { getUnsupportedError, isOldDprintError, isUnsupportedService, type UnsupportedService } from "./serviceSupport";

describe("getUnsupportedError", () => {
  const supported = { connection: "connection" };
  const unsupported: UnsupportedService = { error: "dprint 0.50.0 doesn't support it.", isUnavailable: false };
  const unavailable: UnsupportedService = { error: "dprint isn't installed.", isUnavailable: true };

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

describe("isUnsupportedService", () => {
  it("is true for an error", () => {
    assert.strictEqual(isUnsupportedService({ error: "error", isUnavailable: false }), true);
    assert.strictEqual(isUnsupportedService({ connection: "connection" }), false);
  });
});

describe("isOldDprintError", () => {
  it("is true when dprint doesn't know the argument or subcommand", () => {
    assert.strictEqual(isOldDprintError("error: unexpected argument '--info' found"), true);
    assert.strictEqual(isOldDprintError("error: unrecognized subcommand 'editor-service'"), true);
  });

  it("is false when dprint didn't run", () => {
    assert.strictEqual(isOldDprintError(Object.assign(new Error("spawn dprint ENOENT"), { code: "ENOENT" })), false);
    assert.strictEqual(isOldDprintError("'dprint' is not recognized as an internal or external command"), false);
  });
});
