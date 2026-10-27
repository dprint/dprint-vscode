import * as assert from "node:assert";
import { describe, it } from "node:test";
import { expandToLines, getRangeEdits } from "./textRange";

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

describe("getRangeEdits", () => {
  const text = "a\n\n\nb\n";

  it("keeps the edits within the range", () => {
    const edits = [{ start: 1, end: 2, newText: "" }];
    assert.deepStrictEqual(getRangeEdits(text, edits, { start: 0, end: 3 }), edits);
  });

  it("replaces the range when an edit just outside it only changes the range's text", () => {
    // removing the third line break instead of the second has the same result
    const edits = [{ start: 3, end: 4, newText: "" }];
    assert.deepStrictEqual(getRangeEdits(text, edits, { start: 0, end: 3 }), [{ start: 0, end: 3, newText: "a\n" }]);
  });

  it("is undefined when the text outside the range changed", () => {
    const edits = [{ start: 4, end: 5, newText: "c" }];
    assert.strictEqual(getRangeEdits(text, edits, { start: 0, end: 3 }), undefined);
  });

  describe("with CRLF line breaks", () => {
    const crlfText = "a\r\n\r\n\r\nb\r\n";

    it("keeps the edits within the range", () => {
      const edits = [{ start: 1, end: 3, newText: "" }];
      assert.deepStrictEqual(getRangeEdits(crlfText, edits, { start: 0, end: 5 }), edits);
    });

    it("replaces the range when an edit just outside it only changes the range's text", () => {
      // removing the third line break instead of the second has the same result
      const edits = [{ start: 5, end: 7, newText: "" }];
      assert.deepStrictEqual(getRangeEdits(crlfText, edits, { start: 0, end: 5 }), [
        { start: 0, end: 5, newText: "a\r\n" },
      ]);
    });

    it("is undefined when an edit splits a line break outside the range", () => {
      // the range's line breaks stay, but the carriage return after it is removed
      const edits = [{ start: 5, end: 6, newText: "" }];
      assert.strictEqual(getRangeEdits(crlfText, edits, { start: 0, end: 5 }), undefined);
    });

    it("is undefined when the line breaks outside the range changed", () => {
      const edits = [{ start: 8, end: 10, newText: "\n" }];
      assert.strictEqual(getRangeEdits(crlfText, edits, { start: 0, end: 5 }), undefined);
    });
  });
});
