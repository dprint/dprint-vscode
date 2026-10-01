import * as assert from "node:assert";
import * as path from "node:path";
import { describe, it } from "node:test";
import { AncestorConfigFileCache } from "./configPaths";
import {
  canFormatWithGlobalConfig,
  getNotFormattedMessage,
  type GlobalConfigCommandDocument,
  type GlobalConfigCommandEnvironment,
} from "./globalConfigCommand";
import { TestEnvironment } from "./TestEnvironment";

describe("canFormatWithGlobalConfig", () => {
  const homeDir = path.resolve("/home/user");
  const projectDir = path.resolve("/project");
  const otherDir = path.resolve("/other");

  /** Creates an environment where only the project directory has a config file. */
  function createEnv(options: Partial<GlobalConfigCommandEnvironment> = {}): GlobalConfigCommandEnvironment {
    const env = new TestEnvironment({ homeDir });
    env.writeFile(path.join(projectDir, "dprint.json"), "{}");
    const cache = new AncestorConfigFileCache(env);
    return {
      untitledDirPath: homeDir,
      isRemote: false,
      findAncestorConfigFile: dirPath => cache.find(dirPath),
      ...options,
    };
  }

  function canFormat(document: GlobalConfigCommandDocument | undefined, env = createEnv()) {
    return canFormatWithGlobalConfig(document, env);
  }

  it("is false when there's no document", async () => {
    assert.strictEqual(await canFormat(undefined), false);
  });

  it("is true for a file without a config file in an ancestor directory", async () => {
    assert.strictEqual(await canFormat({ scheme: "file", fsPath: path.join(otherDir, "src/file.ts") }), true);
  });

  it("is false for a file with a config file in an ancestor directory", async () => {
    assert.strictEqual(await canFormat({ scheme: "file", fsPath: path.join(projectDir, "file.ts") }), false);
    assert.strictEqual(await canFormat({ scheme: "file", fsPath: path.join(projectDir, "src/file.ts") }), false);
  });

  it("is true for a user data file without a config file in an ancestor directory", async () => {
    const document = { scheme: "vscode-userdata", fsPath: path.join(homeDir, "Code/User/settings.json") };
    assert.strictEqual(await canFormat(document), true);
  });

  it("is false for a user data file with a config file in an ancestor directory", async () => {
    const document = { scheme: "vscode-userdata", fsPath: path.join(projectDir, "Code/User/settings.json") };
    assert.strictEqual(await canFormat(document), false);
  });

  it("is false for a user data file in a remote window because the file is on the local machine", async () => {
    const document = { scheme: "vscode-userdata", fsPath: path.join(homeDir, "Code/User/settings.json") };
    assert.strictEqual(await canFormat(document, createEnv({ isRemote: true })), false);
  });

  it("uses the directory untitled documents are formatted in for an untitled document", async () => {
    const document = { scheme: "untitled", fsPath: "Untitled-1" };
    assert.strictEqual(await canFormat(document, createEnv({ untitledDirPath: otherDir })), true);
    assert.strictEqual(await canFormat(document, createEnv({ untitledDirPath: projectDir })), false);
    assert.strictEqual(await canFormat(document, createEnv({ untitledDirPath: undefined })), false);
  });

  it("uses the notebook's directory for a notebook cell", async () => {
    const getCell = (notebookPath: string, notebookScheme = "file") => ({
      scheme: "vscode-notebook-cell",
      fsPath: notebookPath,
      notebook: { scheme: notebookScheme, fsPath: notebookPath },
    });
    assert.strictEqual(await canFormat(getCell(path.join(otherDir, "notebook.ipynb"))), true);
    assert.strictEqual(await canFormat(getCell(path.join(projectDir, "notebook.ipynb"))), false);
    // unsaved notebooks aren't formatted
    assert.strictEqual(await canFormat(getCell("Untitled-1.ipynb", "untitled")), false);
  });

  it("is false for a notebook cell whose notebook isn't known", async () => {
    const document = { scheme: "vscode-notebook-cell", fsPath: path.join(otherDir, "notebook.ipynb") };
    assert.strictEqual(await canFormat(document), false);
  });

  it("is false for documents of other schemes", async () => {
    assert.strictEqual(await canFormat({ scheme: "output", fsPath: path.join(otherDir, "file.ts") }), false);
    assert.strictEqual(await canFormat({ scheme: "git", fsPath: path.join(otherDir, "file.ts") }), false);
  });
});

describe("getNotFormattedMessage", () => {
  it("says how to create a config file when there's none", () => {
    assert.strictEqual(
      getNotFormattedMessage("noConfigFile"),
      "No dprint configuration file found. Run \"dprint init\" in your project to create one "
        + "or \"dprint init --global\" to create a global one.",
    );
  });

  it("says the config file doesn't match the document when it's not matched", () => {
    assert.strictEqual(
      getNotFormattedMessage("notMatched"),
      "dprint did not format this document because the \"includes\" and \"excludes\" of the "
        + "configuration file in use don't match it.",
    );
  });

  it("says the config file has no plugins when it has none", () => {
    assert.strictEqual(
      getNotFormattedMessage("noPlugins"),
      "dprint did not format this document because the configuration file in use has no plugins.",
    );
  });

  it("says no plugin handles the document when there's no plugin for it", () => {
    // worded to stay true for an already formatted file that an association or shebang matches
    assert.strictEqual(
      getNotFormattedMessage("noPlugin"),
      "dprint did not change this document. No plugin in the configuration file in use handles its file name "
        + "or extension, so it's only formatted when the \"associations\" or \"shebangs\" of the configuration "
        + "file match it to a plugin.",
    );
  });

  it("says which plugins a notebook cell needs when there's no plugin for it", () => {
    assert.strictEqual(
      getNotFormattedMessage("noCellPlugin"),
      "dprint did not format this notebook cell. A cell is only formatted when the plugins in the "
        + "configuration file in use handle both the notebook file (ex. the jupyter plugin) and the cell's language.",
    );
  });

  it("has a different message for each of the other reasons", () => {
    assert.match(getNotFormattedMessage("noFilePath"), /could not determine a file path/);
    assert.match(getNotFormattedMessage("failed"), /See the dprint output/);
  });
});
