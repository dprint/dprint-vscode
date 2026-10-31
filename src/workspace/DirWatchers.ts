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
  /** Gets what's at the path without following a symlink at the end of it (ex. `lstat`). */
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
 * to a share). A directory that's itself a symlink isn't watched either, because a watcher of it
 * (ex. vscode's) watches what it points to, apart from a workspace folder or one of its ancestor
 * directories, which the user opened it through.
 * That holds for a directory that dprint provided too, because it may have been replaced with a
 * symlink since.
 *
 * The directories above one are looked at too, from the nearest workspace folder (or one of its
 * ancestors) down, because `lstat` follows a symlink before the last part of a path, so one that's
 * reached through a symlink isn't watched or looked at either.
 *
 * Each directory, and its parent (which is watched for the directory's name), is checked again on
 * each update, and the directory is checked again when its parent's watcher reports it, so one
 * that's replaced (ex. with a symlink) stops being watched or is watched with a new watcher, and
 * one that's created again is watched again. Note that vscode polls a watched directory that was
 * deleted until it exists again and then watches it again by itself (following a symlink that
 * replaced it), which can't be turned off, so a parent whose directory is gone stops being watched
 * once that's noticed (on the next update, or when the directory's check finds it gone).
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
    // the directories that are looked at for each update, which the entries share
    const statCache: StatCache = new Map();
    for (const [dirPath, entry] of [...this.#entries]) {
      const fileNames = fileNamesByDir.get(dirPath);
      if (fileNames == null || !this.#isSameNames(entry.fileNames, fileNames)) {
        disposeEntry(entry);
        this.#entries.delete(dirPath);
      }
    }
    for (const [dirPath, fileNames] of fileNamesByDir) {
      if (this.#disposed) {
        return;
      }
      let entry = this.#entries.get(dirPath);
      if (entry == null) {
        entry = { fileNames: new Set(fileNames.map(name => this.#normalizeName(name))), originalNames: fileNames };
        this.#entries.set(dirPath, entry);
      }
      await this.#checkParent(dirPath, entry, statCache);
      await this.#check(dirPath, entry, statCache);
    }
  }

  /**
   * Watches the parent directory for the directory's name while it's a directory (or a workspace
   * folder or one of its ancestors that's a symlink), with a new watcher when it was replaced, and
   * stops watching it otherwise.
   */
  async #checkParent(dirPath: string, entry: DirEntry, statCache: StatCache) {
    const parentPath = path.dirname(dirPath);
    if (parentPath === dirPath) {
      return;
    }
    const stat = await this.#lstat(parentPath, statCache);
    if (this.#isStale(dirPath, entry)) {
      return;
    }
    const identity = stat != null && this.#isWatchable(parentPath, stat.kind) ? stat.identity : undefined;
    if (entry.parentWatcher != null && entry.parentWatcher.identity === identity) {
      return;
    }
    entry.parentWatcher?.dispose();
    entry.parentWatcher = undefined;
    if (identity == null) {
      return;
    }
    const name = path.basename(dirPath);
    const watcher = this.#options.watchDir(parentPath, [name], filePath => {
      if (this.#normalizeName(getFileName(filePath)) === this.#normalizeName(name)) {
        this.#enqueue(() => this.#check(dirPath, entry, new Map())).catch(err => this.#options.onError(err));
      }
    });
    entry.parentWatcher = { identity, dispose: () => watcher.dispose() };
  }

  /**
   * Watches the directory while it's a directory (or a workspace folder or one of its ancestors that's a
   * symlink), with a new
   * watcher when it was replaced, because the old one may watch what a symlink that replaced it points
   * to, and stops watching it otherwise. Its parent is checked again when it's gone, because a parent
   * that was deleted too doesn't report the directory being created again.
   */
  async #check(dirPath: string, entry: DirEntry, statCache: StatCache) {
    if (this.#isStale(dirPath, entry)) {
      return;
    }
    const stat = await this.#lstat(dirPath, statCache);
    if (this.#isStale(dirPath, entry)) {
      return;
    }
    const identity = stat != null && this.#isWatchable(dirPath, stat.kind) ? stat.identity : undefined;
    // ex. it only changed because a file in it was saved, which is a change of it on Windows
    if (entry.dirWatcher != null && entry.dirWatcher.identity === identity) {
      return;
    }
    entry.dirWatcher?.dispose();
    entry.dirWatcher = undefined;
    if (identity == null) {
      if (stat == null) {
        await this.#checkParent(dirPath, entry, statCache);
      }
      return;
    }
    const watcher = this.#options.watchDir(dirPath, entry.originalNames, (filePath, change) => {
      if (entry.fileNames.has(this.#normalizeName(getFileName(filePath)))) {
        this.#options.onChange(filePath, change);
      }
    });
    entry.dirWatcher = { identity, dispose: () => watcher.dispose() };
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

  /** Gets what's at the path, which is undefined when it's gone or reached through a symlink that may not be followed. */
  async #lstat(filePath: string, statCache: StatCache) {
    const result = await lstatWithoutSymlinks(filePath, this.#options, statCache);
    return result.isReachable ? result.stat : undefined;
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

/** Gets whether the directory is one of the workspace folders or one of their ancestor directories. */
export function isWorkspaceFolderOrAncestorPath(
  dirPath: string,
  folderPaths: readonly string[],
  isCaseInsensitive: boolean,
) {
  const key = getWatchedPathKey(path.resolve(dirPath), isCaseInsensitive);
  return folderPaths.some(folderPath => {
    let currentPath = path.resolve(folderPath);
    while (true) {
      if (getWatchedPathKey(currentPath, isCaseInsensitive) === key) {
        return true;
      }
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        return false;
      }
      currentPath = parentPath;
    }
  });
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
