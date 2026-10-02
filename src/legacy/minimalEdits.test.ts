import * as assert from "node:assert";
import { describe, it } from "node:test";
import { getMinimalEdits, type OffsetEdit } from "./minimalEdits";

describe("getMinimalEdits", () => {
  it("returns no edits when the text is the same", () => {
    assert.deepStrictEqual(getMinimalEdits("a\nb\n", "a\nb\n"), []);
    assert.deepStrictEqual(getMinimalEdits("", ""), []);
  });

  it("returns no edits when only the line endings differ", () => {
    assert.deepStrictEqual(getMinimalEdits("a\r\nb\r\n", "a\nb\n"), []);
    assert.deepStrictEqual(getMinimalEdits("a\nb\n", "a\r\nb\r\n"), []);
  });

  it("only replaces what changed within a line", () => {
    const text = "let a = 1;\nlet  b = 2;\nlet c = 3;\n";
    assert.deepStrictEqual(getMinimalEdits(text, "let a = 1;\nlet b = 2;\nlet c = 3;\n"), [
      { start: 15, end: 16, newText: "" },
    ]);
  });

  it("returns an edit for each group of changed lines", () => {
    const text = "let  a = 1;\nlet b = 2;\nlet c = 3;\nlet  d = 4;\n";
    assert.deepStrictEqual(getMinimalEdits(text, "let a = 1;\nlet b = 2;\nlet c = 3;\nlet d = 4;\n"), [
      { start: 4, end: 5, newText: "" },
      { start: 38, end: 39, newText: "" },
    ]);
  });

  it("inserts added lines", () => {
    assert.deepStrictEqual(getMinimalEdits("a\nb\n", "a\nx\ny\nb\n"), [{ start: 2, end: 2, newText: "x\ny\n" }]);
    assert.deepStrictEqual(getMinimalEdits("a\nb\n", "x\na\nb\n"), [{ start: 0, end: 0, newText: "x\n" }]);
    assert.deepStrictEqual(getMinimalEdits("a\nb\n", "a\nb\nx\n"), [{ start: 4, end: 4, newText: "x\n" }]);
  });

  it("removes removed lines", () => {
    assert.deepStrictEqual(getMinimalEdits("a\nx\ny\nb\n", "a\nb\n"), [{ start: 2, end: 6, newText: "" }]);
    assert.deepStrictEqual(getMinimalEdits("x\na\nb\n", "a\nb\n"), [{ start: 0, end: 2, newText: "" }]);
    assert.deepStrictEqual(getMinimalEdits("a\nb\nx\n", "a\nb\n"), [{ start: 4, end: 6, newText: "" }]);
  });

  it("handles a final line without a line break", () => {
    assert.deepStrictEqual(getMinimalEdits("a\nb", "a\nb\n"), [{ start: 3, end: 3, newText: "\n" }]);
    assert.deepStrictEqual(getMinimalEdits("a\nb\n", "a\nb"), [{ start: 3, end: 4, newText: "" }]);
    assert.deepStrictEqual(getMinimalEdits("a\n\n\n", "a\n"), [{ start: 2, end: 4, newText: "" }]);
  });

  it("handles empty text", () => {
    assert.deepStrictEqual(getMinimalEdits("", "a\n"), [{ start: 0, end: 0, newText: "a\n" }]);
    assert.deepStrictEqual(getMinimalEdits("a\n", ""), [{ start: 0, end: 2, newText: "" }]);
  });

  it("handles text without line breaks", () => {
    assert.deepStrictEqual(getMinimalEdits("{  a  }", "{ a }"), [{ start: 2, end: 5, newText: "a" }]);
  });

  it("keeps the lines that moved the least when lines are reordered", () => {
    const edits = getMinimalEdits("import b;\nimport a;\nfoo();\n", "import a;\nimport b;\nfoo();\n");
    assert.strictEqual(applyEdits("import b;\nimport a;\nfoo();\n", edits), "import a;\nimport b;\nfoo();\n");
    assert.strictEqual(edits.length, 2);
  });

  describe("line endings", () => {
    it("uses the line endings of the original text in the edits", () => {
      assert.deepStrictEqual(getMinimalEdits("a\r\nb\r\n", "a\nx\nb\n"), [{ start: 3, end: 3, newText: "x\r\n" }]);
      assert.deepStrictEqual(getMinimalEdits("a\nb\n", "a\r\nx\r\nb\r\n"), [{ start: 2, end: 2, newText: "x\n" }]);
    });

    it("does not start or end an edit in the middle of a line break", () => {
      // the text that's the same at the start and end of these changed lines ends with a `\r`
      const edits = getMinimalEdits("a\r\nb\r\n", "a\r\nb\r\r\n");
      assert.deepStrictEqual(edits, [{ start: 4, end: 6, newText: "\r\r\n" }]);
    });
  });

  it("does not start or end an edit in the middle of a surrogate pair", () => {
    // these have the same high surrogate and a different low surrogate
    assert.deepStrictEqual(getMinimalEdits("a\n\u{1F600}\n", "a\n\u{1F601}\n"), [
      { start: 2, end: 4, newText: "\u{1F601}" },
    ]);
    // and these the same low surrogate and a different high surrogate
    assert.deepStrictEqual(getMinimalEdits("a\n\u{1F600}\n", "a\n\u{1F200}\n"), [
      { start: 2, end: 4, newText: "\u{1F200}" },
    ]);
  });

  it("replaces the changed part of the text with one edit when there are too many differences", () => {
    const lineCount = 2_000;
    const lines = Array.from({ length: lineCount }, (_, i) => `  line${i};\n`);
    const originalText = "start\n" + lines.join("") + "end\n";
    const formattedText = "start\n" + lines.map(line => line.trimStart()).join("") + "end\n";
    const edits = getMinimalEdits(originalText, formattedText);
    assert.strictEqual(edits.length, 1);
    // doesn't include the lines at the start and end that are the same
    assert.strictEqual(edits[0].start, "start\n".length);
    assert.strictEqual(applyEdits(originalText, edits), formattedText);
  });

  it("finds a change after a lot of text that's the same", () => {
    // the text that's the same is compared in chunks of different lengths
    for (const length of [1, 15, 16, 17, 31, 32, 33, 100, 1_000, 5_000, 70_000]) {
      const same = "abcdefg\n".repeat(length).substring(0, length);
      assert.deepStrictEqual(
        getMinimalEdits(`${same}\nx  y\n${same}`, `${same}\nx y\n${same}`),
        [{ start: length + 3, end: length + 4, newText: "" }],
        `length ${length}`,
      );
    }
  });

  it("returns an edit for each change when they're far apart", () => {
    const same = Array.from({ length: 100 }, (_, i) => `line${i};\n`).join("");
    const originalText = `a  b\n${same}c  d\n${same}e  f\n`;
    const formattedText = `a b\n${same}c d\nnew\n${same}e f\n`;
    const edits = getMinimalEdits(originalText, formattedText);
    assert.deepStrictEqual(edits.map(edit => edit.newText), ["", "d\nnew", ""]);
    assert.strictEqual(applyEdits(originalText, edits), formattedText);
  });

  it("returns an edit for each change when there's only a few of the same lines between them", () => {
    // these don't have enough of the same lines between them to stop diffing the lines
    const originalText = "a  b\nsame1\nc  d\nsame2\nsame3\ne  f\n";
    assert.deepStrictEqual(getMinimalEdits(originalText, "a b\nsame1\nc d\nsame2\nsame3\ne f\n"), [
      { start: 2, end: 3, newText: "" },
      { start: 13, end: 14, newText: "" },
      { start: 30, end: 31, newText: "" },
    ]);
  });

  it("stops diffing the lines once that took too much work in total", () => {
    const createText = (indent: string) =>
      Array.from(
        { length: 30 },
        (_, group) =>
          Array.from({ length: 150 }, (_, i) => `${indent}changed${group}_${i};\n`).join("")
          + Array.from({ length: 10 }, (_, i) => `same${group}_${i};\n`).join(""),
      ).join("");
    const originalText = createText("  ");
    const formattedText = createText("");
    const edits = getMinimalEdits(originalText, formattedText);
    // an edit for each group until the limit and then a single edit for the rest
    assert.ok(edits.length > 1 && edits.length < 30, `edits: ${edits.length}`);
    assert.strictEqual(applyEdits(originalText, edits), formattedText);
  });

  it("produces the formatted text for random changes", () => {
    const random = createRandom(1234);
    const randomInt = (max: number) => Math.floor(random() * max);
    const allLineTexts = [
      "a",
      "b",
      "  a",
      "a  b",
      "",
      "\u{1F600}",
      "{",
      "}",
      "a line that is longer than the others",
      "a line that is longer than the other lines",
    ];
    for (let i = 0; i < 5_000; i++) {
      const lineBreak = randomInt(2) === 0 ? "\n" : "\r\n";
      const createText = (lines: string[], hasFinalLineBreak: boolean) =>
        lines.join(lineBreak) + (hasFinalLineBreak && lines.length > 0 ? lineBreak : "");
      // only a couple of different lines has many lines in a row that are the same by chance
      const lineTexts = randomInt(2) === 0 ? allLineTexts.slice(0, 2) : allLineTexts;
      // some longer texts with more changes in order to have changes that are far apart
      const maxLineCount = i % 5 === 0 ? 200 : 12;
      const maxChangeCount = i % 10 === 0 ? 40 : 5;
      const lines = Array.from({ length: randomInt(maxLineCount) }, () => lineTexts[randomInt(lineTexts.length)]);
      const newLines = [...lines];
      for (let changes = randomInt(maxChangeCount); changes > 0; changes--) {
        const index = randomInt(newLines.length + 1);
        switch (randomInt(3)) {
          case 0:
            newLines.splice(index, 0, lineTexts[randomInt(lineTexts.length)]);
            break;
          case 1:
            newLines.splice(index, 1);
            break;
          default:
            newLines.splice(index, 1, lineTexts[randomInt(lineTexts.length)]);
            break;
        }
      }
      const originalText = createText(lines, randomInt(2) === 0);
      const formattedText = createText(newLines, randomInt(2) === 0);
      const edits = getMinimalEdits(originalText, formattedText);
      const message = JSON.stringify({ originalText, formattedText, edits });
      assert.strictEqual(applyEdits(originalText, edits), formattedText, message);
      assertValidEdits(originalText, edits, message);
    }
  });
});

