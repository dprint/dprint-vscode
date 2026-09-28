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
 * along with any whose refresh failed.
 */
export async function refreshOrRestartFolders(folders: readonly RefreshableFolder[]) {
  await Promise.all(folders.map(async folder => {
    if (!folder.isRunning() || !(await folder.refreshEditorInfo())) {
      await folder.initialize();
    }
  }));
}
