import * as assert from "node:assert";
import { describe, it } from "node:test";
import { type RefreshableFolder, tryRefreshFolders } from "./folderRefresh";

describe("tryRefreshFolders", () => {
  it("refreshes all the running folders", async () => {
    const folders = [createFolder(), createFolder()];

    assert.strictEqual(await tryRefreshFolders(folders), true);
    assert.deepStrictEqual(folders.map(f => f.refreshCount), [1, 1]);
  });

  it("does not refresh any folder when one isn't running", async () => {
    const folders = [createFolder(), createFolder({ isRunning: false })];

    assert.strictEqual(await tryRefreshFolders(folders), false);
    assert.deepStrictEqual(folders.map(f => f.refreshCount), [0, 0]);
  });

  it("returns false when refreshing a folder fails", async () => {
    const folders = [createFolder(), createFolder({ refreshSucceeds: false })];

    assert.strictEqual(await tryRefreshFolders(folders), false);
    assert.deepStrictEqual(folders.map(f => f.refreshCount), [1, 1]);
  });

  it("succeeds when there are no folders", async () => {
    assert.strictEqual(await tryRefreshFolders([]), true);
  });
});

function createFolder(options: { isRunning?: boolean; refreshSucceeds?: boolean } = {}) {
  const folder: RefreshableFolder & { refreshCount: number } = {
    refreshCount: 0,
    isRunning: () => options.isRunning ?? true,
    refreshEditorInfo: async () => {
      folder.refreshCount++;
      return options.refreshSucceeds ?? true;
    },
  };
  return folder;
}
