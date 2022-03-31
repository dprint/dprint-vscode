import * as vscode from "vscode";
import { DPRINT_CONFIG_FILENAME_GLOB } from "./constants";
import { EditorInfo } from "./executable";
import { FolderService } from "./FolderService";
import { ObjectDisposedError } from "./utils";

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

    for (const folder of vscode.workspace.workspaceFolders) {
      this.#folders.push(
        new FolderService({
          workspaceFolder: folder,
          configUri: undefined,
          outputChannel: this.#outputChannel,
        }),
      );

      // now search within sub directories to find any configuration files
      const subConfigFiles = await vscode.workspace.findFiles(`*/**/${DPRINT_CONFIG_FILENAME_GLOB}`);
      for (const subConfigFile of subConfigFiles) {
        this.#folders.push(
          new FolderService({
            workspaceFolder: folder,
            configUri: subConfigFile,
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
