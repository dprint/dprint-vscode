import * as assert from "node:assert";
import { describe, it } from "node:test";
import {
  initializeFolders,
  type RefreshableFolder,
  refreshOrRestartFolders,
  tryInitializeFolder,
} from "./folderRefresh";

describe("initializeFolders", () => {
  it("returns the folders that started", async () => {
    const folders = [createFolder(), createFolder({ initializeSucceeds: false }), createFolder()];

    const result = await initializeFolders(folders, failOnError);

    assert.deepStrictEqual(folders.map(f => f.calls), [["initialize"], ["initialize"], ["initialize"]]);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0], folders[0]);
    assert.strictEqual(result[1], folders[2]);
  });

  it("starts the other folders when a folder fails to start", async () => {
    const error = new Error("failed");
    const folders = [
      createFolder({ initializeError: error }),
      createFolder({ initializeDelayMs: 10 }),
    ];

    const errors: FolderError[] = [];
    const result = await initializeFolders(folders, (folder, err) => errors.push({ folder, err }));

    // it waited for the folder that takes longer than the failing one
    assert.deepStrictEqual(folders.map(f => f.calls), [["initialize"], ["initialize", "initialized"]]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0], folders[1]);
    assertFolderErrors(errors, [{ folder: folders[0], err: error }]);
  });

  it("starts the folders in parallel", async () => {
    const folders = [createFolder({ initializeDelayMs: 10 }), createFolder({ initializeDelayMs: 10 })];

    const promise = initializeFolders(folders, failOnError);

    // the second folder was started without waiting for the first one
    assert.deepStrictEqual(folders.map(f => f.calls), [["initialize"], ["initialize"]]);
    await promise;
  });

  it("returns nothing when there are no folders", async () => {
    assert.deepStrictEqual(await initializeFolders([], failOnError), []);
  });
});

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

    const errors: FolderError[] = [];
    await refreshOrRestartFolders(folders, (folder, err) => errors.push({ folder, err }));

    // it waited for the folder that takes longer than the failing one
    assert.deepStrictEqual(folders.map(f => f.calls), [["initialize"], ["initialize", "initialized"], ["refresh"]]);
    assertFolderErrors(errors, [{ folder: folders[0], err: error }]);
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

  it("provides the folder and error and returns false when starting the folder fails", async () => {
    const error = new Error("failed");
    const folder = createFolder({ initializeError: error });
    const errors: FolderError[] = [];

    const result = await tryInitializeFolder(folder, (folder, err) => errors.push({ folder, err }));

    assert.strictEqual(result, false);
    assertFolderErrors(errors, [{ folder, err: error }]);
  });
});

interface FolderError {
  folder: RefreshableFolder;
  err: unknown;
}

function failOnError(_folder: RefreshableFolder, err: unknown) {
  assert.fail(`Unexpected error: ${err}`);
}

/** Asserts the errors were provided for the expected folders, comparing by reference. */
function assertFolderErrors(actual: FolderError[], expected: FolderError[]) {
  assert.strictEqual(actual.length, expected.length);
  for (const [index, { folder, err }] of expected.entries()) {
    assert.strictEqual(actual[index].folder, folder);
    assert.strictEqual(actual[index].err, err);
  }
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
