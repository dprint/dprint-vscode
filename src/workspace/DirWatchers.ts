import * as fs from "node:fs";
import * as path from "node:path";
import type { PathKind } from "../environment";

// note: this file should not import "vscode" so that it can be unit tested

/** How a watched file changed. */
export type WatchedFileChange = "created" | "changed" | "deleted";

/** What's at a path, without following a symlink at the end of it. */
export interface PathStat {
  kind: PathKind;
  /** Identifies the file system entry (ex. its device and inode), which changes when it's replaced. */
  identity: string;
}

export interface DirWatchersOptions {
  /** Gets what's at the path without following a symlink at the end of it (ex. `lstatPath`). */
  lstat(path: string): Promise<PathStat | undefined>;
  /**
   * Watches the files with the names in the directory without its subdirectories (ex. a vscode watcher
   * of a pattern without a separator), which calls back with the path of a file that changed.
   */
  watchDir(
    dirPath: string,
    fileNames: readonly string[],
    onChange: (filePath: string, change: WatchedFileChange) => void,
  ): { dispose(): void };
  /** Called when one of the files that a directory is watched for changed. */
  onChange(filePath: string, change: WatchedFileChange): void;
  /** Called when checking a directory again after its parent's watcher reported it failed. */
  onError(err: unknown): void;
  /** Whether file names are compared without their case (ex. on Windows and macOS). */
  isCaseInsensitive: boolean;
  /**
   * Gets whether the directory is a workspace folder or one of its ancestor directories, which is
   * watched even when it's a symlink because the user opened the workspace folder through it (ex. a
   * workspace folder opened through a symlink, or macOS's `/tmp`, which is `/private/tmp`), where
   * dprint provides the paths the editor knows.
   */
  isWorkspaceFolderOrAncestor(dirPath: string): boolean;
}

/**
 * Watches files by watching their directories, so a watcher doesn't follow the symlinks in the
 * directory it watches. Following one reaches what it points to, which may be on another machine
 * that the user didn't allow reading (ex. a config file that a `git pull` replaced with a symlink
 * to a share). A directory that's itself a symlink, or that's reached through one, isn't watched or
 * looked in either (see `lstatWithoutSymlinks`), apart from a workspace folder or one of its ancestor
 * directories, which the user opened it through. That holds for a directory that dprint provided too,
 * because it may have been replaced with a symlink since.
 *
 * A directory and its parent (which is watched for the directory's name) are checked again on each
 * update and when the parent's watcher reports the directory, and a watcher is replaced when what it
 * watches was replaced. When the watcher of a directory is replaced or removed, its files are reported
 * as created or deleted, because the files that were created with it aren't reported by the new
 * watcher. Note that vscode polls a watched directory that was deleted until it exists again and then
 * watches it again by itself (following a symlink that replaced it), which can't be turned off, so the
 * watcher of a parent that's gone is disposed once that's noticed.
 */
export class DirWatchers {
  readonly #options: DirWatchersOptions;
  /** The directories that are watched by their path. */
  readonly #entries = new Map<string, DirEntry>();
  #queue = Promise.resolve();
  #disposed = false;

  constructor(options: DirWatchersOptions) {
    this.#options = options;
  }

  /**
   * Watches the directories for the names of the files in them and stops watching the others. A
   * directory that doesn't exist isn't watched until it does, and neither is one that's a symlink
   * apart from a workspace folder or one of its ancestors (ex. a `.config` directory that's a symlink).
   */
  update(fileNamesByDir: ReadonlyMap<string, readonly string[]>): Promise<void> {
    return this.#enqueue(() => this.#apply(fileNamesByDir));
  }

  dispose() {
    this.#disposed = true;
    for (const entry of this.#entries.values()) {
      disposeEntry(entry);
    }
    this.#entries.clear();
  }

