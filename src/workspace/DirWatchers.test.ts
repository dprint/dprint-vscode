import * as assert from "node:assert";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { PathKind } from "../environment";
import { DirWatchers, getFileNamesByDir, getWatchedPathKey, type WatchedFileChange } from "./DirWatchers";

describe("DirWatchers", () => {
  it("watches the directories for the names of the files", async () => {
    const { watchers, watched, changes, emit } = createWatchers({ "/p/a": "dir", "/p/b": "dir" });
    await watchers.update(new Map([["/p/a", ["dprint.json"]], ["/p/b", ["base.json", "other.json"]]]));
    assert.deepStrictEqual(watched, [["/p/a", ["dprint.json"]], ["/p/b", ["base.json", "other.json"]]]);
    emit("/p/a", "/p/a/dprint.json", "changed");
    emit("/p/b", "/p/b/other.json", "created");
    // only the files it's for, even when the watcher reports others
    emit("/p/a", "/p/a/package.json", "changed");
    assert.deepStrictEqual(changes, [["/p/a/dprint.json", "changed"], ["/p/b/other.json", "created"]]);
  });

  it("doesn't watch a directory that's a symlink or doesn't exist", async () => {
    // ex. a `.config` directory that's a symlink to a share, which a watcher of it would follow
    const { watchers, watched } = createWatchers({ "/p": "dir", "/p/.config": "symlink" });
    await watchers.update(new Map([["/p/.config", ["dprint.json"]], ["/p/missing", ["dprint.json"]]]));
    // only their parent for their names
    assert.deepStrictEqual(watched, [["/p", [".config"]], ["/p", ["missing"]]]);
  });

  it("watches each directory once and stops watching the ones that aren't needed", async () => {
    const { watchers, watched, disposed } = createWatchers({ "/p/a": "dir", "/p/b": "dir" });
    await watchers.update(new Map([["/p/a", ["dprint.json"]], ["/p/b", ["dprint.json"]]]));
    await watchers.update(new Map([["/p/a", ["dprint.json"]]]));
    assert.deepStrictEqual(watched.map(([dirPath]) => dirPath), ["/p/a", "/p/b"]);
    assert.deepStrictEqual(disposed, ["/p/b"]);
    // and watches one again for other files
    await watchers.update(new Map([["/p/a", ["dprint.json", "base.json"]]]));
    assert.deepStrictEqual(watched.map(([dirPath]) => dirPath), ["/p/a", "/p/b", "/p/a"]);
  });

  it("stops watching a directory that's replaced with a symlink, and watches one that's created again", async () => {
    const kinds: Record<string, PathKind | undefined> = { "/p": "dir", "/p/shared": "dir" };
    const { watchers, watched, disposed, emit } = createWatchers(kinds);
    await watchers.update(new Map([["/p/shared", ["base.json"]]]));
    const dirWatchCount = () => watched.filter(([dirPath]) => dirPath === "/p/shared").length;
    assert.strictEqual(dirWatchCount(), 1);

    // ex. a branch switch makes it a symlink, which vscode may report as a change
    kinds["/p/shared"] = "symlink";
    emit("/p", "/p/shared", "changed");
    await nextTicks();
    assert.deepStrictEqual(disposed, ["/p/shared"]);
    assert.strictEqual(dirWatchCount(), 1);

    // deleted and created again as a directory, which gets a new watcher
    kinds["/p/shared"] = undefined;
    emit("/p", "/p/shared", "deleted");
    await nextTicks();
    kinds["/p/shared"] = "dir";
    emit("/p", "/p/shared", "created");
    await nextTicks();
    assert.strictEqual(dirWatchCount(), 2);
  });

  it("checks a watched directory again on each update", async () => {
    const kinds: Record<string, PathKind | undefined> = { "/p/a": "dir" };
    const { watchers, disposed } = createWatchers(kinds);
    await watchers.update(new Map([["/p/a", ["dprint.json"]]]));
    kinds["/p/a"] = "symlink";
    await watchers.update(new Map([["/p/a", ["dprint.json"]]]));
    assert.deepStrictEqual(disposed, ["/p/a"]);
  });

  it("compares the names without their case when the file system does", async () => {
    const { watchers, changes, emit } = createWatchers({ "/p/a": "dir" }, { isCaseInsensitive: true });
    await watchers.update(new Map([["/p/a", ["dprint.json"]]]));
    emit("/p/a", "C:\\a\\DPRINT.json", "deleted");
    assert.deepStrictEqual(changes, [["C:\\a\\DPRINT.json", "deleted"]]);
  });

  it("keeps updating after an update failed", async () => {
    let fails = true;
    const { watchers, watched } = createWatchers({ "/p/a": "dir" }, {
      beforeWatch: () => {
        if (fails) {
          throw new Error("Failed.");
        }
      },
    });
    await assert.rejects(watchers.update(new Map([["/p/a", ["dprint.json"]]])), /Failed/);
    fails = false;
    await watchers.update(new Map([["/p/a", ["dprint.json"]]]));
    assert.deepStrictEqual(watched, [["/p/a", ["dprint.json"]]]);
  });

  it("applies overlapping updates in order", async () => {
    const { watchers, watched, disposed } = createWatchers({ "/p/a": "dir", "/p/b": "dir" });
    await Promise.all([
      watchers.update(new Map([["/p/a", ["dprint.json"]]])),
      watchers.update(new Map([["/p/b", ["dprint.json"]]])),
    ]);
    assert.deepStrictEqual(watched.map(([dirPath]) => dirPath), ["/p/a", "/p/b"]);
    assert.deepStrictEqual(disposed, ["/p/a"]);
  });

  it("disposes the watchers, including one that's being created", async () => {
    let finishPathKind!: () => void;
    const kinds: Record<string, PathKind | undefined> = { "/p/a": "dir" };
    const { watchers, watched, disposed } = createWatchers(kinds, {
      pathKind: filePath =>
        filePath === "/p/b" ? new Promise(resolve => finishPathKind = () => resolve("dir")) : undefined,
    });
    const update = watchers.update(new Map([["/p/a", ["dprint.json"]], ["/p/b", ["dprint.json"]]]));
    await nextTicks();
    watchers.dispose();
    finishPathKind();
    await update;
    assert.deepStrictEqual(watched.map(([dirPath]) => dirPath), ["/p/a"]);
    assert.deepStrictEqual(disposed, ["/p/a"]);
  });
});

