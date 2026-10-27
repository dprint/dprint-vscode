import * as assert from "node:assert";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { Environment } from "../environment";
import { TestEnvironment } from "../TestEnvironment";
import { findGlobalConfigFile, resolveLooseFolderConfig } from "./configPaths";

const homeDir = path.resolve("/home/user");
const rootDir = path.parse(path.resolve("/")).root;

describe("resolveLooseFolderConfig", () => {
  const filePath = path.resolve("/project/src/file.ts");

  it("uses the directory of the closest ancestor config file", async () => {
    const env = new TestEnvironment({ homeDir });
    env.writeFile(path.join(homeDir, ".config/dprint/dprint.json"), "{}");
    env.writeFile(path.resolve("/project/dprint.json"), "{}");

    const expected = {
      cwd: path.resolve("/project"),
      configFilePath: path.resolve("/project/dprint.json"),
      isGlobalConfig: false,
    };
    assert.deepStrictEqual(await resolveLooseFolderConfig(env, filePath, { useGlobalConfig: true }), expected);
    assert.deepStrictEqual(await resolveLooseFolderConfig(env, filePath, { useGlobalConfig: false }), expected);
  });

  it("uses the file system root when there's only a global config file", async () => {
    const env = new TestEnvironment({ homeDir });
    env.writeFile(path.join(homeDir, ".config/dprint/dprint.json"), "{}");

    assert.deepStrictEqual(await resolveLooseFolderConfig(env, filePath, { useGlobalConfig: true }), {
      cwd: rootDir,
      configFilePath: path.join(homeDir, ".config/dprint/dprint.json"),
      isGlobalConfig: true,
    });
  });

  it("does not use the global config file when disabled", async () => {
    const env = new TestEnvironment({ homeDir });
    env.writeFile(path.join(homeDir, ".config/dprint/dprint.json"), "{}");

    assert.strictEqual(await resolveLooseFolderConfig(env, filePath, { useGlobalConfig: false }), undefined);
  });

  it("returns undefined when there's no config file", async () => {
    const env = new TestEnvironment({ homeDir });

    assert.strictEqual(await resolveLooseFolderConfig(env, filePath, { useGlobalConfig: true }), undefined);
  });
});

