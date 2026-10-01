// note: this file should not import "vscode" so that it can be unit tested

export interface RefreshableFolder {
  /** Gets if dprint was started for the folder. */
  isRunning(): boolean;
  /** Refreshes the folder's plugin information, returning false when it failed. */
  refreshEditorInfo(): Promise<boolean>;
  /** Starts dprint for the folder, restarting it if it's running. */
  initialize(): Promise<boolean>;
}

export type InitializableFolder = Pick<RefreshableFolder, "initialize">;

/** Receives the folder that rejected while starting along with the error. */
export type OnInitializeError<TFolder> = (folder: TFolder, err: unknown) => void;

/**
 * Starts dprint for the folders in parallel, returning the ones that started.
 * A folder that fails to start doesn't prevent the other folders from starting.
 */
export async function initializeFolders<TFolder extends InitializableFolder>(
  folders: readonly TFolder[],
  onInitializeError: OnInitializeError<TFolder>,
): Promise<TFolder[]> {
  const results = await Promise.all(folders.map(folder => tryInitializeFolder(folder, onInitializeError)));
  return folders.filter((_, index) => results[index]);
}

/**
 * Refreshes the plugin information of the running folders after a config file
 * changed and restarts the others (ex. ones that failed to start or had no plugins)
 * along with any whose refresh failed. A folder that fails to restart doesn't
 * prevent the other folders from being refreshed or restarted.
 */
export async function refreshOrRestartFolders<TFolder extends RefreshableFolder>(
  folders: readonly TFolder[],
  onInitializeError: OnInitializeError<TFolder>,
) {
  await Promise.all(folders.map(async folder => {
    if (!folder.isRunning() || !(await folder.refreshEditorInfo())) {
      await tryInitializeFolder(folder, onInitializeError);
    }
  }));
}

/**
 * Starts dprint for the folder, providing the folder and error and returning false instead
 * of rejecting when that fails so that one folder doesn't prevent the others from starting.
 */
export async function tryInitializeFolder<TFolder extends InitializableFolder>(
  folder: TFolder,
  onError: OnInitializeError<TFolder>,
) {
  try {
    return await folder.initialize();
  } catch (err) {
    onError(folder, err);
    return false;
  }
}
