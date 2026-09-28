// note: this file should not import "vscode" so that it can be unit tested

export interface RefreshableFolder {
  isRunning(): boolean;
  /** Refreshes the folder's plugin information, returning false when it failed. */
  refreshEditorInfo(): Promise<boolean>;
}

/**
 * Refreshes the folders' plugin information after a config file changed. Returns
 * false when the folders need to be reinitialized instead, which is when a folder
 * isn't running (ex. it failed to start or had no plugins) or refreshing one failed.
 */
export async function tryRefreshFolders(folders: readonly RefreshableFolder[]) {
  if (folders.some(folder => !folder.isRunning())) {
    return false;
  }
  const results = await Promise.all(folders.map(folder => folder.refreshEditorInfo()));
  return results.every(refreshed => refreshed);
}
