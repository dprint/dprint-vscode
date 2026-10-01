import * as assert from "node:assert";
import { describe, it } from "node:test";
import { type RefreshableFolder, refreshOrRestartFolders, tryInitializeFolder } from "./folderRefresh";

describe("refreshOrRestartFolders", () => {
  it("refreshes the running folders", async () => {
    const folders = [createFolder(), createFolder()];

    await refreshOrRestartFolders(folders, failOnError);

    assert.deepStrictEqual(folders.map(f => f.calls), [["refresh"], ["refresh"]]);
  });

  it("only restarts the folders that aren't running", async () => {
    const folders = [createFolder(), createFolder({ isRunning: false })];

    await refreshOrRestartFolders(folders, failOnError);

    assert.deepStrictEqual(folders.map(f => f.calls), [["refresh"], ["initialize"]]);
  });

  it("restarts a folder whose refresh failed", async () => {
    const folders = [createFolder(), createFolder({ refreshSucceeds: false })];

    await refreshOrRestartFolders(folders, failOnError);

    assert.deepStrictEqual(folders.map(f => f.calls), [["refresh"], ["refresh", "initialize"]]);
  });

  it("restarts the other folders when a folder fails to restart", async () => {
    const error = new Error("failed");
    const folders = [
      createFolder({ isRunning: false, initializeError: error }),
      createFolder({ isRunning: false, initializeDelayMs: 10 }),
      createFolder(),
    ];

    const errors: unknown[] = [];
    await refreshOrRestartFolders(folders, err => errors.push(err));

    // it waited for the folder that takes longer than the failing one
    assert.deepStrictEqual(folders.map(f => f.calls), [["initialize"], ["initialize", "initialized"], ["refresh"]]);
    assert.deepStrictEqual(errors, [error]);
  });

  it("does nothing when there are no folders", async () => {
    await refreshOrRestartFolders([], failOnError);
  });
});

describe("tryInitializeFolder", () => {
  it("returns whether the folder started", async () => {
    assert.strictEqual(await tryInitializeFolder(createFolder(), failOnError), true);
    assert.strictEqual(await tryInitializeFolder(createFolder({ initializeSucceeds: false }), failOnError), false);
  });

  it("provides the error and returns false when starting the folder fails", async () => {
    const error = new Error("failed");
    const errors: unknown[] = [];

    const result = await tryInitializeFolder(createFolder({ initializeError: error }), err => errors.push(err));

    assert.strictEqual(result, false);
    assert.deepStrictEqual(errors, [error]);
  });
});

function failOnError(err: unknown) {
  assert.fail(`Unexpected error: ${err}`);
}

interface TestFolderOptions {
  isRunning?: boolean;
  refreshSucceeds?: boolean;
  initializeSucceeds?: boolean;
  initializeError?: Error;
  initializeDelayMs?: number;
}

function createFolder(options: TestFolderOptions = {}) {
  const folder: RefreshableFolder & { calls: string[] } = {
    calls: [],
    isRunning: () => options.isRunning ?? true,
    refreshEditorInfo: async () => {
      folder.calls.push("refresh");
      return options.refreshSucceeds ?? true;
    },
    initialize: async () => {
      folder.calls.push("initialize");
      if (options.initializeError != null) {
        throw options.initializeError;
      }
      if (options.initializeDelayMs != null) {
        await new Promise(resolve => setTimeout(resolve, options.initializeDelayMs));
        folder.calls.push("initialized");
      }
      return options.initializeSucceeds ?? true;
    },
  };
  return folder;
}
