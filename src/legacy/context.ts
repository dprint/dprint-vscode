import * as vscode from "vscode";
import type { ApprovedConfigPaths } from "../ApprovedConfigPaths";
import { isDprintExtensionId } from "../constants";
import type { ExtensionBackend } from "../ExtensionBackend";
import type { Logger } from "../logger";
import { ActivatedDisposables, HttpsTextDownloader, ObjectDisposedError } from "../utils";
import { ConfigJsonSchemaProvider } from "./ConfigJsonSchemaProvider";
import { type FolderInfos, WorkspaceService } from "./WorkspaceService";

export function activateLegacy(
  logger: Logger,
  approvedPaths: ApprovedConfigPaths,
): ExtensionBackend {
  const resourceDisposables = new ActivatedDisposables(logger);
  const initializationDisposables = new ActivatedDisposables(logger);
  const workspaceService = new WorkspaceService({
    approvedPaths,
    logger,
    onAncestorConfigFileChanged: reInitialize,
  });
  resourceDisposables.push(workspaceService);

  // todo: add an "onDidOpen" for dprint.json and use the appropriate EditorInfo
  // for ConfigJsonSchemaProvider based on the file that's shown
  const configSchemaProvider = new ConfigJsonSchemaProvider(logger, new HttpsTextDownloader());
  resourceDisposables.push(
    vscode.workspace.registerTextDocumentContentProvider(ConfigJsonSchemaProvider.scheme, configSchemaProvider),
  );

  let disposed = false;
  let folderInfos: FolderInfos = [];
  let registrationKey: string | undefined;
  let registrationUpdate = Promise.resolve();

  // update the formatting registration when the default formatter settings or languages change
  resourceDisposables.push(vscode.workspace.onDidChangeConfiguration(() => scheduleFormattingRegistrationUpdate()));
  resourceDisposables.push(vscode.extensions.onDidChange(() => scheduleFormattingRegistrationUpdate()));

  return {
    isLsp: false,
    reInitialize,
    dispose() {
      disposed = true;
      initializationDisposables.dispose();
      resourceDisposables.dispose();
      logger.logDebug("Disposed legacy backend.");
    },
  };

  async function reInitialize() {
    try {
      folderInfos = await workspaceService.initializeFolders();
      configSchemaProvider.setFolderInfos(folderInfos);
      await scheduleFormattingRegistrationUpdate();
      if (folderInfos.length === 0) {
        logger.logInfo("Configuration file not found.");
      }
    } catch (err) {
      if (!(err instanceof ObjectDisposedError)) {
        logger.logError("Error initializing:", err);
      }
    }
    logger.logDebug("Initialized legacy backend.");
  }

  // Updates run one at a time because getting the languages is async and
  // concurrent updates would otherwise register the providers twice. The key
  // skips re-registering when an unrelated configuration change occurs.
  function scheduleFormattingRegistrationUpdate() {
    registrationUpdate = registrationUpdate
      .then(() => updateFormattingRegistration())
      .catch(err => logger.logError("Error updating formatting registration:", err));
    return registrationUpdate;
  }

  async function updateFormattingRegistration() {
    const workspaceFolderUris = getFormattingWorkspaceFolderUris();
    const defaultFormatterLanguageIds = await getDefaultFormatterLanguageIds();
    if (disposed) {
      return;
    }
    const newRegistrationKey = JSON.stringify([
      workspaceFolderUris.map(uri => uri.toString()),
      defaultFormatterLanguageIds,
    ]);
    if (newRegistrationKey === registrationKey) {
      return;
    }
    registrationKey = newRegistrationKey;
    initializationDisposables.dispose();

    const documentSelector: vscode.DocumentFilter[] = [
      // Match against all files and let the dprint CLI say if it can format a file or not.
      // This is necessary because by using the "associations" feature, a user may pattern
      // match against any file path then format that file using a certain plugin. Additionally,
      // we can't use the "includes" and "excludes" patterns from the config file because we
      // want to ensure consistent path matching behaviour... so don't want to rely on vscode's
      // pattern matching being the same.
      ...workspaceFolderUris.map(uri => ({ scheme: "file", pattern: new vscode.RelativePattern(uri, "**/*") })),
      // Files outside of those are only formatted when the user chose dprint as the
      // default formatter for the language. They're formatted using the file's closest
      // ancestor config file or the global config file. This is limited to those languages
      // so that dprint doesn't cause a "multiple formatters" prompt for other files.
      ...defaultFormatterLanguageIds.map(language => ({ scheme: "file", language })),
    ];
    if (documentSelector.length === 0) {
      return;
    }

    initializationDisposables.push(vscode.languages.registerDocumentFormattingEditProvider(
      documentSelector,
      {
        provideDocumentFormattingEdits(document, options, token) {
          return workspaceService.provideDocumentFormattingEdits(document, options, token);
        },
      },
    ));
    initializationDisposables.push(vscode.languages.registerDocumentRangeFormattingEditProvider(
      documentSelector,
      {
        provideDocumentRangeFormattingEdits(document, range, options, token) {
          return workspaceService.provideDocumentRangeFormattingEdits(document, range, options, token);
        },
      },
    ));
  }

  function getFormattingWorkspaceFolderUris() {
    return folderInfos.filter(folderInfo => folderInfo.editorInfo.plugins.length > 0).map(folderInfo => folderInfo.uri);
  }
}

async function getDefaultFormatterLanguageIds() {
  const languageIds = await vscode.languages.getLanguages();
  return languageIds.filter(languageId => {
    return isDprintExtensionId(vscode.workspace.getConfiguration("editor", { languageId }).get("defaultFormatter"));
  }).sort();
}
