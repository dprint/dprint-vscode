import * as assert from "node:assert";
import * as path from "node:path";
import { describe, it } from "node:test";
import { TestEnvironment } from "../TestEnvironment";
import { type NpmLogger, tryResolveNpmExecutable } from "./npm";

const projectDir = path.resolve("/project");

describe("tryResolveNpmExecutable", () => {
  it("resolves a hoisted platform package", async () => {
    const env = new TestEnvironment();
    const exePath = writePlatformPackage(env, path.join(projectDir, "node_modules/@dprint/linux-x64-glibc"), "1.0.0");

    assert.strictEqual(await tryResolveNpmExecutable(projectDir, env, createLogger()), exePath);
  });

  it("resolves the platform package for the linux family", async () => {
    const env = new TestEnvironment({ arch: "arm64", linuxFamily: "musl" });
    writePlatformPackage(env, path.join(projectDir, "node_modules/@dprint/linux-arm64-glibc"), "1.0.0");
    const exePath = writePlatformPackage(env, path.join(projectDir, "node_modules/@dprint/linux-arm64-musl"), "1.0.0");

    assert.strictEqual(await tryResolveNpmExecutable(projectDir, env, createLogger()), exePath);
  });

  it("resolves a hoisted platform package in an ancestor directory", async () => {
    const env = new TestEnvironment();
    const exePath = writePlatformPackage(env, path.join(projectDir, "node_modules/@dprint/linux-x64-glibc"), "1.0.0");

    const subDir = path.join(projectDir, "packages/sub");
    assert.strictEqual(await tryResolveNpmExecutable(subDir, env, createLogger()), exePath);
  });

  it("prefers the platform package in the closest node_modules folder", async () => {
    const env = new TestEnvironment();
    writePlatformPackage(env, path.join(projectDir, "node_modules/@dprint/linux-x64-glibc"), "1.0.0");
    const subDir = path.join(projectDir, "packages/sub");
    const exePath = writePlatformPackage(env, path.join(subDir, "node_modules/@dprint/linux-x64-glibc"), "1.1.0");

    assert.strictEqual(await tryResolveNpmExecutable(subDir, env, createLogger()), exePath);
  });

  it("resolves a platform package nested in the dprint package", async () => {
    const env = new TestEnvironment();
    const exePath = writePlatformPackage(
      env,
      path.join(projectDir, "node_modules/dprint/node_modules/@dprint/linux-x64-glibc"),
      "1.0.0",
    );

    assert.strictEqual(await tryResolveNpmExecutable(projectDir, env, createLogger()), exePath);
  });

  it("resolves a platform package beside a symlinked dprint package (pnpm)", async () => {
    const env = new TestEnvironment();
    const exePath = writePnpmLayout(env, "linux-x64-glibc", "1.2.0");

    assert.strictEqual(await tryResolveNpmExecutable(projectDir, env, createLogger()), exePath);
  });

  it("prefers the hoisted platform package over the dprint package's", async () => {
    const env = new TestEnvironment();
    const exePath = writePlatformPackage(env, path.join(projectDir, "node_modules/@dprint/linux-x64-glibc"), "1.0.0");
    writePlatformPackage(
      env,
      path.join(projectDir, "node_modules/dprint/node_modules/@dprint/linux-x64-glibc"),
      "1.1.0",
    );

    assert.strictEqual(await tryResolveNpmExecutable(projectDir, env, createLogger()), exePath);
  });

  it("returns undefined when the dprint package has no platform package", async () => {
    const env = new TestEnvironment();
    env.writeFile(path.join(projectDir, "node_modules/dprint/package.json"), "{}");

    assert.strictEqual(await tryResolveNpmExecutable(projectDir, env, createLogger()), undefined);
  });

  it("skips a platform package with an invalid package.json", async () => {
    const env = new TestEnvironment();
    const packageDir = path.join(projectDir, "node_modules/@dprint/linux-x64-glibc");
    env.writeFile(path.join(packageDir, "dprint"), "");
    env.writeFile(path.join(packageDir, "package.json"), "{");
    const logger = createLogger();

    assert.strictEqual(await tryResolveNpmExecutable(projectDir, env, logger), undefined);
    assert.deepStrictEqual(logger.warnings, ["Failed resolving package.json"]);
  });

  it("copies the executable to the temp directory on windows", async () => {
    const tmpDir = path.resolve("/tmp");
    const env = new TestEnvironment({ platform: "win32", tmpdir: tmpDir });
    const exePath = writePnpmLayout(env, "win32-x64", "1.2.0");

    const tempExePath = path.join(tmpDir, "dprint", "win32-x64-1.2.0.exe");
    assert.strictEqual(await tryResolveNpmExecutable(projectDir, env, createLogger()), tempExePath);
    assert.strictEqual(env.readTextFileSync(tempExePath), env.readTextFileSync(exePath));
  });

  it("resolves the temp executable for every concurrent caller on windows", async () => {
    const tmpDir = path.resolve("/tmp");
    const env = new RunningExeTestEnvironment({ platform: "win32", tmpdir: tmpDir });
    writePnpmLayout(env, "win32-x64", "1.2.0");
    const subDir = path.join(projectDir, "packages/sub");

    const tempExePath = path.join(tmpDir, "dprint", "win32-x64-1.2.0.exe");
    const results = await Promise.all([
      tryResolveNpmExecutable(projectDir, env, createLogger()),
      tryResolveNpmExecutable(subDir, env, createLogger()),
      tryResolveNpmExecutable(projectDir, env, createLogger()),
    ]);
    assert.deepStrictEqual(results, [tempExePath, tempExePath, tempExePath]);
    assert.strictEqual(env.copyCount, 1);

    // the in-flight copy is forgotten once it finishes
    assert.strictEqual(await tryResolveNpmExecutable(projectDir, env, createLogger()), tempExePath);
    assert.strictEqual(env.copyCount, 1);
  });

  it("resolves the temp executable when the copy fails because another process created it", async () => {
    const tmpDir = path.resolve("/tmp");
    const tempExePath = path.join(tmpDir, "dprint", "win32-x64-1.2.0.exe");
    const env = new (class extends TestEnvironment {
      override async atomicCopyFile(from: string, to: string) {
        // another window finishes its copy and starts running the executable
        await super.atomicCopyFile(from, to);
        throw new Error("EPERM: operation not permitted");
      }
    })({ platform: "win32", tmpdir: tmpDir });
    const exePath = writePnpmLayout(env, "win32-x64", "1.2.0");

    assert.strictEqual(await tryResolveNpmExecutable(projectDir, env, createLogger()), tempExePath);
    assert.strictEqual(env.readTextFileSync(tempExePath), env.readTextFileSync(exePath));
  });

  it("returns undefined when the copy fails and the temp executable does not exist", async () => {
    const env = new (class extends TestEnvironment {
      override atomicCopyFile(): Promise<void> {
        return Promise.reject(new Error("ENOSPC: no space left on device"));
      }
    })({ platform: "win32" });
    writePnpmLayout(env, "win32-x64", "1.2.0");
    const errors: string[] = [];
    const logger: NpmLogger = { ...createLogger(), logError: message => errors.push(message) };

    assert.strictEqual(await tryResolveNpmExecutable(projectDir, env, logger), undefined);
    assert.deepStrictEqual(errors, ["Error resolving npm executable"]);

    // a failed copy is not remembered
    assert.strictEqual(await tryResolveNpmExecutable(projectDir, env, logger), undefined);
    assert.strictEqual(errors.length, 2);
  });

  it("does not copy the executable on windows when the file system is not writable", async () => {
    const env = new TestEnvironment({ platform: "win32", isWritableFileSystem: false });
    const exePath = writePnpmLayout(env, "win32-x64", "1.2.0");

    assert.strictEqual(await tryResolveNpmExecutable(projectDir, env, createLogger()), exePath);
  });
});

