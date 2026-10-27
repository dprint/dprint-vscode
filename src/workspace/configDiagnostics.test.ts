import * as assert from "node:assert";
import { describe, it } from "node:test";
import { getConfigDiagnosticMessage, getConfigDiagnosticRange } from "./configDiagnostics";

describe("getConfigDiagnosticMessage", () => {
  it("includes the plugin and property when there are ones", () => {
    assert.strictEqual(
      getConfigDiagnosticMessage({
        pluginName: "typescript",
        propertyName: "lineWidth",
        message: "Expected a number.",
      }),
      "[typescript]: Expected a number. (lineWidth)",
    );
    assert.strictEqual(
      getConfigDiagnosticMessage({ propertyName: "lineWidth", message: "Unknown property." }),
      "Unknown property. (lineWidth)",
    );
    assert.strictEqual(getConfigDiagnosticMessage({ message: "Unexpected token." }), "Unexpected token.");
  });
});

describe("getConfigDiagnosticRange", () => {
  it("is the start of the file when the range isn't known", () => {
    const range = { start: { line: 2, character: 4 }, end: { line: 2, character: 15 } };
    assert.deepStrictEqual(getConfigDiagnosticRange({ message: "Message.", range }), range);
    assert.deepStrictEqual(getConfigDiagnosticRange({ message: "Message." }), {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    });
  });
});
