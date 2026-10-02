// note: this file should not import "vscode" so that it can be unit tested

import { normalizeToSourceLineEndings, type OffsetRange } from "./rangeFormat";

/** An edit that replaces a range of the original text. */
export interface OffsetEdit extends OffsetRange {
  newText: string;
}

/**
 * The number of differing lines after which the lines aren't diffed anymore
 * and the changed part of the text is replaced with a single edit instead.
 * This bounds the time and memory used on text that mostly changed.
 */
const MAX_DIFFERENCES = 1000;

/**
 * Gets the edits that change the original text to the formatted text while
 * leaving the lines that are the same alone, which is what allows the editor
 * to keep the cursors, selections, folded regions, and breakpoints in place.
 *
 * The editor owns the line endings of a document, so the edits use the line
 * endings of the original text and a difference in only the line endings is
 * not a change.
 */
export function getMinimalEdits(originalText: string, formattedText: string): OffsetEdit[] {
  const newText = normalizeToSourceLineEndings(originalText, formattedText);
  if (newText === originalText) {
    return [];
  }

  // formatting usually only changes a small part of a file, so skip over the lines
  // at the start and end that are the same and only diff the lines between them
  const prefixLength = getCommonLinePrefixLength(originalText, newText);
  const suffixLength = getCommonLineSuffixLength(originalText, newText, prefixLength);
  const oldLineStarts = getLineStarts(originalText, prefixLength, originalText.length - suffixLength);
  const newLineStarts = getLineStarts(newText, prefixLength, newText.length - suffixLength);
  const lineIds = new Map<string, number>();
  const oldLines = getLineIds(originalText, oldLineStarts, lineIds);
  const newLines = getLineIds(newText, newLineStarts, lineIds);

  const hunks = diffLines(oldLines, newLines)
    ?? [{ oldStart: 0, oldEnd: oldLines.length, newStart: 0, newEnd: newLines.length }];
  return hunks.map(hunk =>
    getHunkEdit(originalText, newText, {
      oldStart: oldLineStarts[hunk.oldStart],
      oldEnd: oldLineStarts[hunk.oldEnd],
      newStart: newLineStarts[hunk.newStart],
      newEnd: newLineStarts[hunk.newEnd],
    })
  );
}

