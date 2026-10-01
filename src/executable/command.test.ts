import * as assert from "node:assert";
import { describe, it } from "node:test";
import {
  expandWindowsEnvVars,
  getCommandDisplayText,
  getCommandLaunchInfo,
  isCwdDependentSettingPath,
  resolveWindowsCommand,
  substituteCommands,
} from "./command";

describe("getCommandLaunchInfo", () => {
  const configArgs = ["editor-info", "--config", "/home/user/$(echo hi)/`echo hi`/it's/dprint.json"];

  it("passes the arguments as-is without a shell for a path", () => {
    assert.deepStrictEqual(getCommandLaunchInfo({ kind: "path", path: "/usr/bin/dprint" }, configArgs, "linux"), {
      command: "/usr/bin/dprint",
      args: configArgs,
      shell: false,
    });
  });

  it("lets the shell interpret a setting, but not the arguments", () => {
    assert.deepStrictEqual(
      getCommandLaunchInfo({ kind: "setting", path: "$(yarn bin dprint)", cwd: "/project" }, configArgs, "darwin"),
      {
        command: "\"$(yarn bin dprint)\" 'editor-info' '--config' "
          + "'/home/user/$(echo hi)/`echo hi`/it'\\''s/dprint.json'",
        args: [],
        shell: true,
      },
    );
  });

  it("doesn't let the shell interpret the directory of a relative setting", () => {
    assert.deepStrictEqual(
      getCommandLaunchInfo({ kind: "setting", path: "./bin/dprint", cwd: "/$(echo hi)" }, ["-v"], "linux").command,
      "'/$(echo hi)/'\"./bin/dprint\" '-v'",
    );
  });

  it("launches an executable without a shell on Windows", () => {
    const args = ["editor-info", "--config", "C:\\a b\\dprint.json"];
    assert.deepStrictEqual(
      getCommandLaunchInfo({ kind: "path", path: "C:\\Program Files\\dprint.exe" }, args, "win32"),
      { command: "C:\\Program Files\\dprint.exe", args, shell: false },
    );
    assert.deepStrictEqual(
      getCommandLaunchInfo({ kind: "setting", path: "./bin/dprint.exe", cwd: "C:\\project" }, ["-v"], "win32"),
      { command: "C:\\project\\bin\\dprint.exe", args: ["-v"], shell: false },
    );
    // not found when resolving, so let launching it fail without cmd.exe's error
    assert.deepStrictEqual(
      getCommandLaunchInfo({ kind: "path", path: "dprint" }, ["-v"], "win32"),
      { command: "dprint", args: ["-v"], shell: false },
    );
  });

  it("provides a quoted command line for a shell for a batch file on Windows", () => {
    assert.deepStrictEqual(
      getCommandLaunchInfo(
        { kind: "path", path: "C:\\npm prefix\\dprint.CMD" },
        ["editor-info", "--config", "C:\\a b\\dprint.json"],
        "win32",
      ),
      {
        command: "\"C:\\npm prefix\\dprint.CMD\" \"editor-info\" \"--config\" \"C:\\a b\\dprint.json\"",
        args: [],
        shell: true,
      },
    );
    assert.strictEqual(
      getCommandLaunchInfo({ kind: "setting", path: "./bin/dprint.bat", cwd: "C:\\project" }, ["-v"], "win32").command,
      "\"C:\\project\\bin\\dprint.bat\" \"-v\"",
    );
  });
});

