import * as assert from "node:assert";
import { describe, it } from "node:test";
import { getCliEnv } from "./cliEnv";

describe("getCliEnv", () => {
  const processEnv = { PATH: "/bin" };

  it("inherits the process environment when there are no options", () => {
    assert.strictEqual(getCliEnv(processEnv, {}), undefined);
    assert.strictEqual(getCliEnv(processEnv, { ensureStableFormat: false }), undefined);
  });

  it("sets the config discovery mode", () => {
    assert.deepStrictEqual(getCliEnv(processEnv, { configDiscovery: "ignore-descendants" }), {
      PATH: "/bin",
      DPRINT_CONFIG_DISCOVERY: "ignore-descendants",
    });
  });

  it("opts into stable formatting", () => {
    assert.deepStrictEqual(getCliEnv(processEnv, { ensureStableFormat: true }), {
      PATH: "/bin",
      DPRINT_EDITOR_STABLE_FORMAT: "1",
    });
  });

  it("sets multiple variables", () => {
    assert.deepStrictEqual(getCliEnv(processEnv, { configDiscovery: "ignore-descendants", ensureStableFormat: true }), {
      PATH: "/bin",
      DPRINT_CONFIG_DISCOVERY: "ignore-descendants",
      DPRINT_EDITOR_STABLE_FORMAT: "1",
    });
  });
});
