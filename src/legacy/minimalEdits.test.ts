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

  it("produces the formatted text for random changes", () => {
    const random = createRandom(1234);
    const randomInt = (max: number) => Math.floor(random() * max);
    const lineTexts = ["a", "b", "  a", "a  b", "", "\u{1F600}", "{", "}"];
    for (let i = 0; i < 2_000; i++) {
      const lineBreak = randomInt(2) === 0 ? "\n" : "\r\n";
      const createText = (lines: string[], hasFinalLineBreak: boolean) =>
        lines.join(lineBreak) + (hasFinalLineBreak && lines.length > 0 ? lineBreak : "");
      const lines = Array.from({ length: randomInt(12) }, () => lineTexts[randomInt(lineTexts.length)]);
      const newLines = [...lines];
      for (let changes = randomInt(5); changes > 0; changes--) {
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
