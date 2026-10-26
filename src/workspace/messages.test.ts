import * as assert from "node:assert";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import { BodyReader, encodeMessage, MessageDecoder, MessageKind, parseEditorServiceInfo } from "./messages";

describe("encodeMessage", () => {
  it("encodes the header, the parts and the success bytes", () => {
    const buf = encodeMessage(3, MessageKind.CancelFormat, [7, "é"]);
    assert.strictEqual(
      buf.toString("hex"),
      "00000003" // id
        + "00000008" // kind
        + "0000000a" // body length
        + "00000007" // number
        + "00000002c3a9" // text with its byte length
        + "ffffffff",
    );
  });
});

describe("MessageDecoder", () => {
  it("decodes the messages of each chunk once they're complete", () => {
    const decoder = new MessageDecoder();
    const first = encodeMessage(1, MessageKind.SuccessResponse, [5]);
    const second = encodeMessage(2, MessageKind.ErrorResponse, [6, "failed"]);
    const data = Buffer.concat([first, second]);

    assert.deepStrictEqual(decoder.push(data.subarray(0, 5)), []);
    const messages = decoder.push(data.subarray(5, first.length + 3));
    assert.deepStrictEqual(messages.map(message => [message.id, message.kind]), [[1, MessageKind.SuccessResponse]]);
    assert.strictEqual(new BodyReader(messages[0].body).readInt(), 5);

    const [message] = decoder.push(data.subarray(first.length + 3));
    const body = new BodyReader(message.body);
    assert.deepStrictEqual([message.id, body.readInt(), body.readSizedString()], [2, 6, "failed"]);
  });

  it("throws when a message doesn't end with the success bytes", () => {
    const buf = encodeMessage(1, MessageKind.Active, []);
    buf[buf.length - 1] = 0;
    assert.throws(() => new MessageDecoder().push(buf), /Expected the success bytes/);
  });
});

describe("parseEditorServiceInfo", () => {
  it("gets the info when it supports schema version 6", () => {
    assert.deepStrictEqual(
      parseEditorServiceInfo({
        cliVersion: "0.65.0",
        editorServiceSchemaVersions: [5, 6],
        configSchemaUrl: "https://dprint.dev/schemas/v0.json",
        capabilities: {},
      }),
      {
        cliVersion: "0.65.0",
        editorServiceSchemaVersions: [5, 6],
        configSchemaUrl: "https://dprint.dev/schemas/v0.json",
      },
    );
  });

  it("says why it can't be used", () => {
    assert.deepStrictEqual(
      parseEditorServiceInfo({ cliVersion: "0.66.0", editorServiceSchemaVersions: [7] }),
      { error: "dprint 0.66.0 doesn't support schema version 6 of the editor service." },
    );
    assert.deepStrictEqual(parseEditorServiceInfo({}), {
      error: "The editor service info is missing its schema versions.",
    });
    assert.deepStrictEqual(parseEditorServiceInfo("text"), { error: "The editor service info isn't an object." });
  });
});
