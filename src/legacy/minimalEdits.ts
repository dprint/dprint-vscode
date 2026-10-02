// note: this file should not import "vscode" so that it can be unit tested

import { normalizeToSourceLineEndings, type OffsetRange } from "./rangeFormat";

/** An edit that replaces a range of the original text. */
export interface OffsetEdit extends OffsetRange {
  newText: string;
}

/**
 * The length of text above which the extension should get the minimal edits itself.
 *
 * vscode reduces the edits of an extension to what changed, but only for text of up to
 * 100,000 characters. This is lower than that in order to not depend on the exact limit.
 */
export const MINIMAL_EDITS_MIN_TEXT_LENGTH = 90_000;

/**
 * The number of edits after which the rest of the changed text is replaced with a
 * single edit instead. This bounds the time spent here and by the editor on applying
 * the edits to text that changed in very many places, which then gets little out of
 * edits for only what changed.
 */
const MAX_EDITS = 5_000;

/**
 * The amount of work after which the lines aren't diffed anymore and the rest of
 * the changed text is replaced with a single edit instead. This bounds the time
 * and memory used on diffing the lines of text where many lines in a row changed.
 *
 * The work to diff lines that changed with no lines that are the same between them is
 * about half the square of the number of differing lines, so this allows about 350
 * changed lines in a row or many thousands of changed lines that are spread out.
 */
const MAX_WORK = 250_000;
/** The number of differing lines in a row that can't be reached with the maximum amount of work. */
const MAX_DIFFERENCES = Math.ceil(Math.sqrt(2 * MAX_WORK));

/**
 * The number of lines in a row that need to be the same after a difference
 * in order to consider the texts as being lined up again.
 */
const SYNC_LINE_COUNT = 3;

/**
 * Gets the edits that change the original text to the formatted text while
 * leaving the lines that are the same alone, which is what allows the editor
 * to keep the cursors, selections, folded regions, and breakpoints in place.
 *
 * The editor owns the line endings of a document, so the edits use the line
 * endings of the original text and a difference in only the line endings is
 * not a change.
 *
 * This is written to be fast on large text where formatting changed a small
 * part of it. The text that's the same is skipped over by comparing large
 * chunks of it at a time and only the lines around a change are diffed. The
 * edits are not always the fewest possible because the lines after a change
 * are matched up at the first place where `SYNC_LINE_COUNT` lines are the same.
 */
export function getMinimalEdits(originalText: string, formattedText: string): OffsetEdit[] {
  const newText = normalizeToSourceLineEndings(originalText, formattedText);
  if (newText === originalText) {
    return [];
  }

  const suffixLength = getCommonLineSuffixLength(originalText, newText);
  const oldEnd = originalText.length - suffixLength;
  const newEnd = newText.length - suffixLength;
  const edits: OffsetEdit[] = [];
  const buffers = createDiffBuffers();
  const lineIds: LineIds = { byLine: new Map(), count: 0 };
  let remainingWork = MAX_WORK;
  let oldOffset = 0;
  let newOffset = 0;
  while (true) {
    const sameLength = getCommonLinePrefixLength(originalText, oldOffset, oldEnd, newText, newOffset, newEnd);
    oldOffset += sameLength;
    newOffset += sameLength;
    if (oldOffset === oldEnd && newOffset === newEnd) {
      break;
    }

    // diff the lines from here until the texts line up again
    const oldLines = createLines(originalText, oldOffset, oldEnd, lineIds);
    const newLines = createLines(newText, newOffset, newEnd, lineIds);
    const diff = oldOffset === oldEnd || newOffset === newEnd || edits.length >= MAX_EDITS
      ? undefined // nothing to diff because the rest was added or removed, or there's too many edits
      : diffLinesUntilSynced(oldLines, newLines, buffers, remainingWork);
    if (diff == null) {
      const hunk = { oldStart: oldOffset, oldEnd, newStart: newOffset, newEnd };
      edits.push(getHunkEdit(originalText, newText, hunk));
      break;
    }
    for (const hunk of diff.hunks) {
      edits.push(getHunkEdit(originalText, newText, {
        oldStart: getLineStart(oldLines, hunk.oldStart),
        oldEnd: getLineStart(oldLines, hunk.oldEnd),
        newStart: getLineStart(newLines, hunk.newStart),
        newEnd: getLineStart(newLines, hunk.newEnd),
      }));
    }
    remainingWork -= diff.work;
    oldOffset = getLineStart(oldLines, diff.oldSyncIndex);
    newOffset = getLineStart(newLines, diff.newSyncIndex);
  }
  return edits;
}

/** A range of the old lines or text that's replaced by a range of the new lines or text. */
interface Hunk {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

/** Gets the length of the lines at the start of the ranges that are the same. */
function getCommonLinePrefixLength(
  oldText: string,
  oldStart: number,
  oldEnd: number,
  newText: string,
  newStart: number,
  newEnd: number,
) {
  const length = getCommonPrefixLength(oldText, oldStart, oldEnd, newText, newStart, newEnd);
  if (length === 0 || oldStart + length === oldEnd && newStart + length === newEnd) {
    return length;
  }
  // go back to the start of the line with the difference, which is at or
  // after the start of the range because the range starts at a line start
  const lineStart = oldText.lastIndexOf("\n", oldStart + length - 1) + 1;
  return Math.max(0, lineStart - oldStart);
}

/** Gets the length of the lines at the end of the texts that are the same. */
function getCommonLineSuffixLength(oldText: string, newText: string) {
  const length = getCommonSuffixLength(oldText, 0, oldText.length, newText, 0, newText.length);
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

/** The lines of a range of text, which are found as they're asked for. */
interface Lines {
  text: string;
  /** The end of the range. */
  end: number;
  /** A number for each line found so far, where the lines with the same text have the same number. */
  ids: number[];
  lineIds: LineIds;
  /** The offset of the start of each line found so far followed by the end of the last one. */
  starts: number[];
}

/** The numbers given to the text of lines, which are shared by the old and new lines. */
interface LineIds {
  byLine: Map<string, number>;
  /** The number of numbers given out. */
  count: number;
}

function createLines(text: string, start: number, end: number, lineIds: LineIds): Lines {
  return { text, end, ids: [], lineIds, starts: [start] };
}

const NO_LINE = -1;
/**
 * The length above which a line is always given its own number, which makes it differ
 * from every other line. Looking up a very long line is slow because the engine doesn't
 * hash all of a long string, so many long lines that start the same would all be compared
 * with each other. The text at the start and end of an edit that's the same is removed
 * afterwards, so this only means that less of the same lines are found around these lines.
 */
const MAX_LOOKUP_LINE_LENGTH = 10_000;

/**
 * Gets the number for the text of the line at the index, or `NO_LINE` when it's past the
 * last line. Comparing these is faster than comparing the lines, which the diff does a lot.
 */
function getLineId(lines: Lines, index: number): number {
  // this is called a lot for the lines that were found already, so keep this part small
  return index < lines.ids.length ? lines.ids[index] : findLineId(lines, index);
}

function findLineId(lines: Lines, index: number): number {
  while (index >= lines.ids.length) {
    const start = lines.starts[lines.ids.length];
    if (start >= lines.end) {
      return NO_LINE;
    }
    const lineBreakIndex = lines.text.indexOf("\n", start);
    const end = lineBreakIndex === -1 || lineBreakIndex >= lines.end ? lines.end : lineBreakIndex + 1;
    const lineIds = lines.lineIds;
    const line = end - start > MAX_LOOKUP_LINE_LENGTH ? undefined : lines.text.substring(start, end);
    let id = line === undefined ? undefined : lineIds.byLine.get(line);
    if (id === undefined) {
      id = lineIds.count++;
      if (line !== undefined) {
        lineIds.byLine.set(line, id);
      }
    }
    lines.ids.push(id);
    lines.starts.push(end);
  }
  return lines.ids[index];
}

function hasLine(lines: Lines, index: number) {
  return getLineId(lines, index) !== NO_LINE;
}

/** Gets the offset of the start of a line that was found or of the end of the last line found. */
function getLineStart(lines: Lines, index: number) {
  return lines.starts[index];
}

interface LinesDiff {
  hunks: Hunk[];
  /** The number of diagonals that were visited to find the differences. */
  work: number;
  /** The index of the line in each text from which the lines are the same again. */
  oldSyncIndex: number;
  newSyncIndex: number;
}

const enum Move {
  None,
  /** Adds a new line. */
  Down,
  /** Removes an old line. */
  Right,
}

const UNSET = -1;
/** The index of diagonal zero in the array of how far each diagonal reached. */
const DIAGONAL_OFFSET = MAX_DIFFERENCES + 1;

/** The arrays used to diff lines, which are reused for each group of changed lines. */
interface DiffBuffers {
  /**
   * The furthest old line reached on each diagonal (old index - new index) with the current
   * and previous number of differences. A number of differences only reaches the diagonals
   * that have the same parity as it, so it only writes those ones and reads the other ones.
   */
  furthest: Int32Array;
  /**
   * The furthest old line reached on each diagonal for every number of differences, which
   * has the diagonals a number of differences can reach after the ones of the number before.
   */
  history: Int32Array;
}

function createDiffBuffers(): DiffBuffers {
  return { furthest: new Int32Array(2 * MAX_DIFFERENCES + 3), history: new Int32Array(1024) };
}

/** Gets the index in the history of the first diagonal of a number of differences. */
function getHistoryStart(differences: number) {
  // a number of differences reaches the diagonals from -differences to differences that have
  // the same parity as it, which is one more diagonal than the number of differences before it
  return differences * (differences + 1) / 2;
}

function ensureHistoryLength(buffers: DiffBuffers, length: number) {
  if (buffers.history.length < length) {
    const history = new Int32Array(Math.max(length, buffers.history.length * 2));
    history.set(buffers.history);
    buffers.history = history;
  }
  return buffers.history;
}

/**
 * Gets the differences between the lines using Myers' diff algorithm up to where the
 * lines are the same again, or undefined when that takes more than the maximum work.
 */
function diffLinesUntilSynced(
  oldLines: Lines,
  newLines: Lines,
  buffers: DiffBuffers,
  maxWork: number,
): LinesDiff | undefined {
  const furthest = buffers.furthest;
  furthest.fill(UNSET);
  let work = 0;
  for (let differences = 0; differences <= MAX_DIFFERENCES; differences++) {
    work += differences + 1;
    if (work > maxWork) {
      break;
    }
    const historyStart = getHistoryStart(differences);
    const history = ensureHistoryLength(buffers, historyStart + differences + 1);
    for (let diagonal = -differences; diagonal <= differences; diagonal += 2) {
      const index = DIAGONAL_OFFSET + diagonal;
      const historyIndex = historyStart + ((diagonal + differences) >> 1);
      let oldIndex = 0;
      if (differences > 0) {
        const move = getMove(furthest[index - 1], furthest[index + 1], diagonal, oldLines, newLines);
        if (move === Move.None) {
          furthest[index] = UNSET;
          history[historyIndex] = UNSET;
          continue;
        }
        oldIndex = move === Move.Down ? furthest[index + 1] : furthest[index - 1] + 1;
      }

      // follow the lines that are the same
      const oldSyncIndex = oldIndex;
      const newSyncIndex = oldIndex - diagonal;
      let newIndex = newSyncIndex;
      let isSynced = false;
      while (true) {
        const oldLineId = getLineId(oldLines, oldIndex);
        if (oldLineId !== getLineId(newLines, newIndex)) {
          break;
        }
        if (oldLineId === NO_LINE) {
          isSynced = true; // at the end of both
          break;
        }
        oldIndex++;
        newIndex++;
        // the first lines always differ, so only stop here after a difference
        if (differences > 0 && oldIndex - oldSyncIndex === SYNC_LINE_COUNT) {
          isSynced = true;
          break;
        }
      }
      furthest[index] = oldIndex;
      history[historyIndex] = oldIndex;
      if (isSynced) {
        const hunks = getHunks(history, differences, oldSyncIndex, newSyncIndex, oldLines, newLines);
        return { hunks, work, oldSyncIndex, newSyncIndex };
      }
    }
  }
  return undefined;
}

/**
 * Gets the move that reaches the furthest on a diagonal given how far the
 * diagonals on each side of it reached with one less difference.
 */
function getMove(left: number, above: number, diagonal: number, oldLines: Lines, newLines: Lines): Move {
  const canMoveRight = left !== UNSET && hasLine(oldLines, left);
  const canMoveDown = above !== UNSET && hasLine(newLines, above - (diagonal + 1));
  if (canMoveDown && (!canMoveRight || left < above)) {
    return Move.Down;
  }
  return canMoveRight ? Move.Right : Move.None;
}

/**
 * Walks back through the history from lines that were reached with
 * the provided number of differences in order to collect the differences.
 */
function getHunks(
  history: Int32Array,
  differences: number,
  oldIndex: number,
  newIndex: number,
  oldLines: Lines,
  newLines: Lines,
) {
  const hunks: Hunk[] = [];
  for (; differences > 0; differences--) {
    // how far a diagonal reached with one less difference
    const previousDifferences = differences - 1;
    const historyStart = getHistoryStart(previousDifferences);
    const get = (diagonal: number) =>
      Math.abs(diagonal) <= previousDifferences
        ? history[historyStart + ((diagonal + previousDifferences) >> 1)]
        : UNSET;
    const diagonal = oldIndex - newIndex;
    const move = getMove(get(diagonal - 1), get(diagonal + 1), diagonal, oldLines, newLines);
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
  const prefixLength = getCommonPrefixLength(oldText, oldStart, oldEnd, newText, newStart, newEnd);
  oldStart += prefixLength;
  newStart += prefixLength;
  const suffixLength = getCommonSuffixLength(oldText, oldStart, oldEnd, newText, newStart, newEnd);
  oldEnd -= suffixLength;
  newEnd -= suffixLength;
  // An edit can't start or end in the middle of a line break or a surrogate pair. These
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

/** The length at and below which the code units are compared one at a time. */
const MAX_CODE_UNIT_COMPARE_LENGTH = 16;
const MAX_CHUNK_LENGTH = 1 << 20;

/**
 * Gets the number of code units at the start of the ranges that are the same.
 *
 * Comparing two strings is much faster than comparing their code units one at
 * a time, so this compares chunks that get larger while they're the same and
 * smaller once they're not in order to find where the difference is.
 */
function getCommonPrefixLength(a: string, aStart: number, aEnd: number, b: string, bStart: number, bEnd: number) {
  const maxLength = Math.min(aEnd - aStart, bEnd - bStart);
  let chunkLength = MAX_CODE_UNIT_COMPARE_LENGTH;
  let length = 0;
  while (length < maxLength) {
    const size = Math.min(chunkLength, maxLength - length);
    const aIndex = aStart + length;
    const bIndex = bStart + length;
    if (size <= MAX_CODE_UNIT_COMPARE_LENGTH) {
      for (let i = 0; i < size; i++) {
        if (a.charCodeAt(aIndex + i) !== b.charCodeAt(bIndex + i)) {
          return length + i;
        }
      }
    } else if (a.substring(aIndex, aIndex + size) !== b.substring(bIndex, bIndex + size)) {
      chunkLength = size >> 1;
      continue;
    }
    length += size;
    chunkLength = Math.min(chunkLength * 2, MAX_CHUNK_LENGTH);
  }
  return length;
}

/** Gets the number of code units at the end of the ranges that are the same. */
function getCommonSuffixLength(a: string, aStart: number, aEnd: number, b: string, bStart: number, bEnd: number) {
  const maxLength = Math.min(aEnd - aStart, bEnd - bStart);
  let chunkLength = MAX_CODE_UNIT_COMPARE_LENGTH;
  let length = 0;
  while (length < maxLength) {
    const size = Math.min(chunkLength, maxLength - length);
    const aIndex = aEnd - length;
    const bIndex = bEnd - length;
    if (size <= MAX_CODE_UNIT_COMPARE_LENGTH) {
      for (let i = 1; i <= size; i++) {
        if (a.charCodeAt(aIndex - i) !== b.charCodeAt(bIndex - i)) {
          return length + i - 1;
        }
      }
    } else if (a.substring(aIndex - size, aIndex) !== b.substring(bIndex - size, bIndex)) {
      chunkLength = size >> 1;
      continue;
    }
    length += size;
    chunkLength = Math.min(chunkLength * 2, MAX_CHUNK_LENGTH);
  }
  return length;
}
