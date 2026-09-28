import * as assert from "node:assert";
import { describe, it } from "node:test";
import { getUtf8ByteRange } from "./byteRange";

describe("getUtf8ByteRange", () => {
  it("returns the same offsets for ascii text", () => {
    assert.deepStrictEqual(getUtf8ByteRange("let a = 1;", 4, 9), { start: 4, end: 9 });
  });

  it("returns the whole text", () => {
    const text = "const é = 1;";
    assert.deepStrictEqual(getUtf8ByteRange(text, 0, text.length), { start: 0, end: Buffer.byteLength(text) });
  });

  it("counts multi-byte characters before and within the range", () => {
    // "é" is 2 bytes, "€" is 3 bytes
    const text = "é = '€';";
    assert.deepStrictEqual(getUtf8ByteRange(text, 1, 7), { start: 2, end: 10 });
  });

  it("counts surrogate pairs as 4 bytes", () => {
    // "😀" is 2 utf-16 code units and 4 utf-8 bytes
    const text = "a😀b";
    assert.deepStrictEqual(getUtf8ByteRange(text, 1, 3), { start: 1, end: 5 });
    assert.deepStrictEqual(getUtf8ByteRange(text, 3, 4), { start: 5, end: 6 });
  });

  it("widens offsets that fall between a surrogate pair", () => {
    const text = "a😀b";
    assert.deepStrictEqual(getUtf8ByteRange(text, 2, 2), { start: 1, end: 5 });
    assert.deepStrictEqual(getUtf8ByteRange(text, 0, 2), { start: 0, end: 5 });
    assert.deepStrictEqual(getUtf8ByteRange(text, 2, 4), { start: 1, end: 6 });
  });

  it("clamps offsets to the text", () => {
    assert.deepStrictEqual(getUtf8ByteRange("abc", -1, 10), { start: 0, end: 3 });
    assert.deepStrictEqual(getUtf8ByteRange("abc", 2, 1), { start: 2, end: 2 });
  });
});
