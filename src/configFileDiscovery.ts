// note: this file should not import "vscode" so that it can be unit tested

/** What discovering the workspace's config files needs from the editor. */
export interface ConfigFileDiscoveryHost<TFile> {
  /** Gets if the workspace has any folders. */
  hasWorkspaceFolders(): boolean;
  /** Finds the config files in the workspace with the editor's file search. */
  findFiles(): PromiseLike<TFile[]>;
  /** Finds a config file directly in a workspace folder with the file system API. */
  findRootConfigFile(): Promise<TFile | undefined>;
  delay(ms: number): Promise<void>;
  logger: ConfigFileDiscoveryLogger;
}

export interface ConfigFileDiscoveryLogger {
  logDebug(message: string): void;
  logWarn(message: string): void;
}

/** Finds the config files in the workspace folders. */
export async function discoverConfigFiles<TFile>(host: ConfigFileDiscoveryHost<TFile>): Promise<TFile[]> {
  const logger = host.logger;
  // don't wait for a folder to be added because that may never happen (ex. a multi-root
  // workspace with no folders) and the caller initializes again when the folders change
  if (!host.hasWorkspaceFolders()) {
    return [];
  }
  // See https://github.com/dprint/dprint-vscode/issues/105 -- for some reason findFiles would
  // return no results on very large projects when called too early on startup, so mitigate
  // that by waiting a little bit of time
  await host.delay(250);
  // now try to find the files
  return await attemptFindFiles();

  async function attemptFindFiles() {
    const foundFiles = await host.findFiles();
    if (foundFiles.length === 0) {
      return await attemptFindViaFallback();
    } else {
      return foundFiles;
    }
  }

  async function attemptFindViaFallback() {
    // retry trying to find a config file a few times if there's one found in the root directory
    const rootConfigFile = await host.findRootConfigFile();
    if (rootConfigFile == null) {
      return [];
    }
    let retryCount = 0;
    while (retryCount++ < 4) {
      logger.logDebug("Found config file in root with fs API. Waiting a bit then retrying...");
      await host.delay(1_000);
      const foundFiles = await host.findFiles();
      if (foundFiles.length > 0) {
        logger.logDebug("Found config file after retrying.");
        return foundFiles;
      }
    }

    // we don't glob for files because it's potentially incredibly slow in very large
    // projects
    logger.logWarn(
      "Gave up trying to find config file. Using only root discovered via file system API. "
        + "Maybe you have the dprint config file excluded from vscode? "
        + "Don't do that because then vscode hides the file from the extension and the "
        + "extension otherwise doesn't use the file system APIs to find config files.",
    );
    return [rootConfigFile];
  }
}
