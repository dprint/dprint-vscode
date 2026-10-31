import type { ConfigInfoResult } from "./messages";

// note: this file should not import "vscode" so that it can be unit tested

/**
 * Watches the directories of the config files in ancestor directories of the workspace folders,
 * which is done once for each directory. One on another machine isn't watched until it's allowed,
 * because watching it follows its symlink like reading it does.
 */
export class AncestorConfigFileWatchers {
  readonly #createWatcher: (dirPath: string) => { dispose(): void } | undefined;
  /** The watchers by the path of their directory. */
  readonly #watchers = new Map<string, { dispose(): void }>();

  /** @param createWatcher - Watches the directory, which is undefined when it doesn't need to be (ex. it's in a workspace folder). */
  constructor(createWatcher: (dirPath: string) => { dispose(): void } | undefined) {
    this.#createWatcher = createWatcher;
  }

  /** Watches the directory of a config file that isn't formatted with a dprint process, which doesn't say where it is. */
  watch(dirPath: string) {
    if (this.#watchers.has(dirPath)) {
      return;
    }
    const watcher = this.#createWatcher(dirPath);
    if (watcher != null) {
      this.#watchers.set(dirPath, watcher);
    }
  }

  /**
   * Watches the directories of the config files that dprint said aren't on another machine, and stops
   * watching the ones it says are (ex. a watched one that was replaced with a symlink, which vscode says
   * was changed rather than created). dprint sends dprint/configChanged once one is allowed, and the
   * next result no longer says it's on another machine, which is when it's watched.
   */
  update(configFiles: readonly { dirPath: string; info: Pick<ConfigInfoResult, "configFile"> }[]) {
    for (const { dirPath, info } of configFiles) {
      if (info.configFile?.onAnotherMachine) {
        this.#watchers.get(dirPath)?.dispose();
        this.#watchers.delete(dirPath);
      } else {
        this.watch(dirPath);
      }
    }
  }

  dispose() {
    for (const watcher of this.#watchers.values()) {
      watcher.dispose();
    }
    this.#watchers.clear();
  }
}
