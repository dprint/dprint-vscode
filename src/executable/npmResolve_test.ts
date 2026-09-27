import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type NpmResolveOptions, tryResolveInNodeModules } from "./npmResolve";

// use names that won't match any real package installed in an ancestor of the temp directory
const packageName = "dprint-vscode-test-platform";
const exeName = "dprint-test-exe";

describe("tryResolveInNodeModules", () => {
  let tempDir: string;

  beforeEach(() => {
    // resolve the real path so that it matches paths returned by realpath (ex. 8.3 names on windows)
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dprint-vscode-npm-")));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves a hoisted platform package", async () => {
    const packageDir = createPlatformPackage(path.join(tempDir, "node_modules", "@dprint", packageName), "1.0.0");

    const exec = await tryResolveInNodeModules(tempDir, createOptions());

    assert.deepStrictEqual(exec, { version: "1.0.0", path: path.join(packageDir, exeName) });
  });

  it("resolves a hoisted platform package in an ancestor directory", async () => {
    const packageDir = createPlatformPackage(path.join(tempDir, "node_modules", "@dprint", packageName), "1.0.0");
    const subDir = path.join(tempDir, "packages", "sub");
    fs.mkdirSync(subDir, { recursive: true });

    const exec = await tryResolveInNodeModules(subDir, createOptions());

    assert.deepStrictEqual(exec, { version: "1.0.0", path: path.join(packageDir, exeName) });
  });

  it("resolves a platform package nested in the dprint package", async () => {
    const dprintPackageDir = path.join(tempDir, "node_modules", "dprint");
    const packageDir = createPlatformPackage(
      path.join(dprintPackageDir, "node_modules", "@dprint", packageName),
      "1.1.0",
    );

    const exec = await tryResolveInNodeModules(tempDir, createOptions());

    assert.deepStrictEqual(exec, { version: "1.1.0", path: path.join(packageDir, exeName) });
  });

  it("resolves a platform package beside a symlinked dprint package (pnpm)", async () => {
    const storeNodeModulesDir = path.join(tempDir, "node_modules", ".pnpm", "dprint@1.2.0", "node_modules");
    const storeDprintPackageDir = path.join(storeNodeModulesDir, "dprint");
    fs.mkdirSync(storeDprintPackageDir, { recursive: true });
    const packageDir = createPlatformPackage(path.join(storeNodeModulesDir, "@dprint", packageName), "1.2.0");
    fs.symlinkSync(storeDprintPackageDir, path.join(tempDir, "node_modules", "dprint"), "junction");

    const exec = await tryResolveInNodeModules(tempDir, createOptions());

    assert.deepStrictEqual(exec, { version: "1.2.0", path: path.join(packageDir, exeName) });
  });

  it("prefers the hoisted platform package over the dprint package's", async () => {
    const hoistedPackageDir = createPlatformPackage(
      path.join(tempDir, "node_modules", "@dprint", packageName),
      "1.0.0",
    );
    createPlatformPackage(
      path.join(tempDir, "node_modules", "dprint", "node_modules", "@dprint", packageName),
      "1.1.0",
    );

    const exec = await tryResolveInNodeModules(tempDir, createOptions());

    assert.deepStrictEqual(exec, { version: "1.0.0", path: path.join(hoistedPackageDir, exeName) });
  });

  it("returns undefined when the dprint package has no platform package", async () => {
    fs.mkdirSync(path.join(tempDir, "node_modules", "dprint"), { recursive: true });

    const exec = await tryResolveInNodeModules(tempDir, createOptions());

    assert.strictEqual(exec, undefined);
  });

  it("skips a platform package with an invalid package.json", async () => {
    const packageDir = path.join(tempDir, "node_modules", "@dprint", packageName);
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, exeName), "");
    fs.writeFileSync(path.join(packageDir, "package.json"), "{");
    const warnings: string[] = [];

    const exec = await tryResolveInNodeModules(tempDir, createOptions({ warnings }));

    assert.strictEqual(exec, undefined);
    assert.strictEqual(warnings.length, 1);
  });
});

function createPlatformPackage(packageDir: string, version: string) {
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, exeName), "");
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ version }));
  return packageDir;
}

function createOptions(opts: { warnings?: string[] } = {}): NpmResolveOptions {
  return {
    packageName,
    exeName,
    fs: {
      async fileExists(p) {
        return fs.existsSync(p);
      },
      async readTextFile(p) {
        try {
          return await fs.promises.readFile(p, "utf8");
        } catch {
          return undefined;
        }
      },
      async realPath(p) {
        try {
          return await fs.promises.realpath(p);
        } catch {
          return undefined;
        }
      },
    },
    logger: {
      logDebug() {},
      logWarn(message) {
        opts.warnings?.push(message);
      },
    },
  };
}
