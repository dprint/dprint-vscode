import * as fs from "node:fs";
import * as path from "node:path";
import { toCaseInsensitiveNameGlob } from "../constants";
import type { PathKind } from "../environment";

// note: this file should not import "vscode" so that it can be unit tested

/** How a watched file changed. */
export type WatchedFileChange = "created" | "changed" | "deleted";

/** What's at a path, without following a symlink at the end of it. */
export interface PathStat {
  kind: PathKind;
  /** Identifies the file system entry (ex. its device and inode), which changes when it's replaced. */
  identity: string;
  /** What changes when a file's contents do (ex. its modification time and size). */
  version?: string;
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
  /** Called when what a watcher started failed (ex. checking a directory that its parent's watcher reported). */
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
 * A directory and its parent (which is watched for the directory's name, or the nearest ancestor that may
 * be watched for the name of the next directory toward it when the parent isn't there) are checked again on each
 * update and when the parent's watcher reports the directory, and a watcher is replaced when what it
 * watches was replaced. Then its files whose versions changed since they were last looked at (which
 * includes their identity) are reported, because a new watcher doesn't report the files that were
 * created with the directory, and a directory that was deleted and created again may keep its identity
 * (ex. ext4 reuses the inode it just freed). Its watcher is replaced too when one of them was created
 * or deleted, so vscode watches the new directory right away. Note that vscode polls a watched directory
 * that was deleted until it exists again and then watches it again by itself (following a symlink that
 * replaced it), which can't be turned off, so the watcher of a parent that's gone is disposed once that's
 * noticed.
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
      if (fileNames == null || !this.#isSameNames(entry.names, fileNames)) {
        disposeEntry(entry);
        this.#entries.delete(dirPath);
      }
    }
    // the directories that are looked at, which the entries share
    const statCache: StatCache = new Map();
    for (const [dirPath, fileNames] of fileNamesByDir) {
      let entry = this.#entries.get(dirPath);
      if (entry == null) {
        entry = { names: new Map(fileNames.map(name => [this.#normalizeName(name), name])) };
        this.#entries.set(dirPath, entry);
      }
      await this.#check(dirPath, entry, statCache);
    }
  }

  /**
   * Watches the directory and its parent while each may be watched, with a new watcher when it was
   * replaced, and reports the directory's files that may have changed without its watcher seeing it.
   *
   * @param isParentReport - Whether the parent's watcher reported the directory, which may have been
   * deleted and created again with the same identity (ex. ext4 reuses the inode it just freed).
   */
  async #check(dirPath: string, entry: DirEntry, statCache: StatCache, isParentReport = false) {
    // its parent, or the nearest ancestor that may be watched when that isn't there (ex. a package directory
    // in a `node_modules` that doesn't exist yet), is watched for the name of the next directory toward it
    const ancestor = await this.#findWatchableAncestor(dirPath, statCache);
    if (this.#isStale(dirPath, entry)) {
      return;
    }
    entry.parentWatcher = swapWatcher(
      entry.parentWatcher,
      ancestor == null ? undefined : `${ancestor.path}\n${ancestor.identity}`,
      () => {
        const childName = path.relative(ancestor!.path, dirPath).split(/[\\/]/)[0];
        return this.#options.watchDir(ancestor!.path, [childName], filePath => {
          if (this.#normalizeName(getFileName(filePath)) === this.#normalizeName(childName)) {
            this.#enqueue(() => this.#check(dirPath, entry, new Map(), true)).catch(err => this.#options.onError(err));
          }
        });
      },
    );
    const identity = await this.#getWatchableIdentity(dirPath, statCache);
    if (this.#isStale(dirPath, entry)) {
      return;
    }
    const previous = entry.dirWatcher;
    entry.dirWatcher = swapWatcher(previous, identity, () => this.#watchDir(dirPath, entry));
    if (entry.dirWatcher == null) {
      // its files are missing, so the ones created with it are reported once it's watched
      entry.fileVersions ??= new Map();
    }
    if (entry.dirWatcher === previous && !isParentReport) {
      return;
    }
    const hasCreatedOrDeleted = await this.#reportFiles(dirPath, entry);
    if (hasCreatedOrDeleted && entry.dirWatcher === previous && entry.dirWatcher != null) {
      // ex. it was deleted and created again with the same identity, which vscode may not watch yet
      entry.dirWatcher = swapWatcher(
        entry.dirWatcher,
        entry.dirWatcher.identity,
        () => this.#watchDir(dirPath, entry),
        {
          isReplaced: true,
        },
      );
    }
  }

  /** Watches the directory for its files, which notes the version of each one it reports (see `#reportFiles`). */
  #watchDir(dirPath: string, entry: DirEntry) {
    return this.#options.watchDir(dirPath, [...entry.names.values()], (filePath, change) => {
      const name = entry.names.get(this.#normalizeName(getFileName(filePath)));
      if (name == null) {
        return;
      }
      this.#options.onChange(filePath, change);
      // so a later report of the directory by its parent doesn't report it again (ex. on each save on Windows),
      // though one that's handled before this event reports it twice, which dprint handles like one
      this.#enqueue(async () => {
        const version = await this.#getFileVersion(dirPath, entry, name);
        if (!this.#isStale(dirPath, entry)) {
          entry.fileVersions?.set(name, version);
        }
      }).catch(err => this.#options.onError(err));
    });
  }

  /** Gets the nearest ancestor of the directory that may be watched (see `#isWatchable`), with its identity. */
  async #findWatchableAncestor(dirPath: string, statCache: StatCache) {
    for (let current = path.dirname(dirPath); current !== dirPath; dirPath = current, current = path.dirname(current)) {
      const identity = await this.#getWatchableIdentity(current, statCache);
      if (identity != null) {
        return { path: current, identity };
      }
    }
    return undefined;
  }

  /**
   * Gets the identity of a directory while it may be watched (see `#isWatchable`), which is undefined
   * when it may not.
   */
  async #getWatchableIdentity(dirPath: string, statCache: StatCache) {
    const result = await lstatWithoutSymlinks(dirPath, this.#options, statCache);
    const stat = result.isReachable ? result.stat : undefined;
    return stat != null && this.#isWatchable(dirPath, stat.kind) ? stat.identity : undefined;
  }

  /**
   * Notes the versions of a directory's files, and reports the ones that changed since they were noted as
   * created, changed, or deleted, which dprint checks itself (ex. a package directory that `npm install`
   * created again with its files). The first time, they're only noted. Resolves with whether one of them
   * was created or deleted.
   */
  async #reportFiles(dirPath: string, entry: DirEntry) {
    const versions = new Map<string, string | undefined>();
    let hasCreatedOrDeleted = false;
    for (const name of entry.names.values()) {
      const version = await this.#getFileVersion(dirPath, entry, name);
      if (this.#isStale(dirPath, entry)) {
        return false;
      }
      versions.set(name, version);
      if (entry.fileVersions == null) {
        continue;
      }
      const previousVersion = entry.fileVersions.get(name);
      if (version !== previousVersion) {
        hasCreatedOrDeleted ||= version == null || previousVersion == null;
        const change = version == null ? "deleted" : previousVersion == null ? "created" : "changed";
        this.#options.onChange(path.join(dirPath, name), change);
      }
    }
    entry.fileVersions = versions;
    return hasCreatedOrDeleted;
  }

  /**
   * Gets the version of a watched directory's file, which is undefined when it's gone or the directory
   * isn't watched.
   */
  async #getFileVersion(dirPath: string, entry: DirEntry, name: string) {
    // the directory was looked at, so its files are looked at without following a symlink
    const stat = entry.dirWatcher == null
      ? undefined
      : await this.#options.lstat(path.join(dirPath, name)).catch(() => undefined);
    return stat == null ? undefined : `${stat.identity}:${stat.version ?? ""}`;
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

  #isSameNames(names: Map<string, string>, fileNames: readonly string[]) {
    const otherNames = new Set(fileNames.map(name => this.#normalizeName(name)));
    return names.size === otherNames.size && [...names.keys()].every(name => otherNames.has(name));
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
 * inode, which a directory that replaced another may reuse (ex. on ext4), so the files of a directory
 * that its parent's watcher reports are compared with their versions too (see `DirWatchers`), and one
 * that's replaced with a symlink is told apart by its kind.
 */
export async function lstatPath(filePath: string): Promise<PathStat | undefined> {
  try {
    const stat = await fs.promises.lstat(filePath, { bigint: true });
    return {
      kind: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : "file",
      identity: `${stat.dev}:${stat.ino}`,
      version: `${stat.mtimeNs}:${stat.size}`,
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
 * `*` instead, which `DirWatchers` filters. The names match in either case on a case insensitive file
 * system, because vscode's globs don't.
 */
export function getWatchPattern(fileNames: readonly string[], isCaseInsensitive: boolean) {
  // a letter other than an ASCII one has a case that the classes don't cover, which `DirWatchers` compares
  const hasOtherCase = (name: string) =>
    [...name].some(char => char > "\x7f" && char.toLowerCase() !== char.toUpperCase());
  if (fileNames.some(name => /[*?[\]{},/\\]/.test(name) || (isCaseInsensitive && hasOtherCase(name)))) {
    return "*";
  }
  const names = isCaseInsensitive ? fileNames.map(toCaseInsensitiveNameGlob) : fileNames;
  return names.length === 1 ? names[0] : `{${names.join(",")}}`;
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
  /** The names of the files it's watched for by their names without their case when the file system is. */
  names: Map<string, string>;
  /** Watches the parent directory (whose identity it has) for the directory being created, deleted, or replaced. */
  parentWatcher?: IdentifiedWatcher;
  /** Watches the directory (whose identity it has), which is undefined while it isn't watched. */
  dirWatcher?: IdentifiedWatcher;
  /**
   * The versions of its files by their names when they were last looked at, after which the ones whose
   * versions changed are reported. It's undefined until its first check, and empty (each file missing)
   * when the directory wasn't there then, so the files created with it are reported.
   */
  fileVersions?: Map<string, string | undefined>;
}

interface IdentifiedWatcher {
  identity: string;
  dispose(): void;
}

/**
 * Gets the watcher of what has the identity, which is the current one when it has it (unless it's replaced
 * anyway), and undefined without one.
 */
function swapWatcher(
  current: IdentifiedWatcher | undefined,
  identity: string | undefined,
  watch: () => { dispose(): void },
  options: { isReplaced?: boolean } = {},
): IdentifiedWatcher | undefined {
  // ex. it only changed because a file in it was saved, which is a change of it on Windows
  if (current?.identity === identity && !options.isReplaced) {
    return current;
  }
  current?.dispose();
  if (identity == null) {
    return undefined;
  }
  const watcher = watch();
  return { identity, dispose: () => watcher.dispose() };
}

function disposeEntry(entry: DirEntry) {
  entry.parentWatcher?.dispose();
  entry.dirWatcher?.dispose();
}

/** Gets the name of the file at the path, which may use either separator. */
function getFileName(filePath: string) {
  return filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1);
}
