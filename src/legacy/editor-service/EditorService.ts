import type * as vscode from "vscode";
import type { ByteRange } from "./byteRange";

export interface EditorService {
  killAndDispose(): void;
  canFormat(filePath: string): Promise<boolean>;
  /**
   * Formats the file text, returning undefined when there's no change.
   *
   * When a range is provided, it's up to the plugin whether to format only that
   * range or the whole file, so the returned text may differ outside the range.
   */
  formatText(
    filePath: string,
    fileText: string,
    range: ByteRange | undefined,
    token: vscode.CancellationToken,
  ): Promise<string | undefined>;
}
