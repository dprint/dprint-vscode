import type { OffsetRange } from "./rangeFormat";

// note: this file should not import "vscode" so that it can be unit tested

/**
 * Trims the trailing whitespace of a notebook cell's formatted text like the jupyter
 * plugin does because many plugins add a final newline, which doesn't look nice in a
 * cell. When formatting a range that ends before the end of the cell, the cell's
 * original trailing whitespace is kept so the text after the range stays the same.
 */
export function trimFormattedCellText(originalText: string, formattedText: string, range: OffsetRange | undefined) {
  const trimmedText = formattedText.trimEnd();
  if (range == null || range.end >= originalText.length) {
    return trimmedText;
  }
  return trimmedText + originalText.slice(originalText.trimEnd().length);
}
