// note: this file should not import "vscode" so that it can be unit tested

/** A language contributed by an extension (`contributes.languages` in its package.json). */
export interface LanguageContribution {
  id?: string;
  extensions?: string[];
  filenames?: string[];
}

/** Gets the file names to try when formatting an untitled document of the language. */
export function getUntitledFileNames(contributions: Iterable<LanguageContribution>, languageId: string) {
  return getLanguageFileNames(contributions, languageId, "Untitled");
}

/**
 * Gets the file names to try when formatting a notebook cell of the language. These
 * use the same base name as the jupyter plugin uses when formatting a code cell.
 */
export function getNotebookCellFileNames(contributions: Iterable<LanguageContribution>, languageId: string) {
  return getLanguageFileNames(contributions, languageId, "code_block");
}

/**
 * Gets the file names to try, in order, when formatting a document of the language
 * that isn't on the file system, which dprint needs to pick a plugin. These are the
 * base name with each file extension contributed for the language, then its file names
 * (ex. `Dockerfile`). A plugin may only handle some of a language's file extensions
 * (ex. json's `.code-profile`), so the first file name a plugin handles should be used.
 */
function getLanguageFileNames(contributions: Iterable<LanguageContribution>, languageId: string, baseName: string) {
  const extensionFileNames: string[] = [];
  const fileNames: string[] = [];
  for (const contribution of contributions) {
    if (contribution.id !== languageId) {
      continue;
    }
    for (const extension of contribution.extensions ?? []) {
      if (extension.startsWith(".") && extension.length > 1) {
        extensionFileNames.push(`${baseName}${extension}`);
      }
    }
    fileNames.push(...contribution.filenames ?? []);
  }
  return [...new Set([...extensionFileNames, ...fileNames])];
}
