import * as assert from "node:assert";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as process from "node:process";
import * as vscode from "vscode";

suite("Extension Test Suite", function() {
  // the first format downloads and compiles the plugin
  this.timeout(60_000);

  // see runTest.ts, which creates the workspace folder and opens it when launching vscode
  const workspaceDir = process.env.DPRINT_TEST_WORKSPACE_DIR!;
  let fileCount = 0;

  const context = {
    /** Creates a file in the workspace with a name that's unique to the test. */
    createFile(text: string) {
      const uri = vscode.Uri.file(path.join(workspaceDir, `test${++fileCount}.json`));
      fs.writeFileSync(uri.fsPath, text, "utf8");
      return uri;
    },
    async openAndShowDocument(uri: vscode.Uri) {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.One, false);
      return doc;
    },
    async formatCommand(uri: vscode.Uri) {
      await vscode.commands.executeCommand("editor.action.formatDocument", uri);
    },
    /** Kills the dprint processes that the extension started. */
    killDprintProcesses() {
      // the extension starts dprint as a child process of the extension host, which is this process
      const command = process.platform === "win32" ? "powershell" : "pkill";
      const args = process.platform === "win32"
        ? [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${process.pid} AND Name = 'dprint.exe'"`
          + " | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
        ]
        : ["-P", process.pid.toString(), "dprint"];
      return new Promise<void>((resolve, reject) => {
        cp.execFile(command, args, err => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
  };

  suiteSetup(async () => {
    assert.ok(workspaceDir, "the tests need to be run with `npm test`");
    assert.strictEqual(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath.toLowerCase(),
      vscode.Uri.file(workspaceDir).fsPath.toLowerCase(),
    );
    // restarting waits for the extension to start dprint and register the formatter
    await vscode.commands.executeCommand("dprint.restart");
  });

  teardown(async () => {
    // revert so that a document left dirty by a failed test doesn't prompt to be saved
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  });

  test("format on save", async () => {
    // open an empty json file and edit it
    const doc = await context.openAndShowDocument(context.createFile(""));
    await applyTextChanges(doc, [{
      newText: `{
             "test":     5
      }`,
      range: getRange([0, 0], [0, 0]),
    }]);
    await doc.save();

    // should be formatted
    assert.equal(doc.getText(), `{\n  "test": 5\n}\n`);
  });

  test("format command", async () => {
    const uri = context.createFile(
      `{
          "test":               5
    }`,
    );

    // open the file and format it with the format command
    const doc = await context.openAndShowDocument(uri);
    await context.formatCommand(doc.uri);

    // should be formatted
    assert.equal(doc.getText(), `{\n  "test": 5\n}\n`);
    await doc.save();
  });

  test("format after dprint process kill", async () => {
    // open an empty json file, edit it, and format it
    const doc = await context.openAndShowDocument(context.createFile(""));
    await applyTextChanges(doc, [{
      range: getRange([0, 0], [0, 0]),
      newText: `{
              "   test":     5
        }`,
    }]);
    await context.formatCommand(doc.uri);
    assert.equal(doc.getText(), `{\n  "   test": 5\n}\n`);

    await context.killDprintProcesses();

    // now try editing and formatting again
    await applyTextChanges(doc, [
      vscode.TextEdit.replace(
        getRange([0, 0], [doc.lineCount, 0]),
        `{
              "test":     5
        }`,
      ),
    ]);
    await context.formatCommand(doc.uri);

    // should be formatted
    assert.equal(doc.getText(), `{\n  "test": 5\n}\n`);
    await doc.save();
  });

  async function applyTextChanges(doc: vscode.TextDocument, edits: vscode.TextEdit[]) {
    const edit = new vscode.WorkspaceEdit();
    edit.set(doc.uri, edits);
    await vscode.workspace.applyEdit(edit);
  }

  function getRange(from: [number, number], to: [number, number]) {
    return new vscode.Range(new vscode.Position(from[0], from[1]), new vscode.Position(to[0], to[1]));
  }
});
