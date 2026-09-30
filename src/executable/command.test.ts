import * as assert from "node:assert";
import { describe, it } from "node:test";
import { getCommandDisplayText, getCommandLaunchInfo, substituteCommands } from "./command";

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

  it("provides a quoted command line for a shell on Windows", () => {
    assert.deepStrictEqual(
      getCommandLaunchInfo(
        { kind: "path", path: "C:\\Program Files\\dprint.exe" },
        ["editor-info", "--config", "C:\\a b\\dprint.json"],
        "win32",
      ),
      {
        command: "\"C:\\Program Files\\dprint.exe\" \"editor-info\" \"--config\" \"C:\\a b\\dprint.json\"",
        args: [],
        shell: true,
      },
    );
    assert.strictEqual(
      getCommandLaunchInfo({ kind: "setting", path: "./bin/dprint.exe", cwd: "C:\\project" }, ["-v"], "win32").command,
      "\"C:\\project\\bin\\dprint.exe\" \"-v\"",
    );
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
