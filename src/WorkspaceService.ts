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

    const configFiles = await vscode.workspace.findFiles(DPRINT_CONFIG_FILENAME_GLOB);

    // Initializes the workspace folder with the first config file that is found.
    vscode.workspace.workspaceFolders.forEach((folder) => {
      const stringFolderUri = folder.uri.toString();
      const subConfigFile = configFiles.find((c) => c.toString().startsWith(stringFolderUri));
      this.#initFolder(folder, subConfigFile);
    });

    const initializedFolders = (
      await Promise.all(
        this.#folders.map(async (f) => {
          if (await f.initialize()) {
            return f;
          } else {
            return undefined;
          }
        }),
      )
    ).filter((v): v is NonNullable<typeof v> => v != null);

    this.#assertNotDisposed();

    const allEditorInfos = initializedFolders
      .map((folder) => {
        const editorInfo = folder.getEditorInfo();
        if (editorInfo != null) {
          return { uri: folder.uri, editorInfo: editorInfo };
        }
      })
      .filter((v): v is NonNullable<typeof v> => v != null);

    return allEditorInfos;
  }

  #initFolder(workspaceFolder: vscode.WorkspaceFolder, configUri?: vscode.Uri) {
    this.#folders.push(
      new FolderService({
        outputChannel: this.#outputChannel,
        configUri,
        workspaceFolder,
      }),
    );
  }
}
