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
  // a directory outside the workspace without a config file
  const noConfigDir = process.env.DPRINT_TEST_NO_CONFIG_DIR!;
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

  test("format with global config command", async function() {
    // a config file in an ancestor directory of the temp directory would be used instead of the global one
    if (hasAncestorConfigFile(noConfigDir)) {
      this.skip();
    }
    const uri = vscode.Uri.file(path.join(noConfigDir, "global.json"));
    fs.writeFileSync(uri.fsPath, `{\n"test":     5\n}`, "utf8");

    const doc = await context.openAndShowDocument(uri);
    const messages = await captureMessages(() => vscode.commands.executeCommand("dprint.formatWithGlobalConfig"));

    // should be formatted with the indent width of the global config file (see runTest.ts)
    assert.equal(doc.getText(), `{\n    "test": 5\n}\n`);
    assert.deepStrictEqual(messages, []);

    // says nothing when the document is already formatted
    assert.deepStrictEqual(
      await captureMessages(() => vscode.commands.executeCommand("dprint.formatWithGlobalConfig")),
      [],
    );
    assert.equal(doc.getText(), `{\n    "test": 5\n}\n`);
  });

  test("format with global config command keeps the cursor in place in a large file", async function() {
    if (hasAncestorConfigFile(noConfigDir)) {
      this.skip();
    }
    // vscode only reduces the edits of an extension to what changed for text up to
    // 100,000 characters, so use more than that to test the extension doing it
    const properties = Array.from({ length: 6_000 }, (_, i) => `    "property${i}": ${i},\n`).join("");
    assert.ok(properties.length > 100_000);
    const uri = vscode.Uri.file(path.join(noConfigDir, "cursor.json"));
    fs.writeFileSync(uri.fsPath, `{\n"test":     5,\n${properties}    "last": 1\n}\n`, "utf8");

    const doc = await context.openAndShowDocument(uri);
    const editor = vscode.window.activeTextEditor!;
    editor.selection = new vscode.Selection(3_000, 8, 3_000, 8);
    await vscode.commands.executeCommand("dprint.formatWithGlobalConfig");

    assert.equal(doc.getText(), `{\n    "test": 5,\n${properties}    "last": 1\n}\n`);
    assert.deepStrictEqual([editor.selection.active.line, editor.selection.active.character], [3_000, 8]);
  });

  test("format with global config command says why a document wasn't formatted", async function() {
    if (hasAncestorConfigFile(noConfigDir)) {
      this.skip();
    }
    const formatAndAssertMessage = async (expectedMessage: RegExp) => {
      // every time and not only the first time in a session
      for (let i = 0; i < 2; i++) {
        const messages = await captureMessages(() => vscode.commands.executeCommand("dprint.formatWithGlobalConfig"));
        assert.equal(messages.length, 1);
        assert.match(messages[0], expectedMessage);
      }
    };

    // the global config file has no plugin for this file
    const textFileUri = vscode.Uri.file(path.join(noConfigDir, "global.txt"));
    fs.writeFileSync(textFileUri.fsPath, "some   text", "utf8");
    const textDoc = await context.openAndShowDocument(textFileUri);
    await formatAndAssertMessage(/No plugin in the configuration file in use handles its file name or extension/);

    // there's no global config file
    // (the extension reads this in the extension host, which is this process)
    const globalConfigDir = process.env.DPRINT_CONFIG_DIR;
    process.env.DPRINT_CONFIG_DIR = path.join(noConfigDir, "no-global-config");
    try {
      await formatAndAssertMessage(/No dprint configuration file found/);

      // the global config file has no plugins
      const noPluginsConfigDir = path.join(noConfigDir, "no-plugins-global-config");
      fs.mkdirSync(noPluginsConfigDir);
      fs.writeFileSync(path.join(noPluginsConfigDir, "dprint.json"), JSON.stringify({ plugins: [] }), "utf8");
      process.env.DPRINT_CONFIG_DIR = noPluginsConfigDir;
      // restart because the dprint process that's running for the global config file was
      // started with the other directory and is otherwise used until its config file changes
      await vscode.commands.executeCommand("dprint.restart");
      await formatAndAssertMessage(/the configuration file in use has no plugins/);
    } finally {
      process.env.DPRINT_CONFIG_DIR = globalConfigDir;
      await vscode.commands.executeCommand("dprint.restart");
    }
    assert.equal(textDoc.getText(), "some   text");
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");

    // the global config file excludes this file (see runTest.ts)
    const excludedFileUri = vscode.Uri.file(path.join(noConfigDir, "global.excluded.json"));
    fs.writeFileSync(excludedFileUri.fsPath, `{\n"test":     5\n}`, "utf8");
    const excludedDoc = await context.openAndShowDocument(excludedFileUri);
    await formatAndAssertMessage(/"includes" and "excludes" of the configuration file in use don't match it/);
    assert.equal(excludedDoc.getText(), `{\n"test":     5\n}`);
  });

  test("provides the schemas of the plugins for the config file", async () => {
    const doc = await context.openAndShowDocument(vscode.Uri.file(path.join(workspaceDir, "dprint.json")));
    // not saved, so this doesn't change the config that the other tests use
    await applyTextChanges(doc, [
      vscode.TextEdit.replace(
        getRange([0, 0], [doc.lineCount, 0]),
        JSON.stringify({ json: { lineWidth: "text", indentWidth: 2 }, plugins: [] }, undefined, 2),
      ),
    ]);

    // vscode says when it couldn't load a schema, which is what happens when it's left to
    // download a plugin's schema because that's not on a domain that the user trusts
    const messages = await waitForDiagnosticMessages(doc.uri);
    assert.deepStrictEqual(messages, ["Incorrect type. Expected \"number\"."]);
  });

  /** Waits for vscode to report problems in the document and returns their messages. */
  async function waitForDiagnosticMessages(uri: vscode.Uri) {
    for (let i = 0; i < 300; i++) {
      const diagnostics = vscode.languages.getDiagnostics(uri);
      if (diagnostics.length > 0) {
        return diagnostics.map(diagnostic => diagnostic.message);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return [];
  }

  /**
   * Runs the action and returns the messages the extension showed while it ran. The tests
   * are part of the extension, so they have the same instance of vscode's api as it does.
   */
  async function captureMessages(action: () => Thenable<unknown>) {
    const messages: string[] = [];
    const window = vscode.window as any;
    const { showInformationMessage, showWarningMessage } = window;
    const showMessage = (message: string) => {
      messages.push(message);
      return Promise.resolve(undefined);
    };
    window.showInformationMessage = showMessage;
    window.showWarningMessage = showMessage;
    try {
      await action();
    } finally {
      window.showInformationMessage = showInformationMessage;
      window.showWarningMessage = showWarningMessage;
    }
    return messages;
  }

  function hasAncestorConfigFile(dirPath: string): boolean {
    const hasConfigFile = ["dprint.json", "dprint.jsonc", ".dprint.json", ".dprint.jsonc"]
      .some(fileName => fs.existsSync(path.join(dirPath, fileName)));
    const parentPath = path.dirname(dirPath);
    return hasConfigFile || parentPath !== dirPath && hasAncestorConfigFile(parentPath);
  }

  async function applyTextChanges(doc: vscode.TextDocument, edits: vscode.TextEdit[]) {
    const edit = new vscode.WorkspaceEdit();
    edit.set(doc.uri, edits);
    await vscode.workspace.applyEdit(edit);
  }

  function getRange(from: [number, number], to: [number, number]) {
    return new vscode.Range(new vscode.Position(from[0], from[1]), new vscode.Position(to[0], to[1]));
  }
});
