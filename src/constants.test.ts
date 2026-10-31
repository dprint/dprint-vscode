import * as assert from "node:assert";
import { describe, it } from "node:test";
import { DPRINT_CONFIG_FILEPATH_GLOB, getConfigFilePathGlob, isDprintExtensionId } from "./constants";

describe("getConfigFilePathGlob", () => {
  it("matches the names in either case on a case insensitive file system", () => {
    // ex. `Dprint.json` on Windows or macOS, which dprint finds there
    assert.strictEqual(
      getConfigFilePathGlob("win32"),
      "**/{[dD][pP][rR][iI][nN][tT],.[dD][pP][rR][iI][nN][tT]}.{[jJ][sS][oO][nN],[jJ][sS][oO][nN][cC]}",
    );
    assert.strictEqual(getConfigFilePathGlob("darwin"), getConfigFilePathGlob("win32"));
    assert.strictEqual(getConfigFilePathGlob("linux"), DPRINT_CONFIG_FILEPATH_GLOB);
  });
});

describe("isDprintExtensionId", () => {
  it("matches the extension id ignoring case", () => {
    assert.strictEqual(isDprintExtensionId("dprint.dprint"), true);
    assert.strictEqual(isDprintExtensionId("Dprint.Dprint"), true);
  });

  it("does not match other values", () => {
    assert.strictEqual(isDprintExtensionId("esbenp.prettier-vscode"), false);
    assert.strictEqual(isDprintExtensionId(undefined), false);
    assert.strictEqual(isDprintExtensionId(null), false);
  });
});