  async #apply(fileNamesByDir: ReadonlyMap<string, readonly string[]>) {
    for (const [dirPath, entry] of [...this.#entries]) {
      const fileNames = fileNamesByDir.get(dirPath);
      if (fileNames == null || !this.#isSameNames(entry.fileNames, fileNames)) {
        disposeEntry(entry);
        this.#entries.delete(dirPath);
      }
    }
    // the directories that are looked at, which the entries share
    const statCache: StatCache = new Map();
    for (const [dirPath, fileNames] of fileNamesByDir) {
      let entry = this.#entries.get(dirPath);
      if (entry == null) {
        entry = { fileNames: new Set(fileNames.map(name => this.#normalizeName(name))), originalNames: fileNames };
        this.#entries.set(dirPath, entry);
      }
      await this.#check(dirPath, entry, statCache);
    }
  }

  /** Watches the directory and its parent while each may be watched, with a new watcher when it was replaced. */
  async #check(dirPath: string, entry: DirEntry, statCache: StatCache) {
    const parentPath = path.dirname(dirPath);
    if (parentPath !== dirPath) {
      const name = this.#normalizeName(path.basename(dirPath));
      entry.parentWatcher = await this.#replaceWatcher(
        entry.parentWatcher,
        parentPath,
        statCache,
        dirPath,
        entry,
        () =>
          this.#options.watchDir(parentPath, [path.basename(dirPath)], filePath => {
            if (this.#normalizeName(getFileName(filePath)) === name) {
              this.#enqueue(() => this.#check(dirPath, entry, new Map())).catch(err => this.#options.onError(err));
            }
          }),
      );
    }
    const previous = entry.dirWatcher;
    entry.dirWatcher = await this.#replaceWatcher(
      previous,
      dirPath,
      statCache,
      dirPath,
      entry,
      () =>
        this.#options.watchDir(dirPath, entry.originalNames, (filePath, change) => {
          if (entry.fileNames.has(this.#normalizeName(getFileName(filePath)))) {
            this.#options.onChange(filePath, change);
          }
        }),
    );
    if (entry.dirWatcher !== previous && entry.wasWatched && !this.#isStale(dirPath, entry)) {
      await this.#reportFiles(dirPath, entry);
    }
    entry.wasWatched ||= entry.dirWatcher != null;
  }

  /**
   * Gets the watcher of a directory while it may be watched (see `#isWatchable`), which is the current
   * one unless what it watches was replaced, and undefined otherwise.
   */
  async #replaceWatcher(
    current: IdentifiedWatcher | undefined,
    watchedPath: string,
    statCache: StatCache,
    entryPath: string,
    entry: DirEntry,
    watch: () => { dispose(): void },
  ): Promise<IdentifiedWatcher | undefined> {
    if (this.#isStale(entryPath, entry)) {
      return current;
    }
    const result = await lstatWithoutSymlinks(watchedPath, this.#options, statCache);
    if (this.#isStale(entryPath, entry)) {
      return current; // it was disposed with the entry
    }
    const stat = result.isReachable ? result.stat : undefined;
    const identity = stat != null && this.#isWatchable(watchedPath, stat.kind) ? stat.identity : undefined;
    // ex. it only changed because a file in it was saved, which is a change of it on Windows
    if (current?.identity === identity) {
      return current;
    }
    current?.dispose();
    if (identity == null) {
      return undefined;
    }
    const watcher = watch();
    return { identity, dispose: () => watcher.dispose() };
  }

  /**
   * Reports the files of a directory whose watcher was replaced or removed as created or deleted, which
   * dprint checks itself (ex. a package directory that `npm install` created again with its files).
   */
  async #reportFiles(dirPath: string, entry: DirEntry) {
    for (const name of entry.originalNames) {
      const filePath = path.join(dirPath, name);
      // the directory was looked at, so its files are looked at without following a symlink
      const stat = entry.dirWatcher == null ? undefined : await this.#options.lstat(filePath).catch(() => undefined);
      if (this.#isStale(dirPath, entry)) {
        return;
      }
      this.#options.onChange(filePath, stat == null ? "deleted" : "created");
    }
  }

  /**
   * Whether a directory may be watched, which isn't one that's a symlink apart from a workspace folder
   * or one of its ancestors.
   */
  #isWatchable(dirPath: string, kind: PathKind) {
    return kind === "dir" || (kind === "symlink" && this.#options.isWorkspaceFolderOrAncestor(dirPath));
  }

  /** Runs the task after the ones before it, whether or not they failed. */
  #enqueue(task: () => Promise<void>) {
    const run = this.#queue.then(task);
    this.#queue = run.catch(() => {/* the caller handles it */});
    return run;
  }

  /** Whether the entry isn't used anymore (ex. it was disposed while its directory was checked). */
  #isStale(dirPath: string, entry: DirEntry) {
    return this.#disposed || this.#entries.get(dirPath) !== entry;
  }

  #isSameNames(names: Set<string>, fileNames: readonly string[]) {
    const otherNames = new Set(fileNames.map(name => this.#normalizeName(name)));
    return names.size === otherNames.size && [...names].every(name => otherNames.has(name));
  }

  #normalizeName(name: string) {
    return this.#options.isCaseInsensitive ? name.toLowerCase() : name;
  }
}

/** What's at a path, when it could be looked at without following a symlink (see `lstatWithoutSymlinks`). */
export type ReachableStat = { isReachable: true; stat: PathStat | undefined } | { isReachable: false };

