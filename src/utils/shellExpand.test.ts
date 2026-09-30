import * as assert from "node:assert";
import { describe, it } from "node:test";
import { shellExpand } from "./shellExpand";

describe("shellExpand", () => {
  const env = { HOME: "/home/user", BIN_DIR: "/opt/bin" };

  it("expands a leading ~/", () => {
    assert.strictEqual(shellExpand("~/bin/dprint", env), "/home/user/bin/dprint");
    assert.strictEqual(shellExpand("/a/~/dprint", env), "/a/~/dprint");
  });

  it("expands environment variables", () => {
    assert.strictEqual(shellExpand("$HOME/bin/dprint", env), "/home/user/bin/dprint");
    assert.strictEqual(shellExpand("${BIN_DIR}/dprint", env), "/opt/bin/dprint");
  });

  it("leaves unknown variables and other text as-is", () => {
    assert.strictEqual(shellExpand("$UNKNOWN/dprint", env), "$UNKNOWN/dprint");
    assert.strictEqual(shellExpand("$(yarn bin dprint)", env), "$(yarn bin dprint)");
    assert.strictEqual(shellExpand("C:\\dprint.exe", env), "C:\\dprint.exe");
  });
});
