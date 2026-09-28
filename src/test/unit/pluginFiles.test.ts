import * as assert from "node:assert";
import * as path from "node:path";
import { describe, it } from "node:test";
import { hasPluginForFile } from "../../pluginFiles";

describe("hasPluginForFile", () => {
  const typescriptPlugin = { fileExtensions: ["ts", "tsx"], fileNames: [] };
  const jsonPlugin = { fileExtensions: ["json", "jsonc"], fileNames: [] };
  const dockerfilePlugin = { fileExtensions: [], fileNames: ["Dockerfile"] };
  const settingsPath = path.resolve("/user/Code/User/settings.json");

  it("matches a plugin by extension", () => {
    assert.strictEqual(hasPluginForFile([typescriptPlugin, jsonPlugin], settingsPath), true);
  });

  it("does not match when no plugin handles the extension", () => {
    assert.strictEqual(hasPluginForFile([typescriptPlugin], settingsPath), false);
    assert.strictEqual(hasPluginForFile([], settingsPath), false);
  });

  it("matches the extension case insensitively", () => {
    assert.strictEqual(hasPluginForFile([jsonPlugin], path.resolve("/a/SETTINGS.JSON")), true);
  });

  it("matches a plugin's extension case insensitively", () => {
    assert.strictEqual(hasPluginForFile([{ fileExtensions: ["JSON"], fileNames: [] }], settingsPath), true);
  });

  it("uses the last extension", () => {
    assert.strictEqual(hasPluginForFile([typescriptPlugin], path.resolve("/a/types.d.ts")), true);
  });

  it("matches a plugin by file name case insensitively", () => {
    assert.strictEqual(hasPluginForFile([dockerfilePlugin], path.resolve("/a/dockerfile")), true);
    assert.strictEqual(hasPluginForFile([dockerfilePlugin], path.resolve("/a/Dockerfile.dev")), false);
  });

  it("does not treat a dot file's name as an extension", () => {
    assert.strictEqual(hasPluginForFile([jsonPlugin], path.resolve("/a/.json")), false);
  });
});
