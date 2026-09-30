import * as assert from "node:assert";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  filterCacheDirConfigFiles,
  findClosestFolder,
  findConfigFileInAncestorDirectories,
  findGlobalConfigFile,
  findWorkspaceFolderAncestorConfigFile,
  isPathWithin,
  resolveLooseFolderConfig,
} from "./configPaths";
import { TestEnvironment } from "./TestEnvironment";

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

describe("findWorkspaceFolderAncestorConfigFile", () => {
  const folderPath = path.resolve("/project/packages/app");

  it("finds the config file of an ancestor directory when opening a descendant directory", async () => {
    const env = new TestEnvironment();
    env.writeFile(path.resolve("/dprint.json"), "{}");
    const configPath = path.resolve("/project/dprint.json");
    env.writeFile(configPath, "{}");

    assert.strictEqual(await findWorkspaceFolderAncestorConfigFile(env, folderPath, []), configPath);
  });

  it("finds the config file of an ancestor directory when only descendants of the folder have config files", async () => {
    const env = new TestEnvironment();
    const configPath = path.resolve("/project/dprint.json");
    env.writeFile(configPath, "{}");
    const subConfigPath = path.resolve("/project/packages/app/sub/dprint.json");
    env.writeFile(subConfigPath, "{}");

    assert.strictEqual(await findWorkspaceFolderAncestorConfigFile(env, folderPath, [subConfigPath]), configPath);
  });

  it("returns undefined when the folder has a config file", async () => {
    const env = new TestEnvironment();
    env.writeFile(path.resolve("/project/dprint.json"), "{}");
    const folderConfigPath = path.resolve("/project/packages/app/dprint.json");
    env.writeFile(folderConfigPath, "{}");

    assert.strictEqual(await findWorkspaceFolderAncestorConfigFile(env, folderPath, [folderConfigPath]), undefined);
    // the folder path might have a trailing separator
    assert.strictEqual(
      await findWorkspaceFolderAncestorConfigFile(env, folderPath + path.sep, [folderConfigPath]),
      undefined,
    );
  });

  it("returns undefined when there's no config file in an ancestor directory", async () => {
    const env = new TestEnvironment();
    const subConfigPath = path.resolve("/project/packages/app/sub/dprint.json");
    env.writeFile(subConfigPath, "{}");

    assert.strictEqual(await findWorkspaceFolderAncestorConfigFile(env, folderPath, [subConfigPath]), undefined);
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

describe("filterCacheDirConfigFiles", () => {
  const folderPath = path.resolve("/project");
  const rootConfig = path.resolve("/project/dprint.json");
  const packageConfig = path.resolve("/project/target/package/crate-0.1.0/dprint.json");

  it("removes config files in a descendant cache directory", async () => {
    const env = new TestEnvironment({ homeDir });
    env.writeFile(path.resolve("/project/target/CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55");
    const subConfig = path.resolve("/project/sub/dprint.json");

    assert.deepStrictEqual(
      await filterCacheDirConfigFiles(env, folderPath, [rootConfig, packageConfig, subConfig]),
      [rootConfig, subConfig],
    );
  });

  it("removes a config file directly in a cache directory", async () => {
    const env = new TestEnvironment({ homeDir });
    env.writeFile(path.resolve("/project/cache/CACHEDIR.TAG"), "");
    const cacheConfig = path.resolve("/project/cache/dprint.json");

    assert.deepStrictEqual(await filterCacheDirConfigFiles(env, folderPath, [rootConfig, cacheConfig]), [rootConfig]);
  });

  it("keeps config files when the folder or its ancestors are cache directories", async () => {
    const env = new TestEnvironment({ homeDir });
    env.writeFile(path.resolve("/CACHEDIR.TAG"), "");
    env.writeFile(path.resolve("/project/CACHEDIR.TAG"), "");

    assert.deepStrictEqual(
      await filterCacheDirConfigFiles(env, folderPath, [rootConfig, packageConfig]),
      [rootConfig, packageConfig],
    );
  });
});

describe("findClosestFolder", () => {
  const folders = [
    { name: "root", path: path.resolve("/a") },
    { name: "nested", path: path.resolve("/a/b") },
    { name: "sibling", path: path.resolve("/a/bc") },
  ];
  const find = (filePath: string, items = folders) => findClosestFolder(items, f => f.path, filePath)?.name;

  it("finds the most nested folder containing the file", () => {
    assert.strictEqual(find(path.resolve("/a/b/c/file.ts")), "nested");
    assert.strictEqual(find(path.resolve("/a/file.ts")), "root");
  });

  it("does not match a sibling folder that shares a prefix", () => {
    assert.strictEqual(find(path.resolve("/a/bc/file.ts")), "sibling");
    assert.strictEqual(find(path.resolve("/a/bcd/file.ts")), "root");
  });

  it("finds the most nested folder regardless of order", () => {
    assert.strictEqual(find(path.resolve("/a/b/file.ts"), [...folders].reverse()), "nested");
  });

  it("uses the last folder when multiple have the same path", () => {
    const duplicates = [{ name: "first", path: path.resolve("/a") }, { name: "second", path: path.resolve("/a") }];
    assert.strictEqual(find(path.resolve("/a/file.ts"), duplicates), "second");
  });

  it("returns undefined when no folder contains the file", () => {
    assert.strictEqual(find(path.resolve("/other/file.ts")), undefined);
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
