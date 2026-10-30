import * as assert from "node:assert";
import { describe, it } from "node:test";
import { getFormatDocumentResult, getProviderEdits, ShownConfigErrors } from "./formatResults";

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

describe("getProviderEdits", () => {
  it("is the edits, no edits when formatting failed, and otherwise undefined", () => {
    assert.deepStrictEqual(getProviderEdits({ edits: [] }), []);
    assert.deepStrictEqual(getProviderEdits({ notFormattedReason: "failed" }), []);
    assert.strictEqual(getProviderEdits({ notFormattedReason: "notMatched" }), undefined);
  });
});

describe("ShownConfigErrors", () => {
  const configFile = { uri: "file:///dprint.json", dirUri: "file:///" };
  const otherConfigFile = { uri: "file:///other/dprint.json", dirUri: "file:///other" };

  it("only shows an error of a config file once until it changes", () => {
    const shown = new ShownConfigErrors();
    assert.strictEqual(shown.shouldShow(configFile, "Error."), true);
    assert.strictEqual(shown.shouldShow(configFile, "Error."), false);
    assert.strictEqual(shown.shouldShow(otherConfigFile, "Error."), true);
    assert.strictEqual(shown.shouldShow(configFile, "Other error."), true);
    shown.forget(configFile);
    assert.strictEqual(shown.shouldShow(configFile, "Other error."), true);
    // the other config file wasn't forgotten
    assert.strictEqual(shown.shouldShow(otherConfigFile, "Error."), false);
  });

  it("shows an error of the global config file once for each directory", () => {
    const shown = new ShownConfigErrors();
    const global = (dirUri: string) => ({ uri: "file:///global/dprint.json", dirUri });
    assert.strictEqual(shown.shouldShow(global("file:///c%3A/"), "Error."), true);
    assert.strictEqual(shown.shouldShow(global("file:///d%3A/"), "Error."), true);
    shown.forget(global("file:///c%3A/"));
    assert.strictEqual(shown.shouldShow(global("file:///c%3A/"), "Error."), true);
    assert.strictEqual(shown.shouldShow(global("file:///d%3A/"), "Error."), false);
    // each directory without one
    shown.forget({ uri: "file:///global/dprint.json" });
    assert.strictEqual(shown.shouldShow(global("file:///c%3A/"), "Error."), true);
    assert.strictEqual(shown.shouldShow(global("file:///d%3A/"), "Error."), true);
  });

  it("shows each error without a config file once until every one is forgotten", () => {
    const shown = new ShownConfigErrors();
    assert.strictEqual(shown.shouldShow(undefined, "Error."), true);
    assert.strictEqual(shown.shouldShow(undefined, "Other error."), true);
    assert.strictEqual(shown.shouldShow(undefined, "Error."), false);
    shown.clear();
    assert.strictEqual(shown.shouldShow(undefined, "Error."), true);
  });
});
