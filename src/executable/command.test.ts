import * as assert from "node:assert";
import { describe, it } from "node:test";
import { getCommandLaunchInfo } from "./command";

describe("getCommandLaunchInfo", () => {
  it("passes the arguments as-is without a shell", () => {
    const args = ["editor-info", "--config", "/home/user/$(echo hi)/`echo hi`/dprint.json"];
    assert.deepStrictEqual(getCommandLaunchInfo("/usr/bin/dprint", args, "linux"), {
      command: "/usr/bin/dprint",
      args,
      shell: false,
    });
    assert.deepStrictEqual(getCommandLaunchInfo("dprint", args, "darwin").shell, false);
  });

  it("provides a quoted command line for a shell on Windows", () => {
    assert.deepStrictEqual(
      getCommandLaunchInfo("C:\Program Files\dprint.exe", ["editor-info", "--config", "C:\a b\dprint.json"], "win32"),
      {
        command: "\"C:\Program Files\dprint.exe\" \"editor-info\" \"--config\" \"C:\a b\dprint.json\"",
        args: [],
        shell: true,
      },
    );
  });
});
