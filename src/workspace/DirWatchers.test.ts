import * as assert from "node:assert";
import { describe, it } from "node:test";
import type { PathKind } from "../environment";
import { DirWatchers, type WatchedFileChange } from "./DirWatchers";

describe("DirWatchers", () => {
  it("watches the directories of the files", async () => {
    const { watchers, watched, changes, emit } = createWatchers({ "/a": "dir", "/b": "dir" });
    await watchers.update(new Map([["/a", ["dprint.json"]], ["/b", ["base.json", "other.json"]]]));
    assert.deepStrictEqual(watched, ["/a", "/b"]);
    emit("/a", "/a/dprint.json", "changed");
    emit("/b", "/b/other.json", "created");
    // only the files it's for
    emit("/a", "/a/package.json", "changed");
    assert.deepStrictEqual(changes, [["/a/dprint.json", "changed"], ["/b/other.json", "created"]]);
  });

  it("doesn't watch a directory that's a symlink or doesn't exist", async () => {
    // ex. a `.config` directory that's a symlink to a share, which a watcher of it would follow
    const { watchers, watched } = createWatchers({ "/a/.config": "symlink" });
    await watchers.update(new Map([["/a/.config", ["dprint.json"]], ["/missing", ["dprint.json"]]]));
    assert.deepStrictEqual(watched, []);
  });

  it("watches each directory once and stops watching the ones that aren't needed", async () => {
    const { watchers, watched, disposed } = createWatchers({ "/a": "dir", "/b": "dir" });
    await watchers.update(new Map([["/a", ["dprint.json"]], ["/b", ["dprint.json"]]]));
    await watchers.update(new Map([["/a", ["dprint.json"]]]));
    assert.deepStrictEqual(watched, ["/a", "/b"]);
    assert.deepStrictEqual(disposed, ["/b"]);
    // and watches one again for other files
    await watchers.update(new Map([["/a", ["dprint.json", "base.json"]]]));
    assert.deepStrictEqual(watched, ["/a", "/b", "/a"]);
    assert.deepStrictEqual(disposed, ["/b", "/a"]);
  });

  it("compares the names without their case when the file system does", async () => {
    const { watchers, changes, emit } = createWatchers({ "/a": "dir" }, { isCaseInsensitive: true });
    await watchers.update(new Map([["/a", ["dprint.json"]]]));
    emit("/a", "C:\\a\\DPRINT.json", "deleted");
    assert.deepStrictEqual(changes, [["C:\\a\\DPRINT.json", "deleted"]]);
  });

  it("disposes the watchers, including one that's being created", async () => {
    let finishPathKind!: () => void;
    const disposedPaths: string[] = [];
    const watchedPaths: string[] = [];
    const watchers = new DirWatchers({
      pathKind: path =>
        path === "/b" ? new Promise(resolve => finishPathKind = () => resolve("dir")) : Promise.resolve("dir"),
      watchDir: dirPath => {
        watchedPaths.push(dirPath);
        return { dispose: () => disposedPaths.push(dirPath) };
      },
      onChange: () => {},
      isCaseInsensitive: false,
    });
    const update = watchers.update(new Map([["/a", ["dprint.json"]], ["/b", ["dprint.json"]]]));
    await new Promise<void>(resolve => setImmediate(resolve));
    watchers.dispose();
    finishPathKind();
    await update;
    assert.deepStrictEqual(watchedPaths, ["/a"]);
    assert.deepStrictEqual(disposedPaths, ["/a"]);
  });
});

function createWatchers(kinds: Record<string, PathKind>, options: { isCaseInsensitive?: boolean } = {}) {
  const watched: string[] = [];
  const disposed: string[] = [];
  const changes: [string, WatchedFileChange][] = [];
  const callbacks = new Map<string, (filePath: string, change: WatchedFileChange) => void>();
  const watchers = new DirWatchers({
    pathKind: path => Promise.resolve(kinds[path]),
    watchDir: (dirPath, onChange) => {
      watched.push(dirPath);
      callbacks.set(dirPath, onChange);
      return { dispose: () => disposed.push(dirPath) };
    },
    onChange: (filePath, change) => changes.push([filePath, change]),
    isCaseInsensitive: options.isCaseInsensitive ?? false,
  });
  const emit = (dirPath: string, filePath: string, change: WatchedFileChange) =>
    callbacks.get(dirPath)!(filePath, change);
  return { watchers, watched, disposed, changes, emit };
}
