import * as assert from "node:assert";
import { describe, it } from "node:test";
import { isDprintExtensionId } from "../../constants";

describe("isDprintExtensionId", () => {
  it("matches the extension id ignoring case", () => {
    assert.strictEqual(isDprintExtensionId("dante-marshal.dprint-vscode"), true);
    assert.strictEqual(isDprintExtensionId("Dante-Marshal.Dprint-Vscode"), true);
    assert.strictEqual(isDprintExtensionId("dprint.dprint"), false);
  });

  it("does not match other values", () => {
    assert.strictEqual(isDprintExtensionId("esbenp.prettier-vscode"), false);
    assert.strictEqual(isDprintExtensionId(undefined), false);
    assert.strictEqual(isDprintExtensionId(null), false);
  });
});
