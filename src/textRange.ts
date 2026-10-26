// note: this file should not import "vscode" so that it can be unit tested

/** A range of UTF-16 code unit offsets (the offsets used by vscode). */
export interface OffsetRange {
  start: number;
  end: number;
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
