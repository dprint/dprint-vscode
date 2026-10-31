import * as assert from "node:assert";
import { describe, it } from "node:test";
import { getNoConfigMessage } from "./noConfigMessage";

describe("getNoConfigMessage", () => {
  it("suggests creating a global config file when using the global config", () => {
    assert.strictEqual(
      getNoConfigMessage({ useGlobalConfig: true, hasGlobalConfig: false }),
      "No dprint configuration file found. Run \"dprint init\" in your project to create one "
        + "or \"dprint init --global\" to create a global one.",
    );
  });

  it("suggests enabling the setting when there's an unused global config file", () => {
    assert.strictEqual(
      getNoConfigMessage({ useGlobalConfig: false, hasGlobalConfig: true }),
      "No dprint configuration file found. Run \"dprint init\" in your project to create one "
        + "or enable the \"dprint.useGlobalConfig\" setting to use your global one.",
    );
  });

  it("only suggests creating a config file otherwise", () => {
    assert.strictEqual(
      getNoConfigMessage({ useGlobalConfig: false, hasGlobalConfig: false }),
      "No dprint configuration file found. Run \"dprint init\" in your project to create one.",
    );
  });
});
