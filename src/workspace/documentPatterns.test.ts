import * as assert from "node:assert";
import { describe, it } from "node:test";
import { ALL_FILES_PATTERN, getConfigFilePatterns } from "./documentPatterns";
import type { PluginInfo } from "./messages";

describe("getConfigFilePatterns", () => {
  it("matches the file extensions and file names of the plugins ignoring their case", () => {
    assert.deepStrictEqual(
      getConfigFilePatterns({
        plugins: [
          plugin({ fileExtensions: ["ts", "JSON"] }),
          plugin({ fileExtensions: ["ts"], fileNames: ["Dockerfile"] }),
        ],
        formatsOtherFiles: false,
      }),
      ["**/*.{[jJ][sS][oO][nN],[tT][sS]}", "**/[dD][oO][cC][kK][eE][rR][fF][iI][lL][eE]"],
    );
    assert.deepStrictEqual(
      getConfigFilePatterns({ plugins: [plugin({ fileExtensions: ["d.ts"] })], formatsOtherFiles: false }),
      ["**/*.[dD].[tT][sS]"],
    );
  });

  it("matches every file when what's formatted can't be matched with a glob", () => {
    // ex. the associations of a plugin or a shebang
    assert.deepStrictEqual(
      getConfigFilePatterns({ plugins: [plugin({ fileExtensions: ["ts"] })], formatsOtherFiles: true }),
      [ALL_FILES_PATTERN],
    );
    assert.deepStrictEqual(
      getConfigFilePatterns({ plugins: [plugin({ fileNames: ["{a}"] })], formatsOtherFiles: false }),
      [ALL_FILES_PATTERN],
    );
  });

  it("matches nothing when the plugins aren't known", () => {
    // ex. a download or a process plugin needs to be approved
    assert.deepStrictEqual(getConfigFilePatterns({ plugins: null, formatsOtherFiles: false }), []);
    assert.deepStrictEqual(getConfigFilePatterns({ plugins: null, formatsOtherFiles: true }), []);
  });

  it("matches nothing without plugins", () => {
    assert.deepStrictEqual(getConfigFilePatterns({ plugins: [], formatsOtherFiles: false }), []);
    assert.deepStrictEqual(getConfigFilePatterns({ plugins: [], formatsOtherFiles: true }), []);
  });
});

function plugin(info: Partial<PluginInfo>): PluginInfo {
  return {
    name: "test-plugin",
    version: "0.1.0",
    configKey: "test",
    fileExtensions: [],
    fileNames: [],
    ...info,
  };
}
