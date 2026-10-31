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
 * Activates the backend that formats using the `dprint/*` methods of dprint's language
 * server when the default dprint executable has them, which is checked again on each
 * initialization. Otherwise, it falls back to the legacy backend, which uses schema
 * version 5 of dprint's editor service with a dprint process for each config file.
 */
export function activateBackend(
  logger: Logger,
  approvedPaths: ApprovedConfigPaths,
  state: { globalState: vscode.Memento; workspaceState: vscode.Memento },
): ExtensionBackend {
  const disposables = new ActivatedDisposables(logger);
  const configSchemaProvider = new ConfigJsonSchemaProvider(logger);
  disposables.push(configSchemaProvider);
  disposables.push(
    vscode.workspace.registerTextDocumentContentProvider(ConfigJsonSchemaProvider.scheme, configSchemaProvider),
  );
  const onDidChangeConfig = new vscode.EventEmitter<void>();
  disposables.push(onDidChangeConfig);
  const workspaceBackend = new WorkspaceBackend({
    approvedPaths,
    configSchemaProvider,
    logger,
    state,
    onAncestorConfigFileCreatedOrDeleted: () => {
      switcher.reInitialize().catch(err => logger.logError("Error initializing:", err));
    },
    onConfigChanged: () => onDidChangeConfig.fire(),
  });
  disposables.push(workspaceBackend);
  const switcher = new BackendSwitcher<ExtensionBackend>({
    initializeWorkspace: (onSupported, options) => workspaceBackend.initialize(onSupported, options),
    createLegacyBackend: () => activateLegacy(logger, approvedPaths, configSchemaProvider),
  });

  return {
    onDidChangeConfig: onDidChangeConfig.event,
    reInitialize(options) {
      return switcher.reInitialize(options);
    },
    affectsInitialization(evt) {
      return (switcher.legacyBackend ?? workspaceBackend).affectsInitialization(evt);
    },
    onConfigFileChanged(uri, type) {
      return switcher.legacyBackend?.onConfigFileChanged(uri, type) ?? workspaceBackend.onConfigFileChanged(uri, type);
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
    get followsConfigFileSymlinks() {
      return switcher.legacyBackend?.followsConfigFileSymlinks ?? false;
    },
    approve() {
      return (switcher.legacyBackend ?? workspaceBackend).approve();
    },
    forgetDecisions() {
      return (switcher.legacyBackend ?? workspaceBackend).forgetDecisions();
    },
    showDecisions() {
      return (switcher.legacyBackend ?? workspaceBackend).showDecisions();
    },
    dispose() {
      switcher.dispose();
      disposables.dispose();
    },
  };
}
