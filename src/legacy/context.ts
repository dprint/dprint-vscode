import * as vscode from "vscode";
import type { ApprovedConfigPaths } from "../ApprovedConfigPaths";
import { FILE_SCHEME, isDprintExtensionId, JUPYTER_NOTEBOOK_TYPE, UNTITLED_SCHEME } from "../constants";
import type { ExtensionBackend } from "../ExtensionBackend";
import type { Logger } from "../logger";
import { hasPluginForFile } from "../pluginFiles";
import { ActivatedDisposables, delay, HttpsTextDownloader, ObjectDisposedError } from "../utils";
import { CoalescingQueue } from "../utils/CoalescingQueue";
import { ConfigJsonSchemaProvider } from "./ConfigJsonSchemaProvider";
import { type FolderInfos, WorkspaceService } from "./WorkspaceService";

/** The scheme of user data files such as the user settings.json. */
const USER_DATA_SCHEME = "vscode-userdata";

export function activateLegacy(
  logger: Logger,
  approvedPaths: ApprovedConfigPaths,
): ExtensionBackend {
  const resourceDisposables = new ActivatedDisposables(logger);
  const initializationDisposables = new ActivatedDisposables(logger);
  const workspaceService = new WorkspaceService({
    approvedPaths,
    logger,
    onAncestorConfigFileCreatedOrDeleted: reInitialize,
    onAncestorConfigFileChanged: scheduleConfigFileRefresh,
    onLooseFolderChanged: scheduleUserDataFilePathsUpdate,
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
  // coalesced because saving a config file often causes multiple change events
  const configFileRefreshQueue = new CoalescingQueue({
    action: refreshAfterConfigFileChange,
    wait: () => delay(100),
  });
  let userDataFilePaths: string[] = [];
  let userDataFilePathsUpdate = Promise.resolve();

  // update the formatting registration when the default formatter settings or languages change
  resourceDisposables.push(vscode.workspace.onDidChangeConfiguration(() => scheduleFormattingRegistrationUpdate()));
  resourceDisposables.push(vscode.extensions.onDidChange(() => scheduleFormattingRegistrationUpdate()));
  // update the user data files (ex. the user settings.json) to format when the visible editors change
  resourceDisposables.push(vscode.window.onDidChangeVisibleTextEditors(() => scheduleUserDataFilePathsUpdate()));

  return {
    reInitialize,
    onConfigFileChanged: scheduleConfigFileRefresh,
    provideGlobalConfigFormattingEdits(document, range, options, token) {
      return workspaceService.provideGlobalConfigFormattingEdits(document, range, options, token);
    },
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
      // don't wait for this because it may need to start dprint for a config outside the workspace
      scheduleUserDataFilePathsUpdate();
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

  function scheduleConfigFileRefresh() {
    return configFileRefreshQueue.schedule();
  }

  /** Refreshes the plugin information after a config file's contents changed. */
  async function refreshAfterConfigFileChange() {
    try {
      folderInfos = await workspaceService.refreshFolders();
      configSchemaProvider.setFolderInfos(folderInfos);
      await scheduleFormattingRegistrationUpdate();
      scheduleUserDataFilePathsUpdate();
      logger.logDebug("Refreshed the plugin information.");
    } catch (err) {
      if (!(err instanceof ObjectDisposedError)) {
        logger.logError("Error refreshing:", err);
      }
    }
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
    const notebookWorkspaceFolderUris = getNotebookFormattingWorkspaceFolderUris();
    const defaultFormatterLanguageIds = await getDefaultFormatterLanguageIds();
    if (disposed) {
      return;
    }
    const newRegistrationKey = JSON.stringify([
      workspaceFolderUris.map(uri => uri.toString()),
      notebookWorkspaceFolderUris.map(uri => uri.toString()),
      defaultFormatterLanguageIds,
      userDataFilePaths,
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
      ...workspaceFolderUris.map(uri => ({ scheme: FILE_SCHEME, pattern: new vscode.RelativePattern(uri, "**/*") })),
      // Notebook cells are formatted when a plugin (the jupyter plugin) formats the notebook
      // (see FolderService). When a notebook type is specified, vscode matches the scheme
      // and pattern against the notebook's uri instead of the cell's.
      ...notebookWorkspaceFolderUris.map(uri => ({
        notebookType: JUPYTER_NOTEBOOK_TYPE,
        scheme: FILE_SCHEME,
        pattern: new vscode.RelativePattern(uri, "**/*"),
      })),
      // Files outside of those are only formatted when the user chose dprint as the
      // default formatter for the language. They're formatted using the file's closest
      // ancestor config file or the global config file. This is limited to those languages
      // so that dprint doesn't cause a "multiple formatters" prompt for other files.
      ...defaultFormatterLanguageIds.flatMap(language => [
        { scheme: FILE_SCHEME, language },
        // untitled documents are formatted as a file in the workspace (see WorkspaceService)
        { scheme: UNTITLED_SCHEME, language },
        { notebookType: JUPYTER_NOTEBOOK_TYPE, scheme: FILE_SCHEME, language },
      ]),
      // User data files (ex. the user settings.json) aren't file scheme documents. They're
      // only registered when a plugin in the file's config can format them.
      ...userDataFilePaths.map(pattern => ({ scheme: USER_DATA_SCHEME, pattern })),
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

  // This is separate from the formatting registration update so that the workspace
  // registration doesn't wait on starting dprint for a config outside the workspace.
  function scheduleUserDataFilePathsUpdate() {
    userDataFilePathsUpdate = userDataFilePathsUpdate
      .then(async () => {
        const newUserDataFilePaths = await getFormattableUserDataFilePaths();
        if (!disposed && JSON.stringify(newUserDataFilePaths) !== JSON.stringify(userDataFilePaths)) {
          userDataFilePaths = newUserDataFilePaths;
          await scheduleFormattingRegistrationUpdate();
        }
      })
      .catch(err => logger.logError("Error updating the user data files to format:", err));
    return userDataFilePathsUpdate;
  }

  /** Gets the paths of the visible user data files that a plugin can format. */
  async function getFormattableUserDataFilePaths() {
    // the user data files are on the local machine, so they can't be formatted from a remote extension host
    if (vscode.env.remoteName != null) {
      return [];
    }
    const uris = vscode.window.visibleTextEditors.map(editor => editor.document.uri).filter(isUserDataUri);
    const canFormat = await Promise.all(uris.map(uri => workspaceService.canFormatWithPlugin(uri)));
    return [...new Set(uris.filter((_, i) => canFormat[i]).map(uri => uri.fsPath))].sort();
  }

  function getFormattingWorkspaceFolderUris() {
    return folderInfos.filter(folderInfo => folderInfo.editorInfo.plugins.length > 0).map(folderInfo => folderInfo.uri);
  }

  function getNotebookFormattingWorkspaceFolderUris() {
    return folderInfos
      .filter(folderInfo => hasPluginForFile(folderInfo.editorInfo.plugins, "notebook.ipynb"))
      .map(folderInfo => folderInfo.uri);
  }
}

async function getDefaultFormatterLanguageIds() {
  const languageIds = await vscode.languages.getLanguages();
  return languageIds.filter(languageId => {
    return isDprintExtensionId(vscode.workspace.getConfiguration("editor", { languageId }).get("defaultFormatter"));
  }).sort();
}

function isUserDataUri(uri: vscode.Uri) {
  return uri.scheme === USER_DATA_SCHEME;
}
