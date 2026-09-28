import * as assert from "node:assert";
import { describe, it } from "node:test";
import { expandToLines, getRangeFormatEdit } from "../../legacy/rangeFormat";

describe("expandToLines", () => {
  const text = "a\n  bb\nccc\n";

  it("expands a range within a line to the whole line", () => {
    assert.deepStrictEqual(expandToLines(text, { start: 4, end: 5 }), { start: 2, end: 7 });
  });

  it("expands an empty range to its line", () => {
    assert.deepStrictEqual(expandToLines(text, { start: 4, end: 4 }), { start: 2, end: 7 });
  });

  it("expands a range spanning multiple lines", () => {
    assert.deepStrictEqual(expandToLines(text, { start: 1, end: 8 }), { start: 0, end: 11 });
  });

  it("does not include the next line when the range ends at the start of it", () => {
    assert.deepStrictEqual(expandToLines(text, { start: 2, end: 7 }), { start: 2, end: 7 });
  });

  it("expands to the end of text without a trailing line break", () => {
    assert.deepStrictEqual(expandToLines("a\nbb", { start: 3, end: 3 }), { start: 2, end: 4 });
  });

  it("does not move the start past the start of the text", () => {
    assert.deepStrictEqual(expandToLines("\na", { start: 0, end: 0 }), { start: 0, end: 1 });
  });

  it("includes carriage returns in the line break", () => {
    assert.deepStrictEqual(expandToLines("a\r\nbb\r\nc", { start: 4, end: 4 }), { start: 3, end: 7 });
  });
});

describe("getRangeFormatEdit", () => {
  const text = "let  a = 1;\nlet  b = 2;\nlet  c = 3;\n";
  const secondLine = { start: 12, end: 24 };

  it("returns an edit when only the range changed", () => {
    const formatted = "let  a = 1;\nlet b = 2;\nlet  c = 3;\n";
    assert.deepStrictEqual(getRangeFormatEdit(text, formatted, secondLine), {
      start: 12,
      end: 24,
      newText: "let b = 2;\n",
    });
  });

  it("returns an edit when the range was removed", () => {
    const formatted = "let  a = 1;\nlet  c = 3;\n";
    assert.deepStrictEqual(getRangeFormatEdit(text, formatted, secondLine), { start: 12, end: 24, newText: "" });
  });

  it("returns undefined when text before the range changed", () => {
    const formatted = "let a = 1;\nlet b = 2;\nlet  c = 3;\n";
    assert.strictEqual(getRangeFormatEdit(text, formatted, secondLine), undefined);
  });

  it("returns undefined when text after the range changed", () => {
    const formatted = "let  a = 1;\nlet b = 2;\nlet c = 3;\n";
    assert.strictEqual(getRangeFormatEdit(text, formatted, secondLine), undefined);
  });

  it("returns undefined when the prefix and suffix would overlap", () => {
    // the formatted text is shorter than the unchanged text around the range
    assert.strictEqual(getRangeFormatEdit("aaXaa", "aaa", { start: 2, end: 3 }), undefined);
  });
});
