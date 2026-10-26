import * as vscode from "vscode";
import type { ApprovedConfigPaths } from "./ApprovedConfigPaths";
import { ConfigJsonSchemaProvider } from "./ConfigJsonSchemaProvider";
import type { ExtensionBackend } from "./ExtensionBackend";
import { activateLegacy } from "./legacy/context";
import type { Logger } from "./logger";
import { ActivatedDisposables, HttpsTextDownloader } from "./utils";
import { WorkspaceBackend } from "./workspace/WorkspaceBackend";

/**
 * Activates the backend that formats using schema version 6 of dprint's editor service
 * when every dprint executable in use supports it, which is checked again on each
 * initialization. Otherwise, it falls back to the legacy backend, which uses schema
 * version 5 with a dprint process for each config file.
 */
export function activateBackend(logger: Logger, approvedPaths: ApprovedConfigPaths): ExtensionBackend {
  const disposables = new ActivatedDisposables(logger);
  const configSchemaProvider = new ConfigJsonSchemaProvider(logger, new HttpsTextDownloader());
  disposables.push(configSchemaProvider);
  disposables.push(
    vscode.workspace.registerTextDocumentContentProvider(ConfigJsonSchemaProvider.scheme, configSchemaProvider),
  );
  const workspaceBackend = new WorkspaceBackend({
    approvedPaths,
    configSchemaProvider,
    logger,
    onAncestorConfigFileCreatedOrDeleted: () => {
      reInitialize().catch(err => logger.logError("Error initializing:", err));
    },
  });
  disposables.push(workspaceBackend);
  let legacyBackend: ExtensionBackend | undefined;
  // the initializations run one at a time because each one may switch the backend
  let initialization = Promise.resolve();

  return {
    reInitialize,
    onConfigFileChanged() {
      return legacyBackend?.onConfigFileChanged() ?? workspaceBackend.onConfigFileChanged();
    },
    provideGlobalConfigFormattingEdits(document, range, options, token) {
      return (legacyBackend ?? workspaceBackend).provideGlobalConfigFormattingEdits(document, range, options, token);
    },
    dispose() {
      legacyBackend?.dispose();
      legacyBackend = undefined;
      disposables.dispose();
    },
  };

  function reInitialize() {
    const result = initialization.then(initialize);
    initialization = result.catch(() => {/* ignore */});
    return result;
  }

  async function initialize() {
    const isSupported = await workspaceBackend.initialize(() => {
      // stop the legacy backend before the formatter is registered again
      legacyBackend?.dispose();
      legacyBackend = undefined;
    });
    if (!isSupported) {
      legacyBackend ??= activateLegacy(logger, approvedPaths, configSchemaProvider);
      await legacyBackend.reInitialize();
    }
  }
}
