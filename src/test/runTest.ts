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
  let exitCode = 0;
  try {
    // Download VS Code, unzip it and run the integration test
    await runTests({
      // use an existing vscode install instead of downloading the latest stable version
      vscodeExecutablePath: process.env.DPRINT_TEST_VSCODE_EXECUTABLE || undefined,
      extensionDevelopmentPath,
      extensionTestsPath,
      // the tests get the path of the workspace folder from this
      extensionTestsEnv: { DPRINT_TEST_WORKSPACE_DIR: workspaceDir },
      launchArgs: [workspaceDir, "--disable-extensions"],
    });
  } catch (err) {
    console.error("Failed to run tests:", err);
    exitCode = 1;
  } finally {
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // ignore, a process may still have a file open
    }
  }
  process.exit(exitCode);
}

function createWorkspaceDir() {
  // resolve the real path because the temp directory may be a symlink or a short path on Windows
  const workspaceDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "dprint-vscode-test-")));
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

main();
