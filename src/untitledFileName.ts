// note: this file should not import "vscode" so that it can be unit tested

/** A language contributed by an extension (`contributes.languages` in its package.json). */
export interface LanguageContribution {
  id?: string;
  extensions?: string[];
  filenames?: string[];
}

/**
 * Gets a file name to use when formatting an untitled document of the language,
 * which dprint needs to pick a plugin. Uses the first file extension contributed
 * for the language, otherwise its first file name (ex. `Dockerfile`).
 */
export function getUntitledFileName(contributions: Iterable<LanguageContribution>, languageId: string) {
  let fileName: string | undefined;
  for (const contribution of contributions) {
    if (contribution.id !== languageId) {
      continue;
    }
    const extension = contribution.extensions?.find(ext => ext.startsWith(".") && ext.length > 1);
    if (extension != null) {
      return `Untitled${extension}`;
    }
    fileName ??= contribution.filenames?.[0];
  }
  return fileName;
}
