import * as assert from "assert";
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
// import * as myExtension from '../../extension';

suite("Extension Test Suite", () => {
  vscode.window.showInformationMessage("Start all tests.");
  // create a temp folder
  let tempNumber = 0;
  let tempFolder = path.join(process.cwd(), "temp");

  const context = {
    get tempFolderUri() {
      return vscode.Uri.file(tempFolder);
    },
    createFile(name: string, text: string) {
      fs.writeFileSync(path.join(tempFolder, name), text, "utf8");
    },
    reset() {
      fs.rmSync(tempFolder, { recursive: true, force: true });
      fs.mkdirSync(tempFolder, { recursive: true });
    },
    async withTempFolder(action: () => Promise<void>) {
      tempFolder = path.join(process.cwd(), `temp${++tempNumber}`);
      fs.rmSync(tempFolder, { recursive: true, force: true });
      fs.mkdirSync(tempFolder, { recursive: true });
      await action();
    },
    createDprintJson() {
      this.createFile(
        "dprint.json",
        `{
        "includes": [
          "**/*.json"
        ],
        "plugins": [
          "https://plugins.dprint.dev/json-0.15.3.wasm"
        ]
      }`,
      );
    },
    async openWorkspace() {
      await vscode.commands.executeCommand("vscode.openFolder", this.tempFolderUri);
      await vscode.workspace.getConfiguration("files").update("eol", "\n");
      await vscode.workspace.getConfiguration("editor").update("defaultFormatter", "dprint.dprint");
    },
    async configureFormatOnSave() {
      await vscode.workspace.getConfiguration("editor").update("formatOnSave", true);
    },
    getUri(name: string) {
      return vscode.Uri.joinPath(this.tempFolderUri, name);
    },
    waitInitialize() {
      // would be nice to do something better
      return this.sleep(250);
    },
    async sleep(ms: number) {
      await new Promise(resolve => setTimeout(resolve, ms));
    },
    async openAndShowDocument(name: string) {
      const doc = await vscode.workspace.openTextDocument(this.getUri(name));
      await vscode.window.showTextDocument(doc, 0, false);
      return doc;
    },
    async formatCommand(name: string | vscode.Uri) {
      await vscode.commands.executeCommand(
        "editor.action.formatDocument",
        name instanceof vscode.Uri ? name : this.getUri(name),
      );
    },
    async killAllDprintProcesses() {
      return new Promise<void>((resolve, reject) => {
        const command = os.platform() === "win32"
          ? "taskkill /im dprint.exe /f"
          : "pkill dprint";
        cp.exec(command, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
  };

  test("format on save", async () => {
    context.reset();
    context.createDprintJson();
    context.createFile("test.json", "");
    await context.openWorkspace();
    await context.configureFormatOnSave();
    await context.waitInitialize();

    // create a json file and open it
    const doc = await context.openAndShowDocument("test.json");
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
    context.reset();
    context.createDprintJson();
    context.createFile(
      "test.json",
      `{
          "test":               5
    }`,
    );
    await context.openWorkspace();
    await context.waitInitialize();

    // open the test.json and format it with the format command
    const doc = await context.openAndShowDocument("test.json");
    await context.formatCommand(doc.uri);

    // should be formatted
    assert.equal(doc.getText(), `{\n  "test": 5\n}\n`);
  });

  test("format after dprint process kill", async () => {
    context.reset();
    context.createDprintJson();
    context.createFile("test.json", "");
    await context.openWorkspace();
    await context.waitInitialize();

    // create a json file and open it
    const doc = await context.openAndShowDocument("test.json");
    await applyTextChanges(doc, [{
      range: getRange([0, 0], [0, 0]),
      newText: `{
              "   test":     5
        }`,
    }]);
    await context.formatCommand(doc.uri);

    await context.killAllDprintProcesses();

    // now try editing and saving again
    await applyTextChanges(doc, [
      vscode.TextEdit.delete(getRange([0, 0], [5, 0])),
      {
        range: getRange([0, 0], [0, 0]),
        newText: `{
              "test":     5
        }`,
      },
    ]);
    await context.formatCommand(doc.uri);

    // should be formatted
    assert.equal(doc.getText(), `{\n  "test": 5\n}\n`);
  }).timeout(4_000);

  async function applyTextChanges(doc: vscode.TextDocument, edits: vscode.TextEdit[]) {
    const edit = new vscode.WorkspaceEdit();
    edit.set(doc.uri, edits);
    await vscode.workspace.applyEdit(edit);
  }

  function getRange(from: [number, number], to: [number, number]) {
    return new vscode.Range(new vscode.Position(from[0], from[1]), new vscode.Position(to[0], to[1]));
  }
});
