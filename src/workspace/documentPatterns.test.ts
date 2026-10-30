import * as assert from "node:assert";
import { describe, it } from "node:test";
import { ALL_FILES_PATTERN, getConfigFilePatterns } from "./documentPatterns";
import type { PluginInfo } from "./messages";

describe("getConfigFilePatterns", () => {
  it("uses the patterns dprint provides", () => {
    assert.deepStrictEqual(
      getConfigFilePatterns({
        plugins: [plugin()],
        otherFiles: [],
        status: { kind: "ready" },
        filePatterns: [
          { glob: "**/*.[tT][sS]", configKeys: ["test"] },
          { glob: "src/**/*.other", configKeys: ["test"] },
        ],
      }),
      ["**/*.[tT][sS]", "src/**/*.other"],
    );
  });

  it("matches every file when what's formatted can't be matched with a glob", () => {
    // ex. a shebang
    assert.deepStrictEqual(
      getConfigFilePatterns({
        plugins: [plugin()],
        otherFiles: [{ kind: "shebang", values: ["#!/usr/bin/env node"] }],
        status: { kind: "ready" },
        filePatterns: [{ glob: "**/*.[tT][sS]", configKeys: ["test"] }],
      }),
      [ALL_FILES_PATTERN],
    );
  });

  it("matches nothing when the plugins aren't known", () => {
    // ex. a download needs to be approved
    assert.deepStrictEqual(
      getConfigFilePatterns({ plugins: null, otherFiles: [], filePatterns: [], status: { kind: "ready" } }),
      [],
    );
  });

  it("matches nothing without plugins", () => {
    assert.deepStrictEqual(
      getConfigFilePatterns({
        plugins: [],
        otherFiles: [{ kind: "shebang", values: ["#!/bin/sh"] }],
        filePatterns: [],
        status: { kind: "ready" },
      }),
      [],
    );
  });

  it("matches nothing when dprint says not to claim the files", () => {
    // ex. what needs to be approved was denied
    assert.deepStrictEqual(
      getConfigFilePatterns({
        plugins: [plugin()],
        otherFiles: [],
        filePatterns: [{ glob: "**/*.[tT][sS]", configKeys: ["test"] }],
        status: { kind: "notFormatted", reason: "approvalRequired", show: "command", claim: false },
      }),
      [],
    );
  });
});

function plugin(): PluginInfo {
  return {
    name: "test-plugin",
    version: "0.1.0",
    configKey: "test",
    fileExtensions: ["ts"],
    fileNames: [],
  };
}
