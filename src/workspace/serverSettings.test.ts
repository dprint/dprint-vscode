import * as assert from "node:assert";
import { describe, it } from "node:test";
import { getServerSettings } from "./serverSettings";

describe("getServerSettings", () => {
  it("provides each setting", () => {
    assert.deepStrictEqual(
      getServerSettings({ useGlobalConfig: true, ensureStableFormat: true, verbose: true }, {}),
      { useGlobalConfig: true, ensureStableFormat: true, verbose: true },
    );
    // a setting that's off is provided too, so the server doesn't keep the value it had
    assert.deepStrictEqual(
      getServerSettings({ useGlobalConfig: false, ensureStableFormat: false, verbose: false }, {}),
      { useGlobalConfig: false, ensureStableFormat: false, verbose: false },
    );
  });

  it("is what the environment variable says when a setting is off", () => {
    const config = { useGlobalConfig: false, ensureStableFormat: false, verbose: false };
    for (const [value, expected] of [["1", true], [" TRUE\n", true], ["0", false], ["", false]] as const) {
      assert.deepStrictEqual(
        getServerSettings(config, { DPRINT_EDITOR_USE_GLOBAL_CONFIG: value, DPRINT_EDITOR_STABLE_FORMAT: value }),
        { useGlobalConfig: expected, ensureStableFormat: expected, verbose: false },
        value,
      );
    }
  });
});
