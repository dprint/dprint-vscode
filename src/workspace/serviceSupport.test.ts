import * as assert from "node:assert";
import { describe, it } from "node:test";
import { getUnsupportedError, isUnsupportedService, type UnsupportedService } from "./serviceSupport";

describe("getUnsupportedError", () => {
  const supported = { connection: "connection" };
  const unsupported: UnsupportedService = { error: "dprint 0.50.0 doesn't support it.", isUnavailable: false };
  const unavailable: UnsupportedService = { error: "dprint isn't installed.", isUnavailable: true };

  it("is undefined when every executable supports it", () => {
    assert.strictEqual(getUnsupportedError([supported, supported], supported), undefined);
    assert.strictEqual(getUnsupportedError([], supported), undefined);
  });

  it("is the error of an executable of a config file that doesn't support it or can't run", () => {
    assert.strictEqual(getUnsupportedError([supported, unsupported], supported), unsupported.error);
    assert.strictEqual(getUnsupportedError([unavailable, supported], supported), unavailable.error);
  });

  it("is the error of the default executable when it's a version that doesn't support it", () => {
    // otherwise the files without a config file in the workspace wouldn't be formatted
    assert.strictEqual(getUnsupportedError([supported], unsupported), unsupported.error);
    assert.strictEqual(getUnsupportedError([], unsupported), unsupported.error);
  });

  it("ignores a default executable that can't run unless there's nothing else to format with", () => {
    assert.strictEqual(getUnsupportedError([supported], unavailable), undefined);
    assert.strictEqual(getUnsupportedError([], unavailable), unavailable.error);
  });
});

describe("isUnsupportedService", () => {
  it("is true for an error", () => {
    assert.strictEqual(isUnsupportedService({ error: "error", isUnavailable: false }), true);
    assert.strictEqual(isUnsupportedService({ connection: "connection" }), false);
  });
});
