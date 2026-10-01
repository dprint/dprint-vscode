// note: this file should not import "vscode" so that it can be unit tested

export interface RefreshableFolder {
  /** Gets if dprint was started for the folder. */
  isRunning(): boolean;
  /** Refreshes the folder's plugin information, returning false when it failed. */
  refreshEditorInfo(): Promise<boolean>;
  /** Starts dprint for the folder, restarting it if it's running. */
  initialize(): Promise<boolean>;
}

/**
 * Refreshes the plugin information of the running folders after a config file
 * changed and restarts the others (ex. ones that failed to start or had no plugins)
 * along with any whose refresh failed. A folder that fails to restart doesn't
 * prevent the other folders from being refreshed or restarted.
 */
export async function refreshOrRestartFolders(
  folders: readonly RefreshableFolder[],
  onInitializeError: (err: unknown) => void,
) {
  await Promise.all(folders.map(async folder => {
    if (!folder.isRunning() || !(await folder.refreshEditorInfo())) {
      await tryInitializeFolder(folder, onInitializeError);
    }
  }));
}

/**
 * Starts dprint for the folder, providing the error and returning false instead of
 * rejecting when that fails so that one folder doesn't prevent the others from starting.
 */
export async function tryInitializeFolder(
  folder: Pick<RefreshableFolder, "initialize">,
  onError: (err: unknown) => void,
) {
  try {
    return await folder.initialize();
  } catch (err) {
    onError(err);
    return false;
  }
}
