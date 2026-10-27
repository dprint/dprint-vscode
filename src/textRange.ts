// note: this file should not import "vscode" so that it can be unit tested

/** A range of UTF-16 code unit offsets (the offsets used by vscode). */
export interface OffsetRange {
  start: number;
  end: number;
}

/** Replaces the text between two UTF-16 offsets. */
export interface OffsetTextEdit {
  start: number;
  end: number;
  newText: string;
}

/**
 * Gets the edits of formatting the range, which is undefined when the text
 * changed outside the range. An edit may be just outside the range when the
 * change could be in more than one place (ex. removing one of several blank
 * lines), so the edits are replaced with one of the whole range in that case.
 *
 * @param edits - The edits of the text, which don't overlap and are in order.
 */
export function getRangeEdits(
  text: string,
  edits: readonly OffsetTextEdit[],
  range: OffsetRange,
): OffsetTextEdit[] | undefined {
  if (edits.every(edit => edit.start >= range.start && edit.end <= range.end)) {
    return [...edits];
  }
  const formattedText = applyEdits(text, edits);
  const prefix = text.slice(0, range.start);
  const suffix = text.slice(range.end);
  if (
    formattedText.length < prefix.length + suffix.length
    || !formattedText.startsWith(prefix)
    || !formattedText.endsWith(suffix)
  ) {
    return undefined;
  }
  return [{
    start: range.start,
    end: range.end,
    newText: formattedText.slice(prefix.length, formattedText.length - suffix.length),
  }];
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

function applyEdits(text: string, edits: readonly OffsetTextEdit[]) {
  let result = "";
  let offset = 0;
  for (const edit of edits) {
    result += text.slice(offset, edit.start) + edit.newText;
    offset = edit.end;
  }
  return result + text.slice(offset);
}
