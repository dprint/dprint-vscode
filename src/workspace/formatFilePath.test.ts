import * as assert from "node:assert";
import * as path from "node:path";
import { describe, it } from "node:test";
import { getFormatFilePath } from "./formatFilePath";
import type { FileInfoData, FileInfoResponseData } from "./messages";

describe("getFormatFilePath", () => {
  const dirPath = path.resolve("/project");
  const configFile = { path: path.join(dirPath, "dprint.json"), isGlobal: false };

  function createFileInfo(formattable: string[], options: { hasConfigFile?: boolean } = {}) {
    const requests: FileInfoData[] = [];
    const getFileInfo = async (data: FileInfoData): Promise<FileInfoResponseData> => {
      requests.push(data);
      return {
        configFile: options.hasConfigFile ?? true ? configFile : null,
        canFormat: formattable.includes(path.basename(data.filePath)),
      };
    };
    return { requests, getFileInfo };
  }

  it("is the only candidate without asking", async () => {
    const { requests, getFileInfo } = createFileInfo([]);
    const filePath = await getFormatFilePath({ dirPath, fileNames: ["file.ts"] }, false, getFileInfo);
    assert.strictEqual(filePath, path.join(dirPath, "file.ts"));
    assert.strictEqual(requests.length, 0);
  });

  it("is the first candidate that dprint formats", async () => {
    const { requests, getFileInfo } = createFileInfo(["file.mts"]);
    const notebookPath = path.join(dirPath, "notebook.ipynb");
    const filePath = await getFormatFilePath(
      { dirPath, fileNames: ["file.ts", "file.mts", "file.cts"], notebookPath },
      true,
      getFileInfo,
    );
    assert.strictEqual(filePath, path.join(dirPath, "file.mts"));
    assert.deepStrictEqual(requests, [
      { filePath: path.join(dirPath, "file.ts"), notebookPath, allowGlobalConfig: true },
      { filePath: path.join(dirPath, "file.mts"), notebookPath, allowGlobalConfig: true },
    ]);
  });

  it("is the first candidate when dprint formats none of them", async () => {
    const { getFileInfo } = createFileInfo([]);
    const filePath = await getFormatFilePath({ dirPath, fileNames: ["file.ts", "file.mts"] }, false, getFileInfo);
    assert.strictEqual(filePath, path.join(dirPath, "file.ts"));
  });

  it("stops asking when there's no config file because it's the same for every candidate", async () => {
    const { requests, getFileInfo } = createFileInfo([], { hasConfigFile: false });
    const filePath = await getFormatFilePath({ dirPath, fileNames: ["file.ts", "file.mts"] }, false, getFileInfo);
    assert.strictEqual(filePath, path.join(dirPath, "file.ts"));
    assert.strictEqual(requests.length, 1);
  });
});