/** A range of the old lines or text that's replaced by a range of the new lines or text. */
interface Hunk {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

/** Gets the length of the lines at the start of the texts that are the same. */
function getCommonLinePrefixLength(oldText: string, newText: string) {
  const maxLength = Math.min(oldText.length, newText.length);
  let length = 0;
  while (length < maxLength && oldText.charCodeAt(length) === newText.charCodeAt(length)) {
    length++;
  }
  // note: lastIndexOf treats a negative index as 0, so special case the start of the text
  return length === 0 ? 0 : oldText.lastIndexOf("\n", length - 1) + 1;
}

/** Gets the length of the lines at the end of the texts that are the same and aren't in the prefix. */
function getCommonLineSuffixLength(oldText: string, newText: string, prefixLength: number) {
  const maxLength = Math.min(oldText.length, newText.length) - prefixLength;
  let length = 0;
  while (
    length < maxLength
    && oldText.charCodeAt(oldText.length - length - 1) === newText.charCodeAt(newText.length - length - 1)
  ) {
    length++;
  }
  // the suffix needs to start at the start of a line in both texts
  if (isLineStart(oldText, oldText.length - length) && isLineStart(newText, newText.length - length)) {
    return length;
  }
  const lineBreakIndex = oldText.indexOf("\n", oldText.length - length);
  return lineBreakIndex === -1 ? 0 : oldText.length - lineBreakIndex - 1;
}

function isLineStart(text: string, offset: number) {
  return offset === 0 || text.charCodeAt(offset - 1) === 0x0A;
}

/** Gets the offsets of the starts of the lines within the range, followed by the end of the range. */
function getLineStarts(text: string, start: number, end: number) {
  const lineStarts: number[] = [];
  let lineStart = start;
  while (lineStart < end) {
    lineStarts.push(lineStart);
    const lineBreakIndex = text.indexOf("\n", lineStart);
    lineStart = lineBreakIndex === -1 || lineBreakIndex >= end ? end : lineBreakIndex + 1;
  }
  lineStarts.push(end);
  return lineStarts;
}

/** Gets a number for each line where the lines with the same text have the same number. */
function getLineIds(text: string, lineStarts: number[], ids: Map<string, number>) {
  const lineIds = new Int32Array(lineStarts.length - 1);
  for (let i = 0; i < lineIds.length; i++) {
    const line = text.substring(lineStarts[i], lineStarts[i + 1]);
    let id = ids.get(line);
    if (id == null) {
      id = ids.size;
      ids.set(line, id);
    }
    lineIds[i] = id;
  }
  return lineIds;
}

const enum Move {
  None,
  /** Adds a new line. */
  Down,
  /** Removes an old line. */
  Right,
}

const UNSET = -1;

/**
 * Gets the differences between the lines using Myers' diff algorithm, or
 * undefined when there's more than `MAX_DIFFERENCES` of them.
 */
function diffLines(oldLines: Int32Array, newLines: Int32Array): Hunk[] | undefined {
  const oldCount = oldLines.length;
  const newCount = newLines.length;
  if (oldCount === 0 || newCount === 0) {
    return [{ oldStart: 0, oldEnd: oldCount, newStart: 0, newEnd: newCount }];
  }

  // the furthest old line reached on each diagonal (old index - new index), which are
  // offset to not have a negative index. Each iteration only writes the diagonals
  // that have the same parity as its number of differences and reads the other ones.
  const maxDifferences = Math.min(oldCount + newCount, MAX_DIFFERENCES);
  const offset = maxDifferences + 1;
  const furthest = new Int32Array(2 * maxDifferences + 3).fill(UNSET);
  // the diagonals from -differences to differences after each iteration
  const history: Int32Array[] = [];
  for (let differences = 0; differences <= maxDifferences; differences++) {
    for (let diagonal = -differences; diagonal <= differences; diagonal += 2) {
      const index = offset + diagonal;
      let oldIndex = 0;
      if (differences > 0) {
        const move = getMove(furthest[index - 1], furthest[index + 1], diagonal, oldCount, newCount);
        if (move === Move.None) {
          furthest[index] = UNSET;
          continue;
        }
        oldIndex = move === Move.Down ? furthest[index + 1] : furthest[index - 1] + 1;
      }
      let newIndex = oldIndex - diagonal;
      while (oldIndex < oldCount && newIndex < newCount && oldLines[oldIndex] === newLines[newIndex]) {
        oldIndex++;
        newIndex++;
      }
      furthest[index] = oldIndex;
      if (oldIndex === oldCount && newIndex === newCount) {
        return getHunks(history, oldCount, newCount);
      }
    }
    history.push(furthest.slice(offset - differences, offset + differences + 1));
  }
  return undefined;
}

/**
 * Gets the move that reaches the furthest on a diagonal given how far the
 * diagonals on each side of it reached with one less difference.
 */
function getMove(left: number, above: number, diagonal: number, oldCount: number, newCount: number): Move {
  const canMoveRight = left !== UNSET && left < oldCount;
  const canMoveDown = above !== UNSET && above - (diagonal + 1) < newCount;
  if (canMoveDown && (!canMoveRight || left < above)) {
    return Move.Down;
  }
  return canMoveRight ? Move.Right : Move.None;
}

/** Walks back through the history from the end of the lines collecting the differences. */
function getHunks(history: Int32Array[], oldCount: number, newCount: number) {
  const hunks: Hunk[] = [];
  let oldIndex = oldCount;
  let newIndex = newCount;
  for (let differences = history.length; differences > 0; differences--) {
    const furthest = history[differences - 1];
    const get = (diagonal: number) => Math.abs(diagonal) < differences ? furthest[diagonal + differences - 1] : UNSET;
    const diagonal = oldIndex - newIndex;
    const move = getMove(get(diagonal - 1), get(diagonal + 1), diagonal, oldCount, newCount);
    // go to where the diagonal was moved to from
    oldIndex = move === Move.Down ? get(diagonal + 1) : get(diagonal - 1);
    newIndex = oldIndex - (move === Move.Down ? diagonal + 1 : diagonal - 1);
    const oldEnd = move === Move.Down ? oldIndex : oldIndex + 1;
    const newEnd = move === Move.Down ? newIndex + 1 : newIndex;

    const nextHunk = hunks[hunks.length - 1];
    if (nextHunk != null && nextHunk.oldStart === oldEnd && nextHunk.newStart === newEnd) {
      nextHunk.oldStart = oldIndex;
      nextHunk.newStart = newIndex;
    } else {
      hunks.push({ oldStart: oldIndex, oldEnd, newStart: newIndex, newEnd });
    }
  }
  return hunks.reverse();
}

/** Gets the edit for the hunk without the text at its start and end that's the same. */
function getHunkEdit(oldText: string, newText: string, hunk: Hunk): OffsetEdit {
  let { oldStart, oldEnd, newStart, newEnd } = hunk;
  while (oldStart < oldEnd && newStart < newEnd && oldText.charCodeAt(oldStart) === newText.charCodeAt(newStart)) {
    oldStart++;
    newStart++;
  }
  while (
    oldStart < oldEnd && newStart < newEnd && oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)
  ) {
    oldEnd--;
    newEnd--;
  }
  // an edit can't start or end in the middle of a line break or a surrogate pair. These
  // only move over text that's the same and a hunk never starts or ends within one.
  if (isWithinCharacter(oldText, oldStart) || isWithinCharacter(newText, newStart)) {
    oldStart--;
    newStart--;
  }
  if (isWithinCharacter(oldText, oldEnd) || isWithinCharacter(newText, newEnd)) {
    oldEnd++;
    newEnd++;
  }
  return { start: oldStart, end: oldEnd, newText: newText.substring(newStart, newEnd) };
}

/** Gets if the offset is between a `\r\n` or between the two code units of a surrogate pair. */
function isWithinCharacter(text: string, offset: number) {
  if (offset <= 0 || offset >= text.length) {
    return false;
  }
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return previous === 0x0D && next === 0x0A
    || previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF;
}