describe("isCwdDependentSettingPath", () => {
  it("is true for relative paths", () => {
    assert.strictEqual(isCwdDependentSettingPath("./node_modules/.bin/dprint"), true);
    assert.strictEqual(isCwdDependentSettingPath("../bin/dprint"), true);
    assert.strictEqual(isCwdDependentSettingPath("node_modules/.bin/dprint"), true);
    assert.strictEqual(isCwdDependentSettingPath(".\\node_modules\\.bin\\dprint.cmd"), true);
    assert.strictEqual(isCwdDependentSettingPath("tools\\dprint.exe"), true);
  });

  it("is true when substituting a command", () => {
    assert.strictEqual(isCwdDependentSettingPath("$(yarn bin dprint)"), true);
    assert.strictEqual(isCwdDependentSettingPath("/usr/bin/$(echo dprint)"), true);
    assert.strictEqual(isCwdDependentSettingPath("`yarn bin dprint`"), true);
  });

  it("is false for absolute paths", () => {
    assert.strictEqual(isCwdDependentSettingPath("/usr/bin/dprint"), false);
    assert.strictEqual(isCwdDependentSettingPath("C:\\tools\\dprint.exe"), false);
    assert.strictEqual(isCwdDependentSettingPath("c:/tools/dprint.exe"), false);
    assert.strictEqual(isCwdDependentSettingPath("\\\\server\\share\\dprint.exe"), false);
  });

  it("is false for paths in the home directory or an environment variable", () => {
    assert.strictEqual(isCwdDependentSettingPath("~/bin/dprint"), false);
    assert.strictEqual(isCwdDependentSettingPath("$HOME/bin/dprint"), false);
    assert.strictEqual(isCwdDependentSettingPath("${HOME}/bin/dprint"), false);
    assert.strictEqual(isCwdDependentSettingPath("%USERPROFILE%\\bin\\dprint.exe"), false);
  });

  it("is false for a command name", () => {
    assert.strictEqual(isCwdDependentSettingPath("dprint"), false);
    assert.strictEqual(isCwdDependentSettingPath("dprint-custom.exe"), false);
  });
});

describe("expandWindowsEnvVars", () => {
  it("expands defined variables and leaves others as-is", () => {
    assert.strictEqual(
      expandWindowsEnvVars("%LOCALAPPDATA%\\dprint\\%UNDEFINED%\\dprint.exe 100%", { LOCALAPPDATA: "C:\\Local" }),
      "C:\\Local\\dprint\\%UNDEFINED%\\dprint.exe 100%",
    );
  });
});

describe("resolveWindowsCommand", () => {
  it("resolves the executable file", async () => {
    const searched: string[] = [];
    const which = (command: string) => {
      searched.push(command);
      return Promise.resolve(command === "dprint" ? "C:\\npm prefix\\dprint.cmd" : `${command}.exe`);
    };
    assert.deepStrictEqual(
      await resolveWindowsCommand({ kind: "path", path: "dprint" }, which),
      { kind: "path", path: "C:\\npm prefix\\dprint.cmd" },
    );
    assert.deepStrictEqual(
      await resolveWindowsCommand({ kind: "setting", path: "./bin/dprint", cwd: "C:\\project" }, which),
      { kind: "setting", path: "C:\\project\\bin\\dprint.exe", cwd: "C:\\project" },
    );
    assert.deepStrictEqual(searched, ["dprint", "C:\\project\\bin\\dprint"]);
  });

  it("keeps the command when the file isn't found", async () => {
    const command = { kind: "path" as const, path: "dprint" };
    assert.strictEqual(await resolveWindowsCommand(command, () => Promise.resolve(undefined)), command);
  });
});

describe("substituteCommands", () => {
  it("replaces each command with its trimmed output", async () => {
    const commands: string[] = [];
    const result = await substituteCommands("$(yarn bin dprint) and $(echo b)!", command => {
      commands.push(command);
      return Promise.resolve(command === "yarn bin dprint" ? "C:\\project\\node_modules\\.bin\\dprint\r\n" : "b\n");
    });
    assert.strictEqual(result, "C:\\project\\node_modules\\.bin\\dprint and b!");
    assert.deepStrictEqual(commands, ["yarn bin dprint", "echo b"]);
  });

  it("leaves text without commands as-is", async () => {
    const result = await substituteCommands("C:\\Program Files\\dprint.exe", () => {
      throw new Error("should not run");
    });
    assert.strictEqual(result, "C:\\Program Files\\dprint.exe");
  });
});

describe("getCommandDisplayText", () => {
  it("displays the path", () => {
    assert.strictEqual(getCommandDisplayText({ kind: "path", path: "dprint" }), "dprint");
    assert.strictEqual(
      getCommandDisplayText({ kind: "setting", path: "$HOME/dprint", cwd: "/project" }),
      "$HOME/dprint",
    );
  });
});