/** Fails a copy over an existing file like Windows does when the target executable is running. */
class RunningExeTestEnvironment extends TestEnvironment {
  copyCount = 0;

  override async atomicCopyFile(from: string, to: string) {
    this.copyCount++;
    // copying the executable takes a while, which lets the other callers get this far
    await new Promise(resolve => setImmediate(resolve));
    if (await this.fileExists(to)) {
      throw new Error("EPERM: operation not permitted");
    }
    await super.atomicCopyFile(from, to);
  }
}

function writePnpmLayout(env: TestEnvironment, packageName: string, version: string) {
  const storeNodeModulesDir = path.join(projectDir, `node_modules/.pnpm/dprint@${version}/node_modules`);
  env.writeFile(path.join(storeNodeModulesDir, "dprint/package.json"), JSON.stringify({ version }));
  env.symlink(path.join(storeNodeModulesDir, "dprint"), path.join(projectDir, "node_modules/dprint"));
  return writePlatformPackage(env, path.join(storeNodeModulesDir, "@dprint", packageName), version);
}

function writePlatformPackage(env: TestEnvironment, packageDir: string, version: string) {
  const exePath = path.join(packageDir, env.platform() === "win32" ? "dprint.exe" : "dprint");
  env.writeFile(exePath, `dprint ${version} executable`);
  env.writeFile(path.join(packageDir, "package.json"), JSON.stringify({ version }));
  return exePath;
}

function createLogger(): NpmLogger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    logDebug() {},
    logWarn(message) {
      warnings.push(message);
    },
    logError(message, ...args) {
      throw new Error(`Unexpected error logged: ${message} ${args.join(" ")}`);
    },
  };
}
