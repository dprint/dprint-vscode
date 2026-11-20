import type * as vscode from "vscode";
import type { ReInitializeOptions } from "./BackendSwitcher";
import type { NotFormattedReason } from "./globalConfigCommand";

export interface ExtensionBackend extends vscode.Disposable {
  /**
   * Fired when dprint says what a config file formats may have changed, which may change whether any open document
   * is formatted with the global config file, so that's gotten again. It's for any config file, because the extension
   * doesn't map the paths of a directory it knows by several (ex. through a symlink) to find the documents in it.
   * The legacy backend doesn't have it.
   */
  readonly onDidChangeConfig?: vscode.Event<void>;
  reInitialize(options?: ReInitializeOptions): Promise<void>;
  /** Gets if a change to the settings needs the backend to be initialized again. */
  affectsInitialization(evt: vscode.ConfigurationChangeEvent): boolean;
  /** Called when a config file in the workspace was created, changed, or deleted. */
  onConfigFileChanged(uri: vscode.Uri, type: ConfigFileChangeType): Promise<void>;
  /**
   * Gets the edits for formatting the document, or only the range when provided, using
   * the global config file when the document doesn't have a config file in an ancestor
   * directory. This is for explicitly formatting using the global config file regardless
   * of if the user enabled always using it, so it provides why the document wasn't
   * formatted for the caller to tell the user instead of notifying.
   */
  provideGlobalConfigFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range | undefined,
    options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<FormatDocumentResult>;
  /**
   * Gets if the document would be formatted with the global config file, which is when the
   * commands for it apply. This is undefined when the backend doesn't know.
   */
  canFormatWithGlobalConfig(document: vscode.TextDocument): Promise<boolean | undefined>;
  /**
   * Whether the config file of a document is found through symlinks when the backend doesn't know
   * whether it's formatted with the global config file, which is for an older dprint that reads a
   * symlinked config file anyway (see `FindConfigFileOptions`).
   */
  readonly followsConfigFileSymlinks: boolean;
  /**
   * Asks the user about what the config files need approved before dprint formats with them
   * (ex. a download from a domain that isn't trusted or running process plugins), which
   * includes what they denied.
   */
  approve(): Promise<void>;
  /**
   * Forgets what the user decided about what the config files need approved, including the
   * "Always" decisions, so they're asked again.
   */
  forgetDecisions(): Promise<void>;
  /** Shows what the user decided about what the config files need approved, which they can forget. */
  showDecisions(): Promise<void>;
}

/** The edits for formatting a document, which are empty when it's already formatted, or why it wasn't formatted. */
export type FormatDocumentResult =
  | { edits: vscode.TextEdit[]; notFormattedReason?: undefined; notFormattedMessage?: undefined }
  | {
    edits?: undefined;
    notFormattedReason: NotFormattedReason;
    /** The message to show the user, which is the message for the reason when it's not provided. */
    notFormattedMessage?: string;
  };

/** How a config file changed. */
export type ConfigFileChangeType = "created" | "changed" | "deleted";
