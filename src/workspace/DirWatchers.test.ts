import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { PathKind } from "../environment";
import {
  DirWatchers,
  getFileNamesByDir,
  getWatchedPathKey,
  getWatchPattern,
  getWorkspaceFolderAndAncestorKeys,
  lstatPath,
  lstatWithoutSymlinks,
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
    assert.deepStrictEqual(disposed, ["/p/shared", "/p/shared/configs"]);

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

  it("watches a directory again that was replaced with another one, and reports its files", async () => {
    // ex. `npm install` created a package directory again with its files, which a new watcher doesn't report
    const kinds: Record<string, PathKind | undefined> = {
      "/p": "dir",
      "/p/pkg": "dir",
      "/p/pkg/dprint.json": "file",
    };
    const identities: Record<string, string> = { "/p/pkg": "old" };
    const { watchers, watched, disposed, changes, emit } = createWatchers(kinds, { identities });
    await watchers.update(new Map([["/p/pkg", ["dprint.json", "base.json"]]]));
    assert.strictEqual(changes.length, 0);

    identities["/p/pkg"] = "new";
    emit("/p", "/p/pkg", "created");
    await nextTicks();
    assert.deepStrictEqual(disposed, ["/p/pkg"]);
    assert.strictEqual(watched.filter(([dirPath]) => dirPath === "/p/pkg").length, 2);
    assert.deepStrictEqual(changes.map(([filePath, change]) => [toTestPath(filePath), change]), [
      ["/p/pkg/dprint.json", "created"],
      ["/p/pkg/base.json", "deleted"],
    ]);
  });

  it("reports the files that changed when the parent reports a directory with the same identity", async () => {
    // ex. it was deleted and created again with another file, and ext4 reused its inode
    const kinds: Record<string, PathKind | undefined> = {
      "/p": "dir",
      "/p/shared": "dir",
      "/p/shared/base.json": "file",
      "/p/shared/other.json": "file",
    };
    const versions: Record<string, string> = { "/p/shared/base.json": "1", "/p/shared/other.json": "1" };
    const { watchers, watched, changes, emit } = createWatchers(kinds, { versions });
    await watchers.update(new Map([["/p/shared", ["base.json", "other.json", "new.json"]]]));
    versions["/p/shared/base.json"] = "2";
    kinds["/p/shared/other.json"] = undefined;
    kinds["/p/shared/new.json"] = "file";
    emit("/p", "/p/shared", "changed");
    await nextTicks();
    assert.strictEqual(watched.filter(([dirPath]) => dirPath === "/p/shared").length, 1);
    assert.deepStrictEqual(changes.map(([filePath, change]) => [toTestPath(filePath), change]), [
      ["/p/shared/base.json", "changed"],
      ["/p/shared/other.json", "deleted"],
      ["/p/shared/new.json", "created"],
    ]);
    // and nothing when they didn't change since
    emit("/p", "/p/shared", "changed");
    await nextTicks();
    assert.strictEqual(changes.length, 3);
  });

  it("reports the files of a directory that's gone as deleted", async () => {
    const kinds: Record<string, PathKind | undefined> = { "/p": "dir", "/p/pkg": "dir" };
    const { watchers, changes, emit } = createWatchers(kinds);
    await watchers.update(new Map([["/p/pkg", ["dprint.json"]]]));
    kinds["/p/pkg"] = undefined;
    emit("/p", "/p/pkg", "deleted");
    await nextTicks();
    assert.deepStrictEqual(changes.map(([filePath, change]) => [toTestPath(filePath), change]), [
      ["/p/pkg/dprint.json", "deleted"],
    ]);
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

describe("getWorkspaceFolderAndAncestorKeys", () => {
  it("has the workspace folders and their ancestor directories, but not their descendants", () => {
    // ex. macOS's `/tmp`, which is a symlink to `/private/tmp`, for a workspace folder in it
    const folder = path.resolve("/tmp/project");
    const keys = getWorkspaceFolderAndAncestorKeys([folder], false);
    assert.ok(keys.has(folder));
    assert.ok(keys.has(path.resolve("/tmp")));
    assert.ok(keys.has(path.resolve("/")));
    assert.ok(!keys.has(path.join(folder, "sub")));
    assert.ok(!keys.has(path.resolve("/other")));
  });

  it("has the keys without their case when the file system does", () => {
    const keys = getWorkspaceFolderAndAncestorKeys([path.resolve("/ws/Project")], true);
    assert.ok(keys.has(getWatchedPathKey(path.resolve("/ws/project"), true)));
  });
});

describe("lstatWithoutSymlinks", () => {
  it("can't reach what's below a symlink, so a config file's problems there are kept", async () => {
    const calls: string[] = [];
    const kinds: Record<string, PathKind> = { "/p/link": "symlink" };
    const result = await lstatWithoutSymlinks("/p/link/dprint.json", {
      lstat: async filePath => {
        calls.push(toTestPath(filePath));
        const kind = kinds[toTestPath(filePath)];
        return kind == null ? undefined : { kind, identity: filePath };
      },
      isWorkspaceFolderOrAncestor: dirPath => toTestPath(dirPath) === "/p",
    });
    assert.deepStrictEqual(result, { isReachable: false });
    assert.deepStrictEqual(calls, ["/p/link"]);
  });

  it("looks at each directory from the root of another drive", { skip: process.platform !== "win32" }, async () => {
    const calls: string[] = [];
    const result = await lstatWithoutSymlinks("D:\\a\\b", {
      lstat: async filePath => {
        calls.push(filePath);
        return { kind: "dir", identity: filePath };
      },
      isWorkspaceFolderOrAncestor: () => false,
    });
    assert.deepStrictEqual(result, { isReachable: true, stat: { kind: "dir", identity: "D:\\a\\b" } });
    assert.deepStrictEqual(calls, ["D:\\", "D:\\a", "D:\\a\\b"]);
  });
});

describe("lstatPath", () => {
  it("keeps the identity of a directory when a file is created in it", async () => {
    const dirPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dprint-vscode-"));
    try {
      const before = await lstatPath(dirPath);
      assert.strictEqual(before?.kind, "dir");
      await fs.promises.writeFile(path.join(dirPath, "dprint.json"), "{}");
      assert.strictEqual((await lstatPath(dirPath))?.identity, before?.identity);
      assert.strictEqual((await lstatPath(path.join(dirPath, "dprint.json")))?.kind, "file");
      assert.strictEqual(await lstatPath(path.join(dirPath, "missing")), undefined);
      // and a file's version changes with its contents
      const fileBefore = await lstatPath(path.join(dirPath, "dprint.json"));
      await fs.promises.writeFile(path.join(dirPath, "dprint.json"), "{ \"lineWidth\": 80 }");
      const fileAfter = await lstatPath(path.join(dirPath, "dprint.json"));
      assert.strictEqual(fileAfter?.identity, fileBefore?.identity);
      assert.notStrictEqual(fileAfter?.version, fileBefore?.version);
    } finally {
      await fs.promises.rm(dirPath, { recursive: true, force: true });
    }
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
    /** Overrides the identity of a path (ex. a directory that was replaced with another one). */
    identities?: Record<string, string>;
    /** The versions of the files (ex. their modification times and sizes). */
    versions?: Record<string, string>;
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
      return kind == null
        ? undefined
        : { kind, identity: options.identities?.[key] ?? `${key}#${generation}`, version: options.versions?.[key] };
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
