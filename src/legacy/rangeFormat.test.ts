import * as assert from "node:assert";
import { describe, it } from "node:test";
import { expandToLines, getRangeFormatEdit, isNoChangeEdit, normalizeToSourceLineEndings } from "./rangeFormat";

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

  describe("line endings that differ from the document's", () => {
    const crlfText = "let  a = 1;\r\nlet  b = 2;\r\nlet  c = 3;\r\n";
    const crlfSecondLine = { start: 13, end: 26 };

    it("returns an edit for a CRLF document when the formatted text uses LF", () => {
      const formatted = "let  a = 1;\nlet b = 2;\nlet  c = 3;\n";
      assert.deepStrictEqual(getRangeFormatEdit(crlfText, formatted, crlfSecondLine), {
        start: 13,
        end: 26,
        newText: "let b = 2;\r\n",
      });
    });

    it("uses the document's line endings within the new text", () => {
      const formatted = "let  a = 1;\nlet b =\n  2;\nlet  c = 3;\n";
      assert.deepStrictEqual(getRangeFormatEdit(crlfText, formatted, crlfSecondLine), {
        start: 13,
        end: 26,
        newText: "let b =\r\n  2;\r\n",
      });
    });

    it("returns an edit for the first and last lines of a CRLF document", () => {
      const originalText = "let  a = 1;\r\nlet  b = 2;\r\nlet  c = 3;";
      assert.deepStrictEqual(
        getRangeFormatEdit(originalText, "let a = 1;\nlet  b = 2;\nlet  c = 3;", { start: 0, end: 13 }),
        { start: 0, end: 13, newText: "let a = 1;\r\n" },
      );
      assert.deepStrictEqual(
        getRangeFormatEdit(originalText, "let  a = 1;\nlet  b = 2;\nlet c = 3;\n", { start: 26, end: 37 }),
        { start: 26, end: 37, newText: "let c = 3;\r\n" },
      );
    });

    it("returns an edit for a CRLF document when the formatted text has mixed line endings", () => {
      // ex. a notebook cell's formatted text gets the cell's original trailing whitespace
      const formatted = "let  a = 1;\nlet b = 2;\nlet  c = 3;\r\n";
      assert.deepStrictEqual(getRangeFormatEdit(crlfText, formatted, crlfSecondLine), {
        start: 13,
        end: 26,
        newText: "let b = 2;\r\n",
      });
    });

    it("returns an edit for an LF document when the formatted text uses CRLF", () => {
      const formatted = "let  a = 1;\r\nlet b = 2;\r\nlet  c = 3;\r\n";
      assert.deepStrictEqual(getRangeFormatEdit(text, formatted, secondLine), {
        start: 12,
        end: 24,
        newText: "let b = 2;\n",
      });
    });

    it("returns undefined for a CRLF document when text outside the range changed", () => {
      assert.strictEqual(
        getRangeFormatEdit(crlfText, "let a = 1;\nlet b = 2;\nlet  c = 3;\n", crlfSecondLine),
        undefined,
      );
      assert.strictEqual(
        getRangeFormatEdit(crlfText, "let  a = 1;\nlet b = 2;\nlet c = 3;\n", crlfSecondLine),
        undefined,
      );
    });

    it("leaves the formatted text's line endings alone when the document has no line endings", () => {
      assert.deepStrictEqual(getRangeFormatEdit("let  a = 1;", "let a = 1;\r\n", { start: 0, end: 11 }), {
        start: 0,
        end: 11,
        newText: "let a = 1;\r\n",
      });
    });

    it("returns an edit for text with mixed line endings when the text outside the range is untouched", () => {
      // not expected from vscode, which gives a document a single kind of line ending
      assert.deepStrictEqual(getRangeFormatEdit("a\nb\r\nc  =1\n", "a\nb\r\nc = 1\n", { start: 5, end: 11 }), {
        start: 5,
        end: 11,
        newText: "c = 1\n",
      });
    });
  });
});

describe("isNoChangeEdit", () => {
  it("is true when the formatted text differs only in its line endings", () => {
    const text = "let a = 1;\r\nlet b = 2;\r\n";
    const edit = getRangeFormatEdit(text, "let a = 1;\nlet b = 2;\n", { start: 12, end: 24 });
    assert.deepStrictEqual(edit, { start: 12, end: 24, newText: "let b = 2;\r\n" });
    assert.strictEqual(isNoChangeEdit(text, edit!), true);
  });

  it("is false when the text of the range changed", () => {
    const text = "let a = 1;\r\nlet  b = 2;\r\n";
    const edit = getRangeFormatEdit(text, "let a = 1;\nlet b = 2;\n", { start: 12, end: 25 });
    assert.deepStrictEqual(edit, { start: 12, end: 25, newText: "let b = 2;\r\n" });
    assert.strictEqual(isNoChangeEdit(text, edit!), false);
  });

  it("is false when the text of the range was removed", () => {
    assert.strictEqual(isNoChangeEdit("a\nb\n", { start: 2, end: 4, newText: "" }), false);
  });
});

describe("normalizeToSourceLineEndings", () => {
  it("converts to the line endings of the source text", () => {
    assert.strictEqual(normalizeToSourceLineEndings("a\r\nb", "c\nd\n"), "c\r\nd\r\n");
    assert.strictEqual(normalizeToSourceLineEndings("a\nb", "c\r\nd\r\n"), "c\nd\n");
  });

  it("converts mixed line endings", () => {
    assert.strictEqual(normalizeToSourceLineEndings("a\r\nb", "c\r\nd\ne\r\n"), "c\r\nd\r\ne\r\n");
    assert.strictEqual(normalizeToSourceLineEndings("a\nb", "c\nd\r\ne\n"), "c\nd\ne\n");
    assert.strictEqual(normalizeToSourceLineEndings("a\r\nb", "\nc"), "\r\nc");
  });

  it("leaves text alone that has the line endings already", () => {
    assert.strictEqual(normalizeToSourceLineEndings("a\r\nb", "c\r\nd\r\n"), "c\r\nd\r\n");
    assert.strictEqual(normalizeToSourceLineEndings("a\nb", "c\nd\n"), "c\nd\n");
    assert.strictEqual(normalizeToSourceLineEndings("a\nb", "c"), "c");
  });

  it("leaves carriage returns alone that aren't part of a line ending", () => {
    assert.strictEqual(normalizeToSourceLineEndings("a\nb", "c\rd\n"), "c\rd\n");
    assert.strictEqual(normalizeToSourceLineEndings("a\nb", "c\r\r\nd"), "c\r\nd");
    assert.strictEqual(normalizeToSourceLineEndings("a\r\nb", "c\r\r\nd\re"), "c\r\r\nd\re");
  });

  it("leaves the text alone when the source text has no line endings", () => {
    assert.strictEqual(normalizeToSourceLineEndings("a", "c\r\nd\n"), "c\r\nd\n");
  });
});
