import * as vscode from "vscode";
import { EditorInfo, PluginInfo } from "./executable";
import { Logger } from "./logger";
import { ObjectDisposedError } from "./utils";
import { WorkspaceFolderService } from "./WorkspaceFolderService";

export interface WorkspaceServiceOptions {
  outputChannel: vscode.OutputChannel;
}

/** Handles creating dprint instances for each workspace folder. */
export class WorkspaceService implements vscode.DocumentFormattingEditProvider {
  readonly #outputChannel: vscode.OutputChannel;
  readonly #folders: WorkspaceFolderService[] = [];

  #disposed = false;

  constructor(opts: WorkspaceServiceOptions) {
    this.#outputChannel = opts.outputChannel;
  }

  dispose() {
    this.#clearFolders();
    this.#disposed = true;
  }

  async provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ) {
    for (const folder of this.#folders) {
      if (document.uri.fsPath.startsWith(folder.folder.uri.fsPath)) {
        return folder.provideDocumentFormattingEdits(document, options, token);
      }
    }
    return null;
  }

  #clearFolders() {
    for (const folder of this.#folders) {
      folder.dispose();
    }
    this.#folders.length = 0; // clear
  }

  async initializeFolders(): Promise<EditorInfo[]> {
    if (this.#disposed) throw new ObjectDisposedError();

    this.#clearFolders();
    if (vscode.workspace.workspaceFolders == null) {
      return [];
    }

    for (const folder of vscode.workspace.workspaceFolders) {
      this.#folders.push(
        new WorkspaceFolderService({
          folder,
          outputChannel: this.#outputChannel,
        }),
      );
    }

    // now initialize in parallel
    const initializedFolders = await Promise.all(this.#folders.map(async f => {
      if (await f.initialize()) {
        return f;
      } else {
        return undefined;
      }
    }));

    if (this.#disposed) throw new ObjectDisposedError();

    const allEditorInfos: Readonly<EditorInfo>[] = [];
    for (const folder of initializedFolders) {
      const editorInfo = folder?.getEditorInfo();
      if (editorInfo != null) {
        allEditorInfos.push(editorInfo);
      }
    }
    return allEditorInfos;
  }
}