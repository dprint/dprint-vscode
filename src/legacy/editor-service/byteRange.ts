import { Buffer } from "node:buffer";

// note: this file should not import "vscode" so that it can be unit tested

/** A range of UTF-8 byte indexes within a file's text. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Converts a range of UTF-16 code unit offsets (the offsets used by vscode)
 * to a range of UTF-8 byte indexes (the indexes used by dprint).
 *
 * Offsets that fall between a surrogate pair are widened to include the
 * whole character.
 */
export function getUtf8ByteRange(text: string, startOffset: number, endOffset: number): ByteRange {
  startOffset = clampOffset(text, startOffset);
  endOffset = clampOffset(text, Math.max(startOffset, endOffset));
  if (isBetweenSurrogatePair(text, startOffset)) {
    startOffset--;
  }
  if (isBetweenSurrogatePair(text, endOffset)) {
    endOffset++;
  }
  const start = Buffer.byteLength(text.slice(0, startOffset), "utf8");
  const end = start + Buffer.byteLength(text.slice(startOffset, endOffset), "utf8");
  return { start, end };
}

function clampOffset(text: string, offset: number) {
  return Math.min(Math.max(offset, 0), text.length);
}

function isBetweenSurrogatePair(text: string, offset: number) {
  return offset > 0 && offset < text.length
    && isHighSurrogate(text.charCodeAt(offset - 1))
    && isLowSurrogate(text.charCodeAt(offset));
}

function isHighSurrogate(charCode: number) {
  return charCode >= 0xd800 && charCode <= 0xdbff;
}

function isLowSurrogate(charCode: number) {
  return charCode >= 0xdc00 && charCode <= 0xdfff;
}
