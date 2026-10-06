import * as assert from "node:assert";
import { describe, it } from "node:test";
import {
  expandWindowsEnvVars,
  getCommandDisplayText,
  getCommandLaunchInfo,
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
    assert.strictEqual(
      getCommandLaunchInfo({ kind: "setting", path: ".vscode/dprint.BAT", cwd: "C:\\project" }, ["-v"], "win32")
        .command,
      "\"C:\\project\\.vscode\\dprint.BAT\" \"-v\"",
    );
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
      return Promise.resolve(command === "dprint" ? "C:\\npm prefix\\dprint.cmd" : command.replace(/\.EXE$/, ".exe"));
    };
    assert.deepStrictEqual(
      await resolveWindowsCommand({ kind: "path", path: "dprint" }, which),
      { kind: "path", path: "C:\\npm prefix\\dprint.cmd" },
    );
    assert.deepStrictEqual(
      await resolveWindowsCommand({ kind: "setting", path: "./bin/dprint", cwd: "C:\\project" }, which),
      { kind: "setting", path: "C:\\project\\bin\\dprint.exe", cwd: "C:\\project" },
    );
    assert.deepStrictEqual(searched, ["dprint", "C:\\project\\bin\\dprint.EXE"]);
  });

  it("prefers a file with an executable extension over the file at the path", async () => {
    // ex. a `dprint` shell script for other platforms beside a `dprint.bat`
    const files = ["C:\\project\\.vscode\\dprint", "C:\\project\\.vscode\\dprint.bat"];
    const which = (command: string) =>
      Promise.resolve(files.find(file => file.toLowerCase() === command.toLowerCase()));
    for (const settingPath of [".vscode/dprint", ".vscode\\dprint", "./.vscode/dprint"]) {
      assert.deepStrictEqual(
        await resolveWindowsCommand({ kind: "setting", path: settingPath, cwd: "C:\\project" }, which, ".EXE;.BAT"),
        { kind: "setting", path: "C:\\project\\.vscode\\dprint.bat", cwd: "C:\\project" },
      );
    }
  });

  it("searches the launchable extensions in order and only once for a path with an extension", async () => {
    const searched: string[] = [];
    const which = (command: string) => {
      searched.push(command);
      return Promise.resolve(undefined);
    };
    const pathExt = ".COM;.EXE;.BAT;.CMD;.VBS;.JS";
    await resolveWindowsCommand({ kind: "path", path: "C:/bin/dprint" }, which, pathExt);
    await resolveWindowsCommand({ kind: "setting", path: "bin/dprint.Cmd", cwd: "C:\\project" }, which, pathExt);
    await resolveWindowsCommand({ kind: "setting", path: "\\\\srv\\share\\dprint.exe", cwd: "C:\\project" }, which);
    await resolveWindowsCommand({ kind: "setting", path: "C:bin\\dprint.exe", cwd: "C:\\project" }, which);
    assert.deepStrictEqual(searched, [
      "C:/bin/dprint.COM",
      "C:/bin/dprint.EXE",
      "C:/bin/dprint.BAT",
      "C:/bin/dprint.CMD",
      "C:/bin/dprint",
      "C:\\project\\bin\\dprint.Cmd",
      "\\\\srv\\share\\dprint.exe",
      "C:\\project\\bin\\dprint.exe",
    ]);
  });

  it("uses the file at the path when there's none with an executable extension", async () => {
    const which = (command: string) => Promise.resolve(command === "C:\\bin\\dprint" ? command : undefined);
    assert.deepStrictEqual(
      await resolveWindowsCommand({ kind: "setting", path: "C:\\bin\\dprint", cwd: "C:\\project" }, which),
      { kind: "setting", path: "C:\\bin\\dprint", cwd: "C:\\project" },
    );
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
