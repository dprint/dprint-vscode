import * as assert from "node:assert";
import { describe, it } from "node:test";
import { getNotebookCellFileNames, getUntitledFileNames } from "./languageFileNames";

describe("getUntitledFileNames", () => {
  it("uses the language's file extensions in order", () => {
    const contributions = [
      { id: "typescript", extensions: [".ts", ".cts", ".mts"] },
      { id: "json", extensions: [".json", ".bowerrc"] },
    ];
    assert.deepStrictEqual(getUntitledFileNames(contributions, "json"), ["Untitled.json", "Untitled.bowerrc"]);
    assert.deepStrictEqual(getUntitledFileNames(contributions, "typescript"), [
      "Untitled.ts",
      "Untitled.cts",
      "Untitled.mts",
    ]);
  });

  it("includes the extensions from every contribution for the language", () => {
    // ex. vscode contributes `.code-profile` for json before the json extension's contribution
    const contributions = [
      { id: "json", extensions: [".code-profile"] },
      { id: "json", extensions: [".json"], filenames: ["composer.lock"] },
    ];
    assert.deepStrictEqual(getUntitledFileNames(contributions, "json"), [
      "Untitled.code-profile",
      "Untitled.json",
      "composer.lock",
    ]);
  });

  it("uses the language's file names after its file extensions", () => {
    const contributions = [
      { id: "dockerfile", filenames: ["Dockerfile", "Containerfile"] },
      { id: "dockerfile", extensions: [".dockerfile"] },
    ];
    assert.deepStrictEqual(getUntitledFileNames(contributions, "dockerfile"), [
      "Untitled.dockerfile",
      "Dockerfile",
      "Containerfile",
    ]);
  });

  it("ignores extensions that aren't a dot followed by text", () => {
    const contributions = [{ id: "lang", extensions: [".", "txt"], filenames: ["lang.config"] }];
    assert.deepStrictEqual(getUntitledFileNames(contributions, "lang"), ["lang.config"]);
  });

  it("removes duplicates", () => {
    const contributions = [{ id: "json", extensions: [".json"] }, { id: "json", extensions: [".json"] }];
    assert.deepStrictEqual(getUntitledFileNames(contributions, "json"), ["Untitled.json"]);
  });

  it("returns no file names for an unknown language", () => {
    assert.deepStrictEqual(getUntitledFileNames([{ id: "json", extensions: [".json"] }], "other"), []);
    assert.deepStrictEqual(getUntitledFileNames([{ extensions: [".json"] }], "json"), []);
  });
});

describe("getNotebookCellFileNames", () => {
  it("uses the jupyter plugin's code block base name", () => {
    const contributions = [{ id: "python", extensions: [".py", ".pyi"] }];
    assert.deepStrictEqual(getNotebookCellFileNames(contributions, "python"), ["code_block.py", "code_block.pyi"]);
  });
});
