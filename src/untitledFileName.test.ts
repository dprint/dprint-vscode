import * as assert from "node:assert";
import { describe, it } from "node:test";
import { getUntitledFileName } from "./untitledFileName";

describe("getUntitledFileName", () => {
  it("uses the language's first file extension", () => {
    const contributions = [
      { id: "typescript", extensions: [".ts", ".cts", ".mts"] },
      { id: "json", extensions: [".json", ".bowerrc"] },
    ];
    assert.strictEqual(getUntitledFileName(contributions, "json"), "Untitled.json");
    assert.strictEqual(getUntitledFileName(contributions, "typescript"), "Untitled.ts");
  });

  it("uses an extension from a later contribution for the language", () => {
    const contributions = [
      { id: "json", filenames: ["composer.lock"] },
      { id: "json", extensions: [".json"] },
    ];
    assert.strictEqual(getUntitledFileName(contributions, "json"), "Untitled.json");
  });

  it("falls back to the language's first file name", () => {
    const contributions = [{ id: "dockerfile", filenames: ["Dockerfile", "Containerfile"] }];
    assert.strictEqual(getUntitledFileName(contributions, "dockerfile"), "Dockerfile");
  });

  it("ignores extensions that aren't a dot followed by text", () => {
    const contributions = [{ id: "lang", extensions: [".", "txt"], filenames: ["lang.config"] }];
    assert.strictEqual(getUntitledFileName(contributions, "lang"), "lang.config");
  });

  it("returns undefined for an unknown language", () => {
    assert.strictEqual(getUntitledFileName([{ id: "json", extensions: [".json"] }], "other"), undefined);
    assert.strictEqual(getUntitledFileName([{ extensions: [".json"] }], "json"), undefined);
  });
});
