import type { PathKind } from "../environment";

// note: this file should not import "vscode" so that it can be unit tested

/** How a watched file changed. */
export type WatchedFileChange = "created" | "changed" | "deleted";

export interface DirWatchersOptions {
  /** Gets what's at the path without following a symlink at the end of it. */
  pathKind(path: string): Promise<PathKind | undefined>;
  /**
   * Watches the files in the directory without its subdirectories (ex. a vscode watcher of `*` in it),
   * which calls back with the path of a file that changed.
   */
  watchDir(dirPath: string, onChange: (filePath: string, change: WatchedFileChange) => void): { dispose(): void };
  /** Called when one of the files that a directory is watched for changed. */
  onChange(filePath: string, change: WatchedFileChange): void;
  /** Whether file names are compared without their case (ex. on Windows and macOS). */
  isCaseInsensitive: boolean;
}

/**
 * Watches files by watching their directories, so a watcher never follows a symlink: one that's a
 * file in the directory isn't followed, and a directory that's itself a symlink isn't watched (a
 * watcher of it, ex. vscode's, watches what it points to). Following one reaches what it points to,
 * which may be on another machine that the user didn't allow reading (ex. a config file that a
 * `git pull` replaced with a symlink to a share).
 */
export class DirWatchers {
  readonly #options: DirWatchersOptions;
  /** The watchers by the path of their directory, with the names of the files they're for. */
  readonly #watchers = new Map<string, { fileNames: Set<string>; dispose(): void }>();
  #update = Promise.resolve();
  #disposed = false;

  constructor(options: DirWatchersOptions) {
    this.#options = options;
  }

  /**
   * Watches the directories for the names of the files in them and stops watching the others. A
   * directory that doesn't exist or is a symlink isn't watched (ex. a `.config` directory that's a
   * symlink), which is looked at again on the next update.
   */
  update(fileNamesByDir: ReadonlyMap<string, readonly string[]>): Promise<void> {
    this.#update = this.#update.then(() => this.#apply(fileNamesByDir));
    return this.#update;
  }

  dispose() {
    this.#disposed = true;
    for (const watcher of this.#watchers.values()) {
      watcher.dispose();
    }
    this.#watchers.clear();
  }

  async #apply(fileNamesByDir: ReadonlyMap<string, readonly string[]>) {
    for (const [dirPath, watcher] of [...this.#watchers]) {
      const fileNames = fileNamesByDir.get(dirPath);
      if (fileNames == null || !this.#isSameNames(watcher.fileNames, fileNames)) {
        watcher.dispose();
        this.#watchers.delete(dirPath);
      }
    }
    for (const [dirPath, fileNames] of fileNamesByDir) {
      if (this.#disposed) {
        return;
      }
      if (this.#watchers.has(dirPath)) {
        continue;
      }
      const kind = await this.#options.pathKind(dirPath).catch(() => undefined);
      if (this.#disposed) {
        return;
      }
      if (kind !== "dir") {
        continue;
      }
      const names = new Set(fileNames.map(name => this.#normalizeName(name)));
      const watcher = this.#options.watchDir(dirPath, (filePath, change) => {
        if (names.has(this.#normalizeName(getFileName(filePath)))) {
          this.#options.onChange(filePath, change);
        }
      });
      this.#watchers.set(dirPath, { fileNames: names, dispose: () => watcher.dispose() });
    }
  }

  #isSameNames(names: Set<string>, fileNames: readonly string[]) {
    const otherNames = new Set(fileNames.map(name => this.#normalizeName(name)));
    return names.size === otherNames.size && [...names].every(name => otherNames.has(name));
  }

  #normalizeName(name: string) {
    return this.#options.isCaseInsensitive ? name.toLowerCase() : name;
  }
}

/** Gets the name of the file at the path, which may use either separator. */
function getFileName(filePath: string) {
  return filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1);
}
