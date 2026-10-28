import * as vscode from "vscode";
import type { ApprovedConfigPaths } from "./ApprovedConfigPaths";
import { BackendSwitcher } from "./BackendSwitcher";
import { ConfigJsonSchemaProvider } from "./ConfigJsonSchemaProvider";
import type { ExtensionBackend } from "./ExtensionBackend";
import { activateLegacy } from "./legacy/context";
import type { Logger } from "./logger";
import { ActivatedDisposables } from "./utils";
import { WorkspaceBackend } from "./workspace/WorkspaceBackend";

/**
 * Activates the backend that formats using schema version 6 of dprint's editor service
 * when every dprint executable in use supports it, which is checked again on each
 * initialization. Otherwise, it falls back to the legacy backend, which uses schema
 * version 5 with a dprint process for each config file.
 */
export function activateBackend(logger: Logger, approvedPaths: ApprovedConfigPaths): ExtensionBackend {
  const disposables = new ActivatedDisposables(logger);
  const configSchemaProvider = new ConfigJsonSchemaProvider(logger);
  disposables.push(configSchemaProvider);
  disposables.push(
    vscode.workspace.registerTextDocumentContentProvider(ConfigJsonSchemaProvider.scheme, configSchemaProvider),
  );
  const workspaceBackend = new WorkspaceBackend({
    approvedPaths,
    configSchemaProvider,
    logger,
    onAncestorConfigFileCreatedOrDeleted: () => {
      switcher.reInitialize().catch(err => logger.logError("Error initializing:", err));
    },
  });
  disposables.push(workspaceBackend);
  const switcher = new BackendSwitcher<ExtensionBackend>({
    initializeWorkspace: (onSupported, options) => workspaceBackend.initialize(onSupported, options),
    createLegacyBackend: () => activateLegacy(logger, approvedPaths, configSchemaProvider),
  });

  return {
    reInitialize(options) {
      return switcher.reInitialize(options);
    },
    affectsInitialization(evt) {
      return (switcher.legacyBackend ?? workspaceBackend).affectsInitialization(evt);
    },
    onConfigFileChanged() {
      return switcher.legacyBackend?.onConfigFileChanged() ?? workspaceBackend.onConfigFileChanged();
    },
    provideGlobalConfigFormattingEdits(document, range, options, token) {
      return (switcher.legacyBackend ?? workspaceBackend).provideGlobalConfigFormattingEdits(
        document,
        range,
        options,
        token,
      );
    },
    canFormatWithGlobalConfig(document) {
      return (switcher.legacyBackend ?? workspaceBackend).canFormatWithGlobalConfig(document);
    },
    allowProcessPlugins() {
      return (switcher.legacyBackend ?? workspaceBackend).allowProcessPlugins();
    },
    dispose() {
      switcher.dispose();
      disposables.dispose();
    },
  };
}
