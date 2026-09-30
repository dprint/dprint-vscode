import * as assert from "node:assert";
import { describe, it } from "node:test";
import { trimFormattedCellText } from "./notebookCellText";
import { getRangeFormatEdit } from "./rangeFormat";

describe("trimFormattedCellText", () => {
  it("trims the trailing whitespace when formatting the whole cell", () => {
    assert.strictEqual(trimFormattedCellText("a=1\n", "a = 1\n", undefined), "a = 1");
    assert.strictEqual(trimFormattedCellText("a=1", "a = 1\n\n", undefined), "a = 1");
  });

  it("trims the trailing whitespace when the range reaches the end of the cell", () => {
    const originalText = "a = 1\nb=2\n";
    assert.strictEqual(
      trimFormattedCellText(originalText, "a = 1\nb = 2\n", { start: 6, end: originalText.length }),
      "a = 1\nb = 2",
    );
  });

  it("keeps the cell's trailing whitespace when the range ends before the end of the cell", () => {
    const originalText = "a=1\nb = 2\n";
    const range = { start: 0, end: 4 };
    const formattedText = trimFormattedCellText(originalText, "a = 1\nb = 2\n", range);
    assert.strictEqual(formattedText, "a = 1\nb = 2\n");
    assert.deepStrictEqual(getRangeFormatEdit(originalText, formattedText, range), {
      start: 0,
      end: 4,
      newText: "a = 1\n",
    });
  });

  it("keeps a cell without trailing whitespace that way when the range ends before the end", () => {
    const originalText = "a=1\nb = 2";
    const range = { start: 0, end: 4 };
    const formattedText = trimFormattedCellText(originalText, "a = 1\nb = 2\n", range);
    assert.strictEqual(formattedText, "a = 1\nb = 2");
    assert.deepStrictEqual(getRangeFormatEdit(originalText, formattedText, range), {
      start: 0,
      end: 4,
      newText: "a = 1\n",
    });
  });
});
