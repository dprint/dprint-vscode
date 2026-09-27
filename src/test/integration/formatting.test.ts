import * as assert from "node:assert/strict";
import * as process from "node:process";
import * as vscode from "vscode";

const encoder = new TextEncoder();
const extensionId = "dante-marshal.dprint-vscode";
const unformattedJson = "{\n       \"test\":     5\n}";
const backend = requiredEnv("DPRINT_TEST_BACKEND");
const hasWorkspace = requiredEnv("DPRINT_TEST_HAS_WORKSPACE") === "true";
const ancestorProjectUri = vscode.Uri.file(requiredEnv("DPRINT_TEST_ANCESTOR_PROJECT"));
const globalConfigDirUri = vscode.Uri.file(requiredEnv("DPRINT_TEST_GLOBAL_CONFIG_DIR"));
const globalFilesUri = vscode.Uri.file(requiredEnv("DPRINT_TEST_GLOBAL_FILES"));
const missingFilesUri = vscode.Uri.file(requiredEnv("DPRINT_TEST_MISSING_FILES"));
const pluginUrl = requiredEnv("DPRINT_TEST_PLUGIN_URL");

suite(`${backend} formatting (${hasWorkspace ? "workspace" : "empty window"})`, () => {
  suiteSetup(async () => {
    assert.equal(vscode.workspace.workspaceFolders != null, hasWorkspace);
    assert.equal(vscode.workspace.getConfiguration("dprint").get("experimentalLsp"), backend === "lsp");
    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension, `Expected ${extensionId} to be installed.`);
    await extension.activate();
    const readinessDocument = await createDocument(
      vscode.Uri.joinPath(ancestorProjectUri, "backend-ready.dprint-test"),
      unformattedJson,
    );
    await waitForFormattedDocument(readinessDocument, formattedJson(4), () => showAndFormat(readinessDocument));
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("provides the dprint configuration schema", async () => {
    const uri = vscode.Uri.parse("dprint://schemas/config.json");
    const document = await vscode.workspace.openTextDocument(uri);
    const schema = JSON.parse(document.getText());
    assert.equal(schema.$id, uri.toString());
    assert.equal(schema.type, "object");
  });

  test("repeatedly leaves a loose file unchanged without config", async () => {
    const document = await createDocument(
      vscode.Uri.joinPath(missingFilesUri, "missing.dprint-test"),
      unformattedJson,
    );
    await showAndFormat(document);
    await showAndFormat(document);
    assert.equal(document.getText(), unformattedJson);
  });

  test("formats a loose file with the global config", async () => {
    await writeGlobalConfig();
    const document = await createDocument(vscode.Uri.joinPath(globalFilesUri, "global.dprint-test"), unformattedJson);
    await waitForFormattedDocument(document, formattedJson(6), () => showAndFormat(document));
  });

  test("prefers a loose file's nearest ancestor config over the global config", async () => {
    const document = await createDocument(
      vscode.Uri.joinPath(ancestorProjectUri, "nested", "ancestor.dprint-test"),
      unformattedJson,
    );
    await waitForFormattedDocument(document, formattedJson(4), () => showAndFormat(document));
  });

  test("formats a loose file on save", async () => {
    const document = await createDocument(vscode.Uri.joinPath(globalFilesUri, "save.dprint-test"), "");
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One, false);
    await replaceDocumentText(document, unformattedJson);
    await waitForFormattedDocument(document, formattedJson(6), async () => {
      await vscode.commands.executeCommand("workbench.action.files.save");
    });
  });

  test("formats a loose file after the restart command", async () => {
    await vscode.commands.executeCommand("dprint.restart");
    const document = await createDocument(vscode.Uri.joinPath(globalFilesUri, "restart.dprint-test"), unformattedJson);
    await waitForFormattedDocument(document, formattedJson(6), () => showAndFormat(document));
  });

  if (hasWorkspace) {
    test("preserves workspace config formatting", async () => {
      const workspace = vscode.workspace.workspaceFolders?.[0];
      assert.ok(workspace);
      const document = await createDocument(
        vscode.Uri.joinPath(workspace.uri, "workspace.dprint-test"),
        unformattedJson,
      );
      await waitForFormattedDocument(document, formattedJson(2), () => showAndFormat(document));
    });

    test("reinitializes after the workspace config changes", async () => {
      const workspace = vscode.workspace.workspaceFolders?.[0];
      assert.ok(workspace);
      const configUri = vscode.Uri.joinPath(workspace.uri, "dprint.json");
      const config = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(configUri)));
      config.indentWidth = 3;
      await vscode.workspace.fs.writeFile(configUri, encoder.encode(JSON.stringify(config)));

      const document = await createDocument(
        vscode.Uri.joinPath(workspace.uri, "configuration-change.dprint-test"),
        unformattedJson,
      );
      await waitForFormattedDocument(document, formattedJson(3), () => showAndFormat(document));
    });
  }
});

async function writeGlobalConfig() {
  const config = {
    indentWidth: 6,
    includes: ["**/*.dprint-test"],
    plugins: [pluginUrl],
    json: {
      associations: ["*.dprint-test"],
    },
  };
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(globalConfigDirUri, "dprint.json"),
    encoder.encode(JSON.stringify(config)),
  );
}

async function createDocument(uri: vscode.Uri, text: string) {
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, "../"));
  await vscode.workspace.fs.writeFile(uri, encoder.encode(text));
  return vscode.workspace.openTextDocument(uri);
}

async function showAndFormat(document: vscode.TextDocument) {
  await vscode.window.showTextDocument(document, vscode.ViewColumn.One, false);
  const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
    "vscode.executeFormatDocumentProvider",
    document.uri,
    { tabSize: 2, insertSpaces: true },
  );
  if (edits != null && edits.length > 0) {
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.set(document.uri, edits);
    assert.equal(await vscode.workspace.applyEdit(workspaceEdit), true);
  }
}

async function replaceDocumentText(document: vscode.TextDocument, text: string) {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, fullDocumentRange(document), text);
  assert.equal(await vscode.workspace.applyEdit(edit), true);
}

async function waitForFormattedDocument(
  document: vscode.TextDocument,
  expected: string,
  action: () => Promise<void>,
) {
  const deadline = Date.now() + 30_000;
  let lastText = document.getText();
  while (Date.now() < deadline) {
    await action();
    lastText = document.getText();
    if (lastText === expected) {
      return;
    }
    await delay(100);
  }
  assert.fail(`Timed out waiting for formatting. Expected:\n${expected}\nActual:\n${lastText}`);
}

function formattedJson(indentWidth: number) {
  return `{\n${" ".repeat(indentWidth)}\"test\": 5\n}\n`;
}

function fullDocumentRange(document: vscode.TextDocument) {
  const lastLine = document.lineAt(document.lineCount - 1);
  return new vscode.Range(0, 0, document.lineCount - 1, lastLine.text.length);
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (value == null) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

function delay(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}
