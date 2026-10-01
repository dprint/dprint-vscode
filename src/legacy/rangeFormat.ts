// note: this file should not import "vscode" so that it can be unit tested

/** A range of UTF-16 code unit offsets (the offsets used by vscode). */
export interface OffsetRange {
  start: number;
  end: number;
}

export interface RangeFormatEdit extends OffsetRange {
  newText: string;
}

/**
 * Expands the range to include the whole lines it touches, including the
 * last line's line break. A range that ends at the start of a line (ex. after
 * selecting whole lines) does not include that line.
 */
export function expandToLines(text: string, range: OffsetRange): OffsetRange {
  // note: lastIndexOf treats a negative index as 0, so special case the start of the text
  const start = range.start === 0 ? 0 : text.lastIndexOf("\n", range.start - 1) + 1;
  if (range.end > start && text[range.end - 1] === "\n") {
    return { start, end: range.end };
  }
  const lineBreakIndex = text.indexOf("\n", range.end);
  return { start, end: lineBreakIndex === -1 ? text.length : lineBreakIndex + 1 };
}

/**
 * Gets the edit that replaces the range with its formatted text.
 *
 * Plugins may format the whole file instead of only the range, so this
 * returns undefined when the formatted text has changes outside the range.
 *
 * The editor owns the line endings of a document, so a difference in only the
 * line endings (ex. a plugin that emits LF for a CRLF document) is not a change
 * and the edit's text uses the line endings of the original text.
 */
export function getRangeFormatEdit(
  originalText: string,
  formattedText: string,
  range: OffsetRange,
): RangeFormatEdit | undefined {
  const normalizedText = normalizeToSourceLineEndings(originalText, formattedText);
  return getEditForRange(originalText, normalizedText, range)
    // text with mixed line endings can't be matched after converting, so compare it as-is
    ?? getEditForRange(originalText, formattedText, range);
}

/**
 * Gets if the edit replaces the range with the text it already has, which
 * happens when the formatted text differs only in its line endings.
 */
export function isNoChangeEdit(originalText: string, edit: RangeFormatEdit) {
  return originalText.slice(edit.start, edit.end) === edit.newText;
}

function getEditForRange(
  originalText: string,
  formattedText: string,
  range: OffsetRange,
): RangeFormatEdit | undefined {
  const prefix = originalText.slice(0, range.start);
  const suffix = originalText.slice(range.end);
  if (
    formattedText.length < prefix.length + suffix.length
    || !formattedText.startsWith(prefix)
    || !formattedText.endsWith(suffix)
  ) {
    return undefined;
  }
  return {
    start: range.start,
    end: range.end,
    newText: formattedText.slice(prefix.length, formattedText.length - suffix.length),
  };
}

/**
 * Converts the line endings of the formatted text to the ones the source
 * text uses, which is determined by the source text's first line ending.
 */
function normalizeToSourceLineEndings(sourceText: string, formattedText: string) {
  const lineBreakIndex = sourceText.indexOf("\n");
  if (lineBreakIndex === -1) {
    return formattedText; // can't tell what the source uses, so leave it alone
  }
  const sourceUsesCrlf = lineBreakIndex > 0 && sourceText[lineBreakIndex - 1] === "\r";
  return formattedText.replace(/\r?\n/g, sourceUsesCrlf ? "\r\n" : "\n");
}
