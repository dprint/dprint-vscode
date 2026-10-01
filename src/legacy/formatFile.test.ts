import * as assert from "node:assert";
import * as path from "node:path";
import { describe, it } from "node:test";
import { hasPluginForFile, type PluginFileInfo } from "../pluginFiles";
import { type FormatFile, getCannotFormatReason } from "./formatFile";

describe("getCannotFormatReason", () => {
  const dirPath = path.resolve("/project");
  const typescriptPlugin: PluginFileInfo = { fileExtensions: ["ts"], fileNames: [] };
  const jupyterPlugin: PluginFileInfo = { fileExtensions: ["ipynb"], fileNames: [] };

  /** Gets the reason and the file paths the cli was asked about. */
  async function getReason(file: FormatFile, plugins: PluginFileInfo[], opts: { cliCanFormat?: boolean } = {}) {
    const canFormatCalls: string[] = [];
    const reason = await getCannotFormatReason(file, {
      hasPluginForFile: filePath => hasPluginForFile(plugins, filePath),
      canFormat: filePath => {
        canFormatCalls.push(filePath);
        return Promise.resolve(opts.cliCanFormat ?? true);
      },
    });
    return { reason, canFormatCalls };
  }

  describe("file", () => {
    const file: FormatFile = { filePath: path.join(dirPath, "file.ts") };

    it("has no reason when the cli formats the file", async () => {
      assert.deepStrictEqual(await getReason(file, [typescriptPlugin]), {
        reason: undefined,
        canFormatCalls: [file.filePath],
      });
    });

    it("is not matched when the cli doesn't format the file", async () => {
      assert.deepStrictEqual(await getReason(file, [typescriptPlugin], { cliCanFormat: false }), {
        reason: "notMatched",
        canFormatCalls: [file.filePath],
      });
    });

    it("asks the cli when no plugin handles the file's name because of the config's associations", async () => {
      assert.deepStrictEqual(await getReason(file, [jupyterPlugin]), {
        reason: undefined,
        canFormatCalls: [file.filePath],
      });
    });
  });

  describe("notebook cell", () => {
    const cell: FormatFile = {
      filePath: path.join(dirPath, "cell.ts"),
      notebookPath: path.join(dirPath, "notebook.ipynb"),
    };

    it("has no reason when plugins handle the notebook and the cell and the cli formats the notebook", async () => {
      assert.deepStrictEqual(await getReason(cell, [typescriptPlugin, jupyterPlugin]), {
        reason: undefined,
        canFormatCalls: [cell.notebookPath],
      });
    });

    it("has no plugin for the cell when no plugin handles the notebook", async () => {
      // not "notMatched", which would blame the config's includes and excludes
      assert.deepStrictEqual(await getReason(cell, [typescriptPlugin]), {
        reason: "noCellPlugin",
        canFormatCalls: [],
      });
    });

    it("has no plugin for the cell when no plugin handles the cell's file", async () => {
      assert.deepStrictEqual(await getReason(cell, [jupyterPlugin]), {
        reason: "noCellPlugin",
        canFormatCalls: [],
      });
    });

    it("is not matched when the cli doesn't format the notebook", async () => {
      assert.deepStrictEqual(await getReason(cell, [typescriptPlugin, jupyterPlugin], { cliCanFormat: false }), {
        reason: "notMatched",
        canFormatCalls: [cell.notebookPath],
      });
    });
  });
});
