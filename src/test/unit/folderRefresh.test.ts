import * as assert from "node:assert";
import { describe, it } from "node:test";
import { type RefreshableFolder, refreshOrRestartFolders } from "../../legacy/folderRefresh";

describe("refreshOrRestartFolders", () => {
  it("refreshes the running folders", async () => {
    const folders = [createFolder(), createFolder()];

    await refreshOrRestartFolders(folders);

    assert.deepStrictEqual(folders.map(f => f.calls), [["refresh"], ["refresh"]]);
  });

  it("only restarts the folders that aren't running", async () => {
    const folders = [createFolder(), createFolder({ isRunning: false })];

    await refreshOrRestartFolders(folders);

    assert.deepStrictEqual(folders.map(f => f.calls), [["refresh"], ["initialize"]]);
  });

  it("restarts a folder whose refresh failed", async () => {
    const folders = [createFolder(), createFolder({ refreshSucceeds: false })];

    await refreshOrRestartFolders(folders);

    assert.deepStrictEqual(folders.map(f => f.calls), [["refresh"], ["refresh", "initialize"]]);
  });

  it("does nothing when there are no folders", async () => {
    await refreshOrRestartFolders([]);
  });
});

function createFolder(options: { isRunning?: boolean; refreshSucceeds?: boolean } = {}) {
  const folder: RefreshableFolder & { calls: string[] } = {
    calls: [],
    isRunning: () => options.isRunning ?? true,
    refreshEditorInfo: async () => {
      folder.calls.push("refresh");
      return options.refreshSucceeds ?? true;
    },
    initialize: async () => {
      folder.calls.push("initialize");
      return true;
    },
  };
  return folder;
}
