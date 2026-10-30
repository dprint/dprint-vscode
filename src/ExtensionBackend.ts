import type * as vscode from "vscode";
import type { ReInitializeOptions } from "./BackendSwitcher";
import type { NotFormattedReason } from "./globalConfigCommand";

export interface ExtensionBackend extends vscode.Disposable {
  reInitialize(options?: ReInitializeOptions): Promise<void>;
  /** Gets if a change to the settings needs the backend to be initialized again. */
  affectsInitialization(evt: vscode.ConfigurationChangeEvent): boolean;
  /** Called when a config file's contents change (not when one is created or deleted). */
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
