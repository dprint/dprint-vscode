import * as vscode from "vscode";
import { ancestorDirsContainConfigFile } from "../configFile";
import { DPRINT_CONFIG_FILEPATH_GLOB } from "../constants";
import { EditorInfo } from "../DprintExecutable";
import { ObjectDisposedError } from "../utils";
import { FolderService } from "./FolderService";

export type FolderInfos = ReadonlyArray<Readonly<FolderInfo>>;

export interface FolderInfo {
  uri: vscode.Uri;
  editorInfo: EditorInfo;
}

export interface WorkspaceServiceOptions {
  outputChannel: vscode.OutputChannel;
}

/** Handles creating dprint instances for each workspace folder. */
export class WorkspaceService implements vscode.DocumentFormattingEditProvider {
  readonly #outputChannel: vscode.OutputChannel;
  readonly #folders: FolderService[] = [];

  #disposed = false;

  constructor(opts: WorkspaceServiceOptions) {
    this.#outputChannel = opts.outputChannel;
  }

  dispose() {
    this.#clearFolders();
    this.#disposed = true;
  }

  #assertNotDisposed() {
    if (this.#disposed) {
      throw new ObjectDisposedError();
    }
  }

  async provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ) {
    const folder = this.#getFolderForUri(document.uri);
    return folder?.provideDocumentFormattingEdits(document, options, token);
  }

  #getFolderForUri(uri: vscode.Uri) {
    let bestMatch: FolderService | undefined;
    for (const folder of this.#folders) {
      if (uri.fsPath.startsWith(folder.uri.fsPath)) {
        if (bestMatch == null || folder.uri.fsPath.startsWith(bestMatch.uri.fsPath)) {
          bestMatch = folder;
        }
      }
    }
    return bestMatch;
  }

  #clearFolders() {
    for (const folder of this.#folders) {
      folder.dispose();
    }
    this.#folders.length = 0; // clear
  }

  async initializeFolders(): Promise<FolderInfos> {
    this.#assertNotDisposed();

    this.#clearFolders();
    if (vscode.workspace.workspaceFolders == null) {
      return [];
    }

    const configFiles = await vscode.workspace.findFiles(
      /* include */ DPRINT_CONFIG_FILEPATH_GLOB,
      /* exclude */ "**/node_modules/**",
    );

    // Initialize the workspace folders with each sub configuration that's found.
    for (const folder of vscode.workspace.workspaceFolders) {
      const stringFolderUri = folder.uri.toString();
      const subConfigUris = configFiles.filter(c => c.toString().startsWith(stringFolderUri));
      for (const subConfigUri of subConfigUris) {
        this.#folders.push(
          new FolderService({
            workspaceFolder: folder,
            configUri: subConfigUri,
            outputChannel: this.#outputChannel,
          }),
        );
      }

      // if the current workspace folder hasn't been added, then ensure
      // it's added to the list of folders in order to allow someone
      // formatting when the current open workspace is in a sub directory
      // of a workspace
      if (
        !this.#folders.some(f => areDirectoryUrisEqual(f.uri, folder.uri))
        && ancestorDirsContainConfigFile(folder.uri)
      ) {
        this.#folders.push(
          new FolderService({
            workspaceFolder: folder,
            configUri: undefined,
            outputChannel: this.#outputChannel,
          }),
        );
      }
    }

    // now initialize in parallel
    const initializedFolders = await Promise.all(this.#folders.map(async f => {
      if (await f.initialize()) {
        return f;
      } else {
        return undefined;
      }
    }));

    this.#assertNotDisposed();

    const allEditorInfos: FolderInfo[] = [];
    for (const folder of initializedFolders) {
      if (folder != null) {
        const editorInfo = folder.getEditorInfo();
        if (editorInfo != null) {
          allEditorInfos.push({ uri: folder.uri, editorInfo: editorInfo });
        }
      }
    }
    return allEditorInfos;
  }
}

function areDirectoryUrisEqual(a: vscode.Uri, b: vscode.Uri) {
  function standarizeUri(uri: vscode.Uri) {
    const text = uri.toString();
    if (text.endsWith("/")) {
      return text;
    } else {
      // for some reason, vscode workspace directory uris don't have a trailing slash
      return `${text}/`;
    }
  }

  return standarizeUri(a) === standarizeUri(b);
}
