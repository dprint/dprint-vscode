import * as assert from "node:assert";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  AncestorConfigFileCache,
  filterCacheDirConfigFiles,
  filterUnusedConfigFiles,
  findClosestFolder,
  findConfigFileInAncestorDirectories,
  findWorkspaceFolderAncestorConfigFile,
  getConfigFileDir,
  isPathWithin,
} from "./configPaths";
import type { Environment } from "./environment";
import { TestEnvironment } from "./TestEnvironment";

const homeDir = path.resolve("/home/user");
const rootDir = path.parse(path.resolve("/")).root;

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

  it("returns undefined when the folder has a config file in its .config directory", async () => {
    const env = new TestEnvironment({ homeDir });
    env.writeFile(path.resolve("/dprint.json"), "{}");

    const folderPath = path.resolve("/project");
    const folderConfigPath = path.resolve("/project/.config/dprint.json");
    assert.strictEqual(await findWorkspaceFolderAncestorConfigFile(env, folderPath, [folderConfigPath]), undefined);
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

  it("returns undefined when the folder has a config file in a .config directory", async () => {
    const env = new TestEnvironment();
    env.writeFile(path.resolve("/project/dprint.json"), "{}");
    const folderConfigPath = path.resolve("/project/packages/app/.config/dprint.json");
    env.writeFile(folderConfigPath, "{}");

    assert.strictEqual(await findWorkspaceFolderAncestorConfigFile(env, folderPath, [folderConfigPath]), undefined);
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

  it("finds a config file in the .config directory", async () => {
    const env = new TestEnvironment({ homeDir });
    env.writeFile(path.resolve("/dprint.json"), "{}");
    const configPath = path.resolve("/project/.config/dprint.jsonc");
    env.writeFile(configPath, "{}");

    assert.strictEqual(await findConfigFileInAncestorDirectories(env, path.resolve("/project/src")), configPath);
    // the .config directory is searched as part of its parent directory
    assert.strictEqual(await findConfigFileInAncestorDirectories(env, path.resolve("/project/.config")), configPath);
    assert.strictEqual(
      await findConfigFileInAncestorDirectories(env, path.resolve("/project/.config/sub")),
      configPath,
    );
  });

  it("prefers a config file in the directory over one in its .config directory", async () => {
    const env = new TestEnvironment({ homeDir });
    env.writeFile(path.resolve("/project/.config/dprint.json"), "{}");
    const configPath = path.resolve("/project/.dprint.jsonc");
    env.writeFile(configPath, "{}");

    assert.strictEqual(await findConfigFileInAncestorDirectories(env, path.resolve("/project")), configPath);
    assert.strictEqual(await findConfigFileInAncestorDirectories(env, path.resolve("/project/.config")), configPath);
  });

  it("only finds the cli's config file names in the .config directory", async () => {
    const env = new TestEnvironment({ homeDir });
    env.writeFile(path.resolve("/project/.config/.dprint.json"), "{}");

    assert.strictEqual(await findConfigFileInAncestorDirectories(env, path.resolve("/project/.config")), undefined);
  });

  it("treats the home directory's .config directory as an ordinary directory", async () => {
    const env = new TestEnvironment({ homeDir });
    const configPath = path.join(homeDir, ".config/dprint.json");
    env.writeFile(configPath, "{}");

    assert.strictEqual(await findConfigFileInAncestorDirectories(env, path.join(homeDir, "project")), undefined);
    assert.strictEqual(await findConfigFileInAncestorDirectories(env, path.join(homeDir, ".config")), configPath);
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

  it("finds a symlinked config file without following it", async () => {
    const env = new TestEnvironment();
    // ex. a symlink to a file on another machine, which is found though what it points to isn't read
    const configPath = path.resolve("/project/dprint.json");
    env.symlink(path.resolve("/other-machine/dprint.json"), configPath);

    assert.strictEqual(await findConfigFileInAncestorDirectories(env, path.resolve("/project/src")), configPath);
  });

  it("doesn't look in a symlinked .config directory", async () => {
    const env = new TestEnvironment();
    env.writeFile(path.resolve("/other-machine/dprint.json"), "{}");
    env.symlink(path.resolve("/other-machine"), path.resolve("/project/.config"));

    assert.strictEqual(await findConfigFileInAncestorDirectories(env, path.resolve("/project/src")), undefined);
  });

  it("finds a symlink that points to nothing without following it", async () => {
    const env = new TestEnvironment();
    const configPath = path.resolve("/project/dprint.json");
    env.writeFile(path.resolve("/dprint.json"), "{}");
    env.symlink(path.resolve("/deleted/dprint.json"), configPath);

    assert.strictEqual(await findConfigFileInAncestorDirectories(env, path.resolve("/project/src")), configPath);
  });

  it("finds a config file like the CLI when following symlinks", async () => {
    const env = new TestEnvironment();
    // ex. for an older dprint, which reads it anyway
    env.writeFile(path.resolve("/shared/dprint.json"), "{}");
    env.symlink(path.resolve("/shared"), path.resolve("/project/.config"));
    const options = { followSymlinks: true };
    assert.strictEqual(
      await findConfigFileInAncestorDirectories(env, path.resolve("/project/src"), options),
      path.resolve("/project/.config/dprint.json"),
    );
    // and looks further up instead of using a symlink that points to nothing
    const rootConfigPath = path.resolve("/dprint.json");
    env.writeFile(rootConfigPath, "{}");
    env.symlink(path.resolve("/deleted/dprint.json"), path.resolve("/other/dprint.json"));
    assert.strictEqual(
      await findConfigFileInAncestorDirectories(env, path.resolve("/other/src"), options),
      rootConfigPath,
    );
  });
});

describe("AncestorConfigFileCache", () => {
  function setup() {
    const env = new TestEnvironment({ homeDir });
    const checkedPaths: string[] = [];
    // only the path checks and home directory are used
    const countingEnv = {
      pathKind(filePath: string) {
        checkedPaths.push(filePath);
        return env.pathKind(filePath);
      },
      homeDir() {
        return env.homeDir();
      },
    } as unknown as Environment;
    return { env, checkedPaths, cache: new AncestorConfigFileCache(countingEnv) };
  }

  it("finds the config file in the closest ancestor directory", async () => {
    const { env, cache } = setup();
    env.writeFile(path.resolve("/project/dprint.json"), "{}");
    env.writeFile(path.resolve("/project/sub/.dprint.jsonc"), "{}");

    assert.strictEqual(await cache.find(path.resolve("/project/src")), path.resolve("/project/dprint.json"));
    assert.strictEqual(await cache.find(path.resolve("/project")), path.resolve("/project/dprint.json"));
    assert.strictEqual(await cache.find(path.resolve("/project/sub/dir")), path.resolve("/project/sub/.dprint.jsonc"));
    assert.strictEqual(await cache.find(path.resolve("/other/dir")), undefined);
  });

  it("finds the config file in a .config directory", async () => {
    const { env, cache } = setup();
    env.writeFile(path.resolve("/project/dprint.json"), "{}");
    const configPath = path.resolve("/project/sub/.config/dprint.json");
    env.writeFile(configPath, "{}");

    assert.strictEqual(await cache.find(path.resolve("/project/sub/dir")), configPath);
    assert.strictEqual(await cache.find(path.resolve("/project/sub/.config")), configPath);
    assert.strictEqual(await cache.find(path.resolve("/project/src")), path.resolve("/project/dprint.json"));
  });

  it("does not check the file system again for directories it already looked in", async () => {
    const { env, checkedPaths, cache } = setup();
    env.writeFile(path.resolve("/project/dprint.json"), "{}");

    await cache.find(path.resolve("/project/src/a"));
    assert.ok(checkedPaths.length > 0);
    checkedPaths.length = 0;

    // same directory
    assert.strictEqual(await cache.find(path.resolve("/project/src/a")), path.resolve("/project/dprint.json"));
    assert.deepStrictEqual(checkedPaths, []);

    // a sibling directory only checks itself
    assert.strictEqual(await cache.find(path.resolve("/project/src/b")), path.resolve("/project/dprint.json"));
    assert.ok(checkedPaths.length > 0);
    assert.ok(checkedPaths.every(checkedPath => path.dirname(checkedPath) === path.resolve("/project/src/b")));
  });

  it("checks the file system again after being cleared", async () => {
    const { env, cache } = setup();
    assert.strictEqual(await cache.find(path.resolve("/project/src")), undefined);

    env.writeFile(path.resolve("/project/dprint.json"), "{}");
    assert.strictEqual(await cache.find(path.resolve("/project/src")), undefined);

    cache.clear();
    assert.strictEqual(await cache.find(path.resolve("/project/src")), path.resolve("/project/dprint.json"));
  });

  it("finds a config file through symlinks when following them", async () => {
    // ex. for an older dprint, which reads it anyway
    const env = new TestEnvironment({ homeDir });
    const rootConfigPath = path.resolve("/dprint.json");
    env.writeFile(rootConfigPath, "{}");
    env.symlink(path.resolve("/deleted/dprint.json"), path.resolve("/project/dprint.json"));

    const following = new AncestorConfigFileCache(env, { followSymlinks: true });
    assert.strictEqual(await following.find(path.resolve("/project/src")), rootConfigPath);
    const notFollowing = new AncestorConfigFileCache(env);
    assert.strictEqual(await notFollowing.find(path.resolve("/project/src")), path.resolve("/project/dprint.json"));
  });
});

describe("getConfigFileDir", () => {
  const env = new TestEnvironment({ homeDir });

  it("gets the config file's directory", () => {
    assert.strictEqual(getConfigFileDir(env, path.resolve("/project/dprint.json")), path.resolve("/project"));
  });

  it("gets the parent of the .config directory for a config file in one", () => {
    assert.strictEqual(getConfigFileDir(env, path.resolve("/project/.config/dprint.json")), path.resolve("/project"));
    assert.strictEqual(getConfigFileDir(env, path.resolve("/project/.config/dprint.jsonc")), path.resolve("/project"));
  });

  it("gets the .config directory for a config file name the cli doesn't search for in one", () => {
    assert.strictEqual(
      getConfigFileDir(env, path.resolve("/project/.config/.dprint.json")),
      path.resolve("/project/.config"),
    );
  });

  it("gets the home directory's .config directory for a config file in it", () => {
    assert.strictEqual(getConfigFileDir(env, path.join(homeDir, ".config/dprint.json")), path.join(homeDir, ".config"));
  });
});

describe("filterUnusedConfigFiles", () => {
  const env = new TestEnvironment({ homeDir });

  it("keeps the config files the cli uses", () => {
    const configPaths = [
      path.resolve("/project/dprint.json"),
      path.resolve("/project/sub/.config/dprint.jsonc"),
      path.join(homeDir, ".config/dprint.json"),
    ];
    assert.deepStrictEqual(filterUnusedConfigFiles(env, configPaths), configPaths);
  });

  it("removes the config files with a lower precedence for the same directory", () => {
    const configPath = path.resolve("/project/.dprint.json");
    assert.deepStrictEqual(
      filterUnusedConfigFiles(env, [
        path.resolve("/project/.config/dprint.json"),
        configPath,
        path.resolve("/project/.config/dprint.jsonc"),
      ]),
      [configPath],
    );
    const dotConfigPath = path.resolve("/project/.config/dprint.json");
    assert.deepStrictEqual(
      filterUnusedConfigFiles(env, [path.resolve("/project/.config/dprint.jsonc"), dotConfigPath]),
      [dotConfigPath],
    );
  });

  it("removes the config file names the cli doesn't search for in a .config directory", () => {
    assert.deepStrictEqual(filterUnusedConfigFiles(env, [path.resolve("/project/.config/.dprint.json")]), []);
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