/** Asserts the edits are in order, don't overlap, change something, and don't split a character. */
function assertValidEdits(text: string, edits: OffsetEdit[], message: string) {
  let lastEnd = 0;
  for (const edit of edits) {
    assert.ok(edit.start >= lastEnd && edit.end >= edit.start && edit.end <= text.length, message);
    assert.notStrictEqual(text.substring(edit.start, edit.end), edit.newText, message);
    for (const offset of [edit.start, edit.end]) {
      assert.ok(!(text[offset - 1] === "\r" && text[offset] === "\n"), message);
      assert.ok(!(isHighSurrogate(text.charCodeAt(offset - 1)) && isLowSurrogate(text.charCodeAt(offset))), message);
    }
    lastEnd = edit.end;
  }
}

function applyEdits(text: string, edits: OffsetEdit[]) {
  let result = "";
  let lastEnd = 0;
  for (const edit of edits) {
    result += text.substring(lastEnd, edit.start) + edit.newText;
    lastEnd = edit.end;
  }
  return result + text.substring(lastEnd);
}

function isHighSurrogate(charCode: number) {
  return charCode >= 0xD800 && charCode <= 0xDBFF;
}

function isLowSurrogate(charCode: number) {
  return charCode >= 0xDC00 && charCode <= 0xDFFF;
}

/** Creates a seeded random number generator (mulberry32) so a failure is reproducible. */
function createRandom(seed: number) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
