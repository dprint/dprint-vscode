import * as assert from "node:assert";
import { describe, it } from "node:test";
import { getFormatDocumentResult, getProviderEdits, isFormatError } from "./formatResults";

describe("getFormatDocumentResult", () => {
  it("is the extension's reason with the message", () => {
    for (
      const [reason, expected] of [
        ["noConfigFile", "noConfigFile"],
        ["globalConfigNotAllowed", "noConfigFile"],
        ["notMatched", "notMatched"],
        ["noPlugin", "noPlugin"],
        ["configDiagnostics", "failed"],
      ]
    ) {
      assert.deepStrictEqual(getFormatDocumentResult(reason, "Message.", false), {
        notFormattedReason: expected,
        notFormattedMessage: "Message.",
      }, reason);
    }
  });

  it("is the reason for a notebook cell when no plugin handles it", () => {
    assert.deepStrictEqual(getFormatDocumentResult("noPlugin", undefined, true), {
      notFormattedReason: "noCellPlugin",
      notFormattedMessage: undefined,
    });
  });

  it("has dprint's message when range formatting isn't supported", () => {
    assert.deepStrictEqual(getFormatDocumentResult("rangeFormattingNotSupported", "Not supported.", false), {
      notFormattedReason: "notMatched",
      notFormattedMessage: "Not supported.",
    });
  });

  it("has dprint's message when the config file failed to resolve", () => {
    assert.deepStrictEqual(getFormatDocumentResult("configError", "Syntax error.", false), {
      notFormattedReason: "failed",
      notFormattedMessage: "Syntax error.",
    });
  });

  it("has dprint's message when something needs to be approved", () => {
    assert.deepStrictEqual(getFormatDocumentResult("approvalRequired", "Not allowed.", false), {
      notFormattedReason: "notMatched",
      notFormattedMessage: "Not allowed.",
    });
  });

  it("is not matched for a reason that's newer than the extension", () => {
    assert.deepStrictEqual(getFormatDocumentResult("someNewReason", "New.", false), {
      notFormattedReason: "notMatched",
      notFormattedMessage: "New.",
    });
  });
});

describe("isFormatError", () => {
  it("is only true for a format error", () => {
    assert.strictEqual(isFormatError("formatError"), true);
    assert.strictEqual(isFormatError("pluginError"), false);
    // a reason that's newer than the extension is treated like a plugin error
    assert.strictEqual(isFormatError("someNewReason"), false);
  });
});

describe("getProviderEdits", () => {
  it("is the edits, no edits when formatting failed, and otherwise undefined", () => {
    assert.deepStrictEqual(getProviderEdits({ edits: [] }), []);
    assert.deepStrictEqual(getProviderEdits({ notFormattedReason: "failed" }), []);
    assert.strictEqual(getProviderEdits({ notFormattedReason: "notMatched" }), undefined);
  });
});
