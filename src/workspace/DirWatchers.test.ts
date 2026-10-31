import * as assert from "node:assert";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { PathKind } from "../environment";
import {
  DirWatchers,
  getFileNamesByDir,
  getWatchedPathKey,
  getWatchPattern,
  isWorkspaceFolderOrAncestorPath,
  type WatchedFileChange,
} from "./DirWatchers";

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

  it("watches a workspace folder that's a symlink, but no other directory that's one", async () => {
    // ex. a file a config file extends in a workspace folder opened through a symlink, and one
    // dprint provided in a directory that was replaced with a symlink since
    const kinds: Record<string, PathKind | undefined> = { "/p": "dir", "/p/folder": "symlink", "/p/shared": "symlink" };
    const { watchers, watched } = createWatchers(kinds, { workspaceFolders: ["/p/folder"] });
    await watchers.update(new Map([["/p/folder", ["base.json"]], ["/p/shared", ["base.json"]]]));
    assert.deepStrictEqual(watched.map(([dirPath]) => dirPath).filter(dirPath => dirPath !== "/p"), ["/p/folder"]);
  });

  it("watches a workspace folder again that's replaced with a symlink", async () => {
    const kinds: Record<string, PathKind | undefined> = { "/p": "dir", "/p/folder": "dir" };
    const { watchers, watched, disposed, emit } = createWatchers(kinds, { workspaceFolders: ["/p/folder"] });
    await watchers.update(new Map([["/p/folder", ["base.json"]]]));
    kinds["/p/folder"] = "symlink";
    emit("/p", "/p/folder", "changed");
    await nextTicks();
    assert.deepStrictEqual(disposed, ["/p/folder"]);
    assert.deepStrictEqual(watched.map(([dirPath]) => dirPath).filter(dirPath => dirPath !== "/p"), [
      "/p/folder",
      "/p/folder",
    ]);
  });

  it("doesn't watch a directory again when it only changed", async () => {
    // ex. a file in it was saved, which is a change of it in its parent's watcher on Windows
    const { watchers, watched, disposed, emit } = createWatchers({ "/p": "dir", "/p/shared": "dir" });
    await watchers.update(new Map([["/p/shared", ["base.json"]]]));
    emit("/p", "/p/shared", "changed");
    await nextTicks();
    assert.deepStrictEqual(disposed, []);
    assert.strictEqual(watched.filter(([dirPath]) => dirPath === "/p/shared").length, 1);
  });

  it("stops watching a parent that's gone, and watches it again on an update once it's back", async () => {
    // ex. a branch switch deletes the directory and its parent, which vscode would watch again by itself
    const kinds: Record<string, PathKind | undefined> = { "/p": "dir", "/p/shared": "dir", "/p/shared/configs": "dir" };
    const { watchers, watched, disposed, emit } = createWatchers(kinds);
    const fileNamesByDir = new Map([["/p/shared/configs", ["base.json"]]]);
    await watchers.update(fileNamesByDir);
    assert.deepStrictEqual(watched.map(([dirPath]) => dirPath), ["/p/shared", "/p/shared/configs"]);

    kinds["/p/shared/configs"] = undefined;
    kinds["/p/shared"] = undefined;
    emit("/p/shared", "/p/shared/configs", "deleted");
    await nextTicks();
    assert.deepStrictEqual(disposed, ["/p/shared/configs", "/p/shared"]);

    // it comes back as a symlink, which isn't watched, and then as a directory, which is
    kinds["/p/shared"] = "symlink";
    await watchers.update(fileNamesByDir);
    assert.strictEqual(watched.length, 2);
    kinds["/p/shared"] = "dir";
    kinds["/p/shared/configs"] = "dir";
    await watchers.update(fileNamesByDir);
    assert.deepStrictEqual(watched.map(([dirPath]) => dirPath), [
      "/p/shared",
      "/p/shared/configs",
      "/p/shared",
      "/p/shared/configs",
    ]);
  });

  it("watches a workspace folder that's a symlink for its directories", async () => {
    const { watchers, watched } = createWatchers({ "/ws": "symlink", "/ws/configs": "dir" }, {
      workspaceFolders: ["/ws"],
    });
    await watchers.update(new Map([["/ws/configs", ["base.json"]]]));
    assert.deepStrictEqual(watched, [["/ws", ["configs"]], ["/ws/configs", ["base.json"]]]);
  });

  it("reports an error of a check that its parent's watcher started", async () => {
    const errors: unknown[] = [];
    const kinds: Record<string, PathKind | undefined> = { "/p": "dir", "/p/shared": "dir" };
    let fails = false;
    const { watchers, emit } = createWatchers(kinds, {
      onError: err => errors.push(err),
      beforeWatch: () => {
        if (fails) {
          throw new Error("Failed.");
        }
      },
    });
    await watchers.update(new Map([["/p/shared", ["base.json"]]]));
    fails = true;
    kinds["/p/shared"] = undefined;
    emit("/p", "/p/shared", "deleted");
    await nextTicks();
    kinds["/p/shared"] = "dir";
    emit("/p", "/p/shared", "created");
    await nextTicks();
    assert.strictEqual(errors.length, 1);
  });

  it("doesn't watch or look at a directory that's reached through a symlink", async () => {
    // ex. a `git pull` made a directory above it a symlink to a share, which `lstat` would follow
    const kinds: Record<string, PathKind | undefined> = { "/p": "dir", "/p/link": "symlink", "/p/link/sub": "dir" };
    const { watchers, watched, lstatCalls } = createWatchers(kinds);
    await watchers.update(new Map([["/p/link/sub", ["base.json"]]]));
    assert.deepStrictEqual(watched, []);
    assert.ok(!lstatCalls.includes("/p/link/sub"), lstatCalls.join(", "));
  });

  it("watches a directory that's reached through a workspace folder that's a symlink", async () => {
    const { watchers, watched } = createWatchers({ "/ws": "symlink", "/ws/a": "dir", "/ws/a/b": "dir" }, {
      workspaceFolders: ["/ws"],
    });
    await watchers.update(new Map([["/ws/a/b", ["base.json"]]]));
    assert.deepStrictEqual(watched, [["/ws/a", ["b"]], ["/ws/a/b", ["base.json"]]]);
  });

  it("looks at each directory once for an update", async () => {
    const { watchers, lstatCalls } = createWatchers({ "/p": "dir", "/p/x": "dir", "/p/x/a": "dir", "/p/x/b": "dir" });
    await watchers.update(new Map([["/p/x/a", ["base.json"]], ["/p/x/b", ["base.json"]]]));
    assert.deepStrictEqual(lstatCalls.filter(call => call === "/p/x").length, 1);
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

describe("getWatchPattern", () => {
  it("has the names without a separator", () => {
    assert.strictEqual(getWatchPattern(["dprint.json"]), "dprint.json");
    assert.strictEqual(getWatchPattern(["dprint.json", ".config"]), "{dprint.json,.config}");
    // a name with a glob's special characters is matched by `*`
    assert.strictEqual(getWatchPattern(["base.json", "a{b}.json"]), "*");
    assert.strictEqual(getWatchPattern(["[x].json"]), "*");
  });
});

describe("isWorkspaceFolderOrAncestorPath", () => {
  it("compares the paths without their case when the file system does", () => {
    const folder = path.resolve("/ws/Project");
    assert.strictEqual(isWorkspaceFolderOrAncestorPath(path.resolve("/ws/project"), [folder], true), true);
    assert.strictEqual(isWorkspaceFolderOrAncestorPath(path.resolve("/ws/project"), [folder], false), false);
  });

  it("matches the ancestor directories of a workspace folder, but not its descendants", () => {
    // ex. macOS's `/tmp`, which is a symlink to `/private/tmp`, for a workspace folder in it
    const folder = path.resolve("/tmp/project");
    assert.strictEqual(isWorkspaceFolderOrAncestorPath(path.resolve("/tmp"), [folder], false), true);
    assert.strictEqual(isWorkspaceFolderOrAncestorPath(path.resolve("/"), [folder], false), true);
    assert.strictEqual(isWorkspaceFolderOrAncestorPath(path.join(folder, "sub"), [folder], false), false);
    assert.strictEqual(isWorkspaceFolderOrAncestorPath(path.resolve("/other"), [folder], false), false);
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
    workspaceFolders?: string[];
    beforeWatch?: () => void;
    /** Overrides the kind of a path, unless it's undefined. */
    pathKind?: (filePath: string) => Promise<PathKind | undefined> | undefined;
    onError?: (err: unknown) => void;
  } = {},
) {
  // the identity of a path changes whenever its kind is seen to change (ex. it was deleted and created again)
  const generations = new Map<string, { kind: PathKind | undefined; generation: number }>();
  const watched: [string, readonly string[]][] = [];
  const disposed: string[] = [];
  const lstatCalls: string[] = [];
  const changes: [string, WatchedFileChange][] = [];
  const callbacks = new Map<string, ((filePath: string, change: WatchedFileChange) => void)[]>();
  const watchers = new DirWatchers({
    lstat: async filePath => {
      const key = toTestPath(filePath);
      lstatCalls.push(key);
      const kind = await (options.pathKind?.(key) ?? Promise.resolve(kinds[key]));
      const last = generations.get(key);
      const generation = last == null ? 0 : last.kind === kind ? last.generation : last.generation + 1;
      generations.set(key, { kind, generation });
      return kind == null ? undefined : { kind, identity: `${key}#${generation}` };
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
    onError: options.onError ?? (err => assert.fail(String(err))),
    isCaseInsensitive: options.isCaseInsensitive ?? false,
    // `/p` and `/` are ancestors of a workspace folder, which the directories in the tests are in
    isWorkspaceFolderOrAncestor: dirPath =>
      ["/p/workspace", ...options.workspaceFolders ?? []].some(folder => isSameOrAncestor(toTestPath(dirPath), folder)),
  });
  const emit = (dirPath: string, filePath: string, change: WatchedFileChange) => {
    for (const callback of callbacks.get(dirPath) ?? []) {
      callback(filePath, change);
    }
  };
  return { watchers, watched, disposed, changes, emit, lstatCalls };
}

/** Gets whether the directory is the folder or one of its ancestors, with the tests' forward slashes. */
function isSameOrAncestor(dirPath: string, folder: string) {
  for (let current = folder;; current = path.posix.dirname(current)) {
    if (current === dirPath) {
      return true;
    }
    if (path.posix.dirname(current) === current) {
      return false;
    }
  }
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