/** What was found at the paths that were looked at, which is shared by the lookups of one update. */
export type StatCache = Map<string, Promise<PathStat | undefined>>;

/**
 * Gets what's at a path without following a symlink in it, because `lstat` only doesn't follow the last
 * part of a path: each directory above it is looked at first, from the nearest workspace folder (or one
 * of its ancestors, which may be symlinks because the user opened the workspace folder through them)
 * down. It's not reachable when one of them is a symlink, and gone when one of them doesn't exist.
 */
export async function lstatWithoutSymlinks(
  filePath: string,
  options: Pick<DirWatchersOptions, "lstat" | "isWorkspaceFolderOrAncestor">,
  statCache: StatCache = new Map(),
): Promise<ReachableStat> {
  const parentPath = path.dirname(filePath);
  if (parentPath !== filePath && !options.isWorkspaceFolderOrAncestor(parentPath)) {
    const parent = await lstatWithoutSymlinks(parentPath, options, statCache);
    if (!parent.isReachable || parent.stat?.kind === "symlink") {
      return { isReachable: false };
    }
    if (parent.stat?.kind !== "dir") {
      return { isReachable: true, stat: undefined };
    }
  }
  let stat = statCache.get(filePath);
  if (stat == null) {
    stat = options.lstat(filePath).catch(() => undefined);
    statCache.set(filePath, stat);
  }
  return { isReachable: true, stat: await stat };
}

/**
 * Gets what's at the path without following a symlink at the end of it. Its identity is its device and
 * inode, which a directory that replaced another may reuse, but vscode watches one that's deleted and
 * created again by itself, and one that's replaced with a symlink is told apart by its kind.
 */
export async function lstatPath(filePath: string): Promise<PathStat | undefined> {
  try {
    const stat = await fs.promises.lstat(filePath, { bigint: true });
    return {
      kind: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : "file",
      identity: `${stat.dev}:${stat.ino}`,
    };
  } catch {
    return undefined;
  }
}

/**
 * Gets the names of the files by their directories (ex. for the files the config files were resolved
 * from, which are watched by their directories).
 */
export function getFileNamesByDir(filePaths: Iterable<string>) {
  const fileNamesByDir = new Map<string, string[]>();
  for (const filePath of filePaths) {
    const dirPath = path.dirname(filePath);
    fileNamesByDir.set(dirPath, [...fileNamesByDir.get(dirPath) ?? [], path.basename(filePath)]);
  }
  return fileNamesByDir;
}

/**
 * Gets the glob of a watcher of the files with the names in a directory, which has no separator so
 * the watcher doesn't watch the subdirectories. A name with a glob's special characters is matched by
 * `*` instead, which `DirWatchers` filters.
 */
export function getWatchPattern(fileNames: readonly string[]) {
  if (fileNames.some(name => /[*?[\]{},/\\]/.test(name))) {
    return "*";
  }
  return fileNames.length === 1 ? fileNames[0] : `{${fileNames.join(",")}}`;
}

/**
 * Gets the keys (see `getWatchedPathKey`) of the workspace folders and their ancestor directories, which
 * a directory that's a symlink may be watched for.
 */
export function getWorkspaceFolderAndAncestorKeys(folderPaths: readonly string[], isCaseInsensitive: boolean) {
  const keys = new Set<string>();
  for (const folderPath of folderPaths) {
    for (let current = path.resolve(folderPath);; current = path.dirname(current)) {
      keys.add(getWatchedPathKey(current, isCaseInsensitive));
      if (path.dirname(current) === current) {
        break;
      }
    }
  }
  return keys;
}

/** Gets what identifies a watched file's path, which is without its case when the file system is. */
export function getWatchedPathKey(filePath: string, isCaseInsensitive: boolean) {
  return isCaseInsensitive ? filePath.toLowerCase() : filePath;
}

interface DirEntry {
  /** The names of the files it's watched for, without their case when the file system is. */
  fileNames: Set<string>;
  originalNames: readonly string[];
  /** Watches the parent directory (whose identity it has) for the directory being created, deleted, or replaced. */
  parentWatcher?: IdentifiedWatcher;
  /** Watches the directory (whose identity it has), which is undefined while it isn't watched. */
  dirWatcher?: IdentifiedWatcher;
  /** Whether the directory was watched, after which a new or removed watcher reports its files. */
  wasWatched?: boolean;
}

interface IdentifiedWatcher {
  identity: string;
  dispose(): void;
}

function disposeEntry(entry: DirEntry) {
  entry.parentWatcher?.dispose();
  entry.dirWatcher?.dispose();
}

/** Gets the name of the file at the path, which may use either separator. */
function getFileName(filePath: string) {
  return filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1);
}
