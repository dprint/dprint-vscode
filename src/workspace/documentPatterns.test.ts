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
      }),
      ["**/*.{[jJ][sS][oO][nN],[tT][sS]}", "**/[dD][oO][cC][kK][eE][rR][fF][iI][lL][eE]"],
    );
    assert.deepStrictEqual(getConfigFilePatterns({ plugins: [plugin({ fileExtensions: ["d.ts"] })] }), [
      "**/*.[dD].[tT][sS]",
    ]);
  });

  it("matches every file when what's formatted can't be matched with a glob", () => {
    const associations = plugin({ fileExtensions: ["ts"], associations: ["**/*.mts"] });
    assert.deepStrictEqual(getConfigFilePatterns({ plugins: [associations] }), [ALL_FILES_PATTERN]);
    const shebangs = { "#!/usr/bin/env node": "js" };
    assert.deepStrictEqual(getConfigFilePatterns({ plugins: [plugin({ fileExtensions: ["js"] })], shebangs }), [
      ALL_FILES_PATTERN,
    ]);
    assert.deepStrictEqual(getConfigFilePatterns({ plugins: [plugin({ fileNames: ["{a}"] })] }), [ALL_FILES_PATTERN]);
  });

  it("matches every file when dprint will format them once the user does something", () => {
    for (const reason of ["processPluginsNotAllowed", "configError"]) {
      assert.deepStrictEqual(getConfigFilePatterns({ plugins: [], reason }), [ALL_FILES_PATTERN]);
    }
  });

  it("matches nothing without plugins", () => {
    assert.deepStrictEqual(getConfigFilePatterns({ plugins: [] }), []);
    assert.deepStrictEqual(getConfigFilePatterns({ plugins: [], reason: "noConfigFile" }), []);
  });
});

function plugin(info: Partial<PluginInfo>): PluginInfo {
  return {
    name: "test-plugin",
    version: "0.1.0",
    configKey: "test",
    fileExtensions: [],
    fileNames: [],
    configSchemaUrl: undefined,
    helpUrl: "",
    updateUrl: undefined,
    ...info,
  };
}
