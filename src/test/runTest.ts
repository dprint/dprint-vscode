import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as process from "node:process";

import { runTests } from "@vscode/test-electron";

async function main() {
  // The folder containing the Extension Manifest package.json
  // Passed to `--extensionDevelopmentPath`
  const extensionDevelopmentPath = path.resolve(__dirname, "../../");

  // The path to test runner
  // Passed to --extensionTestsPath
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");

  // The workspace folder is created here and opened when launching vscode because
  // opening a folder from a test restarts the extension host, which ends the test run.
  // It's outside the repo so that the repo's dprint config file isn't used.
  const workspaceDir = createWorkspaceDir();
  // for formatting a file that has no config file using the global config file
  const globalConfigDir = createGlobalConfigDir();
  const noConfigDir = createTempDir();
  let exitCode = 0;
  try {
    // Download VS Code, unzip it and run the integration test
    await runTests({
      // use an existing vscode install instead of downloading the latest stable version
      vscodeExecutablePath: process.env.DPRINT_TEST_VSCODE_EXECUTABLE || undefined,
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv: {
        // the tests get the path of the workspace folder from this
        DPRINT_TEST_WORKSPACE_DIR: workspaceDir,
        DPRINT_TEST_NO_CONFIG_DIR: noConfigDir,
        // the extension and the dprint cli it starts find the global config file with this
        DPRINT_CONFIG_DIR: globalConfigDir,
      },
      launchArgs: [
        workspaceDir,
        "--disable-extensions",
        // the window doesn't become responsive on a headless Linux machine (ex. CI) without these
        ...(process.platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : []),
      ],
    });
  } catch (err) {
    console.error("Failed to run tests:", err);
    exitCode = 1;
  } finally {
    for (const dir of [workspaceDir, globalConfigDir, noConfigDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore, a process may still have a file open
      }
    }
  }
  process.exit(exitCode);
}

function createWorkspaceDir() {
  const workspaceDir = createTempDir();
  fs.writeFileSync(
    path.join(workspaceDir, "dprint.json"),
    JSON.stringify({
      includes: ["**/*.json"],
      plugins: ["https://plugins.dprint.dev/json-0.15.3.wasm"],
    }),
    "utf8",
  );
  // these are set here instead of by the tests so that they apply from the start
  fs.mkdirSync(path.join(workspaceDir, ".vscode"));
  fs.writeFileSync(
    path.join(workspaceDir, ".vscode", "settings.json"),
    JSON.stringify({
      "files.eol": "\n",
      "editor.defaultFormatter": "dprint.dprint",
      "editor.formatOnSave": true,
    }),
    "utf8",
  );
  return workspaceDir;
}

function createGlobalConfigDir() {
  const globalConfigDir = createTempDir();
  fs.writeFileSync(
    path.join(globalConfigDir, "dprint.json"),
    JSON.stringify({
      // differs from the workspace's config file so the tests can tell which one was used
      json: { indentWidth: 4 },
      excludes: ["**/*.excluded.json"],
      plugins: ["https://plugins.dprint.dev/json-0.15.3.wasm"],
    }),
    "utf8",
  );
  return globalConfigDir;
}

function createTempDir() {
  // resolve the real path because the temp directory may be a symlink or a short path on Windows
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "dprint-vscode-test-")));
}

main();
