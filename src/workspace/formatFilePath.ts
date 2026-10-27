import * as path from "node:path";
import type { FileInfoData, FileInfoResponseData } from "./messages";

// note: this file should not import "vscode" so that it can be unit tested

/** The files dprint may format a document as. */
export interface FormatFileCandidates {
  dirPath: string;
  /** The file names in order of preference. This is never empty. */
  fileNames: string[];
  /** The notebook file's path when the document is a notebook cell. */
  notebookPath?: string;
}

/**
 * Gets the file path to format the document as. A document that isn't on the file
 * system is formatted as the first of its candidate file names that dprint formats.
 */
export async function getFormatFilePath(
  candidates: FormatFileCandidates,
  allowGlobalConfig: boolean,
  getFileInfo: (data: FileInfoData) => Promise<FileInfoResponseData>,
) {
  const filePaths = candidates.fileNames.map(fileName => path.join(candidates.dirPath, fileName));
  if (filePaths.length > 1) {
    for (const filePath of filePaths) {
      const info = await getFileInfo({
        filePath,
        notebookPath: candidates.notebookPath,
        allowGlobalConfig,
      });
      if (info.canFormat) {
        return filePath;
      }
      if (info.configFile == null) {
        break; // the same for every candidate
      }
    }
  }
  return filePaths[0];
}
