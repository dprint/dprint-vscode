import * as path from "node:path";
import type { PathKind } from "../environment";

// note: this file should not import "vscode" so that it can be unit tested

/** How a watched file changed. */
export type WatchedFileChange = "created" | "changed" | "deleted";

export interface DirWatchersOptions {
  /** Gets what's at the path without following a symlink at the end of it. */
  pathKind(path: string): Promise<PathKind | undefined>;
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
  /** Called when checking a directory again after it was created or deleted failed. */
  onError(err: unknown): void;
  /** Whether file names are compared without their case (ex. on Windows and macOS). */
  isCaseInsensitive: boolean;
}

/**
 * Watches files by watching their directories, so a watcher never follows a symlink: one that's a
 * file in the directory isn't followed, and a directory that's itself a symlink isn't watched (a
 * watcher of it, ex. vscode's, watches what it points to). Following one reaches what it points to,
 * which may be on another machine that the user didn't allow reading (ex. a config file that a
 * `git pull` replaced with a symlink to a share).
 *
 * A directory is checked again on each update, and when its parent directory (which is watched for
 * its name) says it was created, deleted, or replaced, so one that's replaced with a symlink stops
 * being watched and one that's created again is watched again with a new watcher.
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
   * directory that doesn't exist or is a symlink isn't watched (ex. a `.config` directory that's a
   * symlink) until it's a directory.
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
    for (const [dirPath, fileNames] of fileNamesByDir) {
      if (this.#disposed) {
        return;
      }
      let entry = this.#entries.get(dirPath);
      if (entry == null) {
        entry = { fileNames: new Set(fileNames.map(name => this.#normalizeName(name))), originalNames: fileNames };
        this.#entries.set(dirPath, entry);
      }
      if (entry.parentWatcher == null) {
        await this.#watchParent(dirPath, entry);
      }
      await this.#check(dirPath, entry, { isRecreated: false });
    }
  }

  /** Watches the parent directory for the directory's name, unless the parent is a symlink too. */
  async #watchParent(dirPath: string, entry: DirEntry) {
    const parentPath = path.dirname(dirPath);
    if (parentPath === dirPath || await this.#pathKind(parentPath) !== "dir" || this.#isStale(dirPath, entry)) {
      return;
    }
    const name = path.basename(dirPath);
    entry.parentWatcher = this.#options.watchDir(parentPath, [name], filePath => {
      if (this.#normalizeName(getFileName(filePath)) === this.#normalizeName(name)) {
        this.#enqueue(() => this.#check(dirPath, entry, { isRecreated: true })).catch(err =>
          this.#options.onError(err)
        );
      }
    });
  }

  /**
   * Watches the directory when it's a directory and stops watching it otherwise. One that was
   * created or replaced is watched with a new watcher, because the old one may watch what a
   * symlink that replaced it points to.
   */
  async #check(dirPath: string, entry: DirEntry, options: { isRecreated: boolean }) {
    if (this.#isStale(dirPath, entry)) {
      return;
    }
    if (options.isRecreated) {
      entry.dirWatcher?.dispose();
      entry.dirWatcher = undefined;
    }
    const kind = await this.#pathKind(dirPath);
    if (this.#isStale(dirPath, entry)) {
      return;
    }
    if (kind !== "dir") {
      entry.dirWatcher?.dispose();
      entry.dirWatcher = undefined;
    } else if (entry.dirWatcher == null) {
      entry.dirWatcher = this.#options.watchDir(dirPath, entry.originalNames, (filePath, change) => {
        if (entry.fileNames.has(this.#normalizeName(getFileName(filePath)))) {
          this.#options.onChange(filePath, change);
        }
      });
    }
  }

  /** Runs the task after the ones before it, whether or not they failed. */
  #enqueue(task: () => Promise<void>) {
    const run = this.#queue.then(task);
    this.#queue = run.catch(() => {/* the caller handles it */});
    return run;
  }

  #pathKind(filePath: string) {
    return this.#options.pathKind(filePath).catch(() => undefined);
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

/** Gets what identifies a watched file's path, which is without its case when the file system is. */
export function getWatchedPathKey(filePath: string, isCaseInsensitive: boolean) {
  return isCaseInsensitive ? filePath.toLowerCase() : filePath;
}

interface DirEntry {
  /** The names of the files it's watched for, without their case when the file system is. */
  fileNames: Set<string>;
  originalNames: readonly string[];
  /** Watches the parent directory for the directory being created, deleted, or replaced. */
  parentWatcher?: { dispose(): void };
  /** Watches the directory, which is undefined while it isn't a directory. */
  dirWatcher?: { dispose(): void };
}

function disposeEntry(entry: DirEntry) {
  entry.parentWatcher?.dispose();
  entry.dirWatcher?.dispose();
}

/** Gets the name of the file at the path, which may use either separator. */
function getFileName(filePath: string) {
  return filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1);
}