describe("getFileNamesByDir", () => {
  it("groups the names of the files by their directories", () => {
    const a = path.join("/p", "a");
    assert.deepStrictEqual(
      getFileNamesByDir([path.join(a, "base.json"), path.join(a, "other.json"), path.join("/p", "dprint.json")]),
      new Map([[a, ["base.json", "other.json"]], [path.dirname(a), ["dprint.json"]]]),
    );
  });
});

describe("getWatchedPathKey", () => {
  it("is without the case when the file system is", () => {
    // an event's path may differ in case from the uri dprint provided
    assert.strictEqual(getWatchedPathKey("C:\\Base.json", true), getWatchedPathKey("c:\\base.json", true));
    assert.notStrictEqual(getWatchedPathKey("/Base.json", false), getWatchedPathKey("/base.json", false));
  });
});

function createWatchers(
  kinds: Record<string, PathKind | undefined>,
  options: {
    isCaseInsensitive?: boolean;
    beforeWatch?: () => void;
    /** Overrides the kind of a path, unless it's undefined. */
    pathKind?: (filePath: string) => Promise<PathKind | undefined> | undefined;
  } = {},
) {
  const watched: [string, readonly string[]][] = [];
  const disposed: string[] = [];
  const changes: [string, WatchedFileChange][] = [];
  const callbacks = new Map<string, ((filePath: string, change: WatchedFileChange) => void)[]>();
  const watchers = new DirWatchers({
    pathKind: filePath => {
      const key = toTestPath(filePath);
      return options.pathKind?.(key) ?? Promise.resolve(kinds[key]);
    },
    watchDir: (dirPath, fileNames, onChange) => {
      options.beforeWatch?.();
      const key = toTestPath(dirPath);
      watched.push([key, fileNames]);
      callbacks.set(key, [...callbacks.get(key) ?? [], onChange]);
      return {
        dispose: () => {
          disposed.push(key);
          callbacks.set(key, (callbacks.get(key) ?? []).filter(callback => callback !== onChange));
        },
      };
    },
    onChange: (filePath, change) => changes.push([filePath, change]),
    onError: err => assert.fail(String(err)),
    isCaseInsensitive: options.isCaseInsensitive ?? false,
  });
  const emit = (dirPath: string, filePath: string, change: WatchedFileChange) => {
    for (const callback of callbacks.get(dirPath) ?? []) {
      callback(filePath, change);
    }
  };
  return { watchers, watched, disposed, changes, emit };
}

/** Gets a path with forward slashes, which the tests use on every platform. */
function toTestPath(filePath: string) {
  return filePath.replace(/\\/g, "/");
}

/** Waits for the pending promise callbacks and immediates to run a few times. */
async function nextTicks() {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
