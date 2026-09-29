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
 */
export function getRangeFormatEdit(
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
