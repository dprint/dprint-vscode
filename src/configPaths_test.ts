import * as assert from "node:assert";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  findConfigFileInAncestorDirectories,
  findGlobalConfigFile,
  isPathWithin,
  resolveLooseFolderCwd,
} from "./configPaths";
import { TestEnvironment } from "./TestEnvironment";

const homeDir = path.resolve("/home/user");
const rootDir = path.parse(path.resolve("/")).root;

describe("resolveLooseFolderCwd", () => {
  it("uses the directory of the closest ancestor config file", async () => {
    const env = new TestEnvironment({ homeDir });
    env.writeFile(path.join(homeDir, ".config/dprint/dprint.json"), "{}");
    env.writeFile(path.resolve("/project/dprint.json"), "{}");

    const filePath = path.resolve("/project/src/file.ts");
    assert.strictEqual(await resolveLooseFolderCwd(env, filePath), path.resolve("/project"));
  });

  it("uses the file system root when there's only a global config file", async () => {
    const env = new TestEnvironment({ homeDir });
    env.writeFile(path.join(homeDir, ".config/dprint/dprint.json"), "{}");

    assert.strictEqual(await resolveLooseFolderCwd(env, path.resolve("/project/src/file.ts")), rootDir);
  });

  it("returns undefined when there's no config file", async () => {
    const env = new TestEnvironment({ homeDir });

    assert.strictEqual(await resolveLooseFolderCwd(env, path.resolve("/project/src/file.ts")), undefined);
  });
});

describe("findConfigFileInAncestorDirectories", () => {
  it("finds a config file in the directory", async () => {
    const env = new TestEnvironment();
    const configPath = path.resolve("/project/dprint.json");
    env.writeFile(configPath, "{}");

    assert.strictEqual(await findConfigFileInAncestorDirectories(env, path.resolve("/project")), configPath);
  });

  it("finds the closest config file in an ancestor directory", async () => {
    const env = new TestEnvironment();
    env.writeFile(path.resolve("/dprint.json"), "{}");
    const configPath = path.resolve("/project/.dprint.jsonc");
    env.writeFile(configPath, "{}");

    const dirPath = path.resolve("/project/src/sub");
    assert.strictEqual(await findConfigFileInAncestorDirectories(env, dirPath), configPath);
  });

  it("prefers config file names in the same order as the cli", async () => {
    const env = new TestEnvironment();
    env.writeFile(path.resolve("/project/.dprint.json"), "{}");
    const configPath = path.resolve("/project/dprint.jsonc");
    env.writeFile(configPath, "{}");

    assert.strictEqual(await findConfigFileInAncestorDirectories(env, path.resolve("/project")), configPath);
  });

  it("finds a config file at the file system root", async () => {
    const env = new TestEnvironment();
    const configPath = path.join(rootDir, "dprint.json");
    env.writeFile(configPath, "{}");

    assert.strictEqual(await findConfigFileInAncestorDirectories(env, path.resolve("/project/src")), configPath);
  });

  it("returns undefined when there's no config file", async () => {
    const env = new TestEnvironment();

    assert.strictEqual(await findConfigFileInAncestorDirectories(env, path.resolve("/project/src")), undefined);
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

describe("isPathWithin", () => {
  it("includes the same path and descendants", () => {
    assert.strictEqual(isPathWithin(path.resolve("/a/b"), path.resolve("/a/b")), true);
    assert.strictEqual(isPathWithin(path.resolve("/a/b"), path.resolve("/a/b/c.ts")), true);
  });

  it("excludes siblings that share a prefix", () => {
    assert.strictEqual(isPathWithin(path.resolve("/a/b"), path.resolve("/a/bc/d.ts")), false);
  });

  it("excludes ancestors and other paths", () => {
    assert.strictEqual(isPathWithin(path.resolve("/a/b"), path.resolve("/a")), false);
    assert.strictEqual(isPathWithin(path.resolve("/a/b"), path.resolve("/c/d")), false);
  });

  it("includes descendants whose name starts with two dots", () => {
    assert.strictEqual(isPathWithin(path.resolve("/a"), path.resolve("/a/..b/c.ts")), true);
  });
});