describe("findGlobalConfigFile", () => {
  it("uses DPRINT_CONFIG_DIR", async () => {
    const configDir = path.resolve("/custom/config");
    const env = new TestEnvironment({ homeDir, envVars: { DPRINT_CONFIG_DIR: configDir } });
    env.writeFile(path.join(homeDir, ".config/dprint/dprint.json"), "{}");
    const configPath = path.join(configDir, "dprint.json");
    env.writeFile(configPath, "{}");

    assert.strictEqual(await findGlobalConfigFile(env), configPath);
  });

  it("returns undefined for a relative DPRINT_CONFIG_DIR", async () => {
    const env = new TestEnvironment({ homeDir, envVars: { DPRINT_CONFIG_DIR: "config" } });
    env.writeFile(path.join(homeDir, ".config/dprint/dprint.json"), "{}");
    env.writeFile(path.join("config", "dprint.json"), "{}");

    assert.strictEqual(await findGlobalConfigFile(env), undefined);
  });

  it("ignores an empty DPRINT_CONFIG_DIR", async () => {
    const env = new TestEnvironment({ homeDir, envVars: { DPRINT_CONFIG_DIR: "" } });
    const configPath = path.join(homeDir, ".config/dprint/dprint.json");
    env.writeFile(configPath, "{}");

    assert.strictEqual(await findGlobalConfigFile(env), configPath);
  });

  it("prefers dprint.jsonc over dprint.json", async () => {
    const env = new TestEnvironment({ homeDir });
    env.writeFile(path.join(homeDir, ".config/dprint/dprint.json"), "{}");
    const configPath = path.join(homeDir, ".config/dprint/dprint.jsonc");
    env.writeFile(configPath, "{}");

    assert.strictEqual(await findGlobalConfigFile(env), configPath);
  });

  it("does not use local config file names", async () => {
    const env = new TestEnvironment({ homeDir });
    env.writeFile(path.join(homeDir, ".config/dprint/.dprint.json"), "{}");

    assert.strictEqual(await findGlobalConfigFile(env), undefined);
  });

  it("returns undefined when there's no global config file", async () => {
    const env = new TestEnvironment({ homeDir });

    assert.strictEqual(await findGlobalConfigFile(env), undefined);
  });

  describe("linux", () => {
    it("uses an absolute XDG_CONFIG_HOME", async () => {
      const xdgConfigHome = path.resolve("/xdg");
      const env = new TestEnvironment({ platform: "linux", homeDir, envVars: { XDG_CONFIG_HOME: xdgConfigHome } });
      const configPath = path.join(xdgConfigHome, "dprint/dprint.json");
      env.writeFile(configPath, "{}");

      assert.strictEqual(await findGlobalConfigFile(env), configPath);
    });

    it("ignores a relative XDG_CONFIG_HOME", async () => {
      const env = new TestEnvironment({ platform: "linux", homeDir, envVars: { XDG_CONFIG_HOME: "xdg" } });
      const configPath = path.join(homeDir, ".config/dprint/dprint.json");
      env.writeFile(configPath, "{}");

      assert.strictEqual(await findGlobalConfigFile(env), configPath);
    });

    it("returns undefined without a home directory", async () => {
      const env = new TestEnvironment({ platform: "linux" });
      env.writeFile(path.join(homeDir, ".config/dprint/dprint.json"), "{}");

      assert.strictEqual(await findGlobalConfigFile(env), undefined);
    });
  });

  describe("macos", () => {
    it("uses XDG_CONFIG_HOME", async () => {
      const xdgConfigHome = path.resolve("/xdg");
      const env = new TestEnvironment({ platform: "darwin", homeDir, envVars: { XDG_CONFIG_HOME: xdgConfigHome } });
      const configPath = path.join(xdgConfigHome, "dprint/dprint.json");
      env.writeFile(configPath, "{}");

      assert.strictEqual(await findGlobalConfigFile(env), configPath);
    });

    it("uses the system config directory when it has a dprint directory", async () => {
      const env = new TestEnvironment({ platform: "darwin", homeDir });
      env.writeFile(path.join(homeDir, ".config/dprint/dprint.json"), "{}");
      const configPath = path.join(homeDir, "Library/Application Support/dprint/dprint.json");
      env.writeFile(configPath, "{}");

      assert.strictEqual(await findGlobalConfigFile(env), configPath);
    });

    it("falls back to ~/.config", async () => {
      const env = new TestEnvironment({ platform: "darwin", homeDir });
      const configPath = path.join(homeDir, ".config/dprint/dprint.json");
      env.writeFile(configPath, "{}");

      assert.strictEqual(await findGlobalConfigFile(env), configPath);
    });

    it("uses a relative XDG_CONFIG_HOME unlike linux", async () => {
      const env = new TestEnvironment({ platform: "darwin", homeDir, envVars: { XDG_CONFIG_HOME: "xdg" } });
      const configPath = path.join("xdg", "dprint/dprint.json");
      env.writeFile(configPath, "{}");

      assert.strictEqual(await findGlobalConfigFile(env), configPath);
    });

    it("returns undefined without a home directory", async () => {
      const env = new TestEnvironment({ platform: "darwin" });
      env.writeFile(path.join(homeDir, ".config/dprint/dprint.json"), "{}");

      assert.strictEqual(await findGlobalConfigFile(env), undefined);
    });
  });

  describe("windows", () => {
    it("uses APPDATA", async () => {
      const appData = path.resolve("/Users/user/AppData/Roaming");
      const env = new TestEnvironment({ platform: "win32", homeDir, envVars: { APPDATA: appData } });
      const configPath = path.join(appData, "dprint/dprint.json");
      env.writeFile(configPath, "{}");

      assert.strictEqual(await findGlobalConfigFile(env), configPath);
    });

    it("prefers DPRINT_CONFIG_DIR over APPDATA", async () => {
      const appData = path.resolve("/Users/user/AppData/Roaming");
      const configDir = path.resolve("/custom/config");
      const env = new TestEnvironment({
        platform: "win32",
        envVars: { APPDATA: appData, DPRINT_CONFIG_DIR: configDir },
      });
      env.writeFile(path.join(appData, "dprint/dprint.json"), "{}");
      const configPath = path.join(configDir, "dprint.json");
      env.writeFile(configPath, "{}");

      assert.strictEqual(await findGlobalConfigFile(env), configPath);
    });

    it("ignores XDG_CONFIG_HOME", async () => {
      const xdgConfigHome = path.resolve("/xdg");
      const env = new TestEnvironment({ platform: "win32", homeDir, envVars: { XDG_CONFIG_HOME: xdgConfigHome } });
      env.writeFile(path.join(xdgConfigHome, "dprint/dprint.json"), "{}");

      assert.strictEqual(await findGlobalConfigFile(env), undefined);
    });

    it("returns undefined without APPDATA", async () => {
      const env = new TestEnvironment({ platform: "win32", homeDir });
      env.writeFile(path.join(homeDir, ".config/dprint/dprint.json"), "{}");

      assert.strictEqual(await findGlobalConfigFile(env), undefined);
    });
  });
});
