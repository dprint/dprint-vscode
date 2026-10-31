import * as assert from "node:assert";
import { describe, it } from "node:test";
import {
  expandWindowsEnvVars,
  getCommandDisplayText,
  getCommandLaunchInfo,
  getProcessKey,
  getProcessTreeKill,
  type KillableProcess,
  killProcessTreeWith,
  type ProcessTreeKillEnvironment,
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

describe("getProcessTreeKill", () => {
  it("kills the process tree with taskkill by its absolute path on Windows", () => {
    // ex. the dprint.exe that the cmd.exe of an npm `dprint.cmd` started
    assert.deepStrictEqual(getProcessTreeKill(1234, "win32", "D:\\Windows"), {
      kind: "command",
      command: "D:\\Windows\\System32\\taskkill.exe",
      args: ["/T", "/F", "/PID", "1234"],
    });
    assert.strictEqual(
      (getProcessTreeKill(1234, "win32", undefined) as { command: string }).command,
      "C:\\Windows\\System32\\taskkill.exe",
    );
  });

  it("signals the process group elsewhere", () => {
    // ex. the dprint that npm's Node.js wrapper started
    assert.deepStrictEqual(getProcessTreeKill(1234, "linux", undefined), { kind: "group", pid: -1234 });
    assert.deepStrictEqual(getProcessTreeKill(1234, "darwin", undefined), { kind: "group", pid: -1234 });
  });
});

describe("killProcessTreeWith", () => {
  it("runs taskkill on Windows, and kills only the process when that fails", async () => {
    for (const succeeds of [true, false]) {
      const { process, killed } = createProcess(1234);
      const { env, calls } = createEnvironment("win32", { runSucceeds: succeeds });
      await killProcessTreeWith(process, undefined, env);
      assert.deepStrictEqual(calls, [["run", "C:\\Windows\\System32\\taskkill.exe", "/T", "/F", "/PID", "1234"]]);
      assert.deepStrictEqual(killed, succeeds ? [] : [undefined]);
    }
  });

  it("signals the process group elsewhere and waits for its processes to exit", async () => {
    const { process, killed } = createProcess(1234);
    // the group has processes for two checks
    const { env, calls } = createEnvironment("linux", { groupChecks: 2 });
    await killProcessTreeWith(process, "SIGKILL", env);
    assert.deepStrictEqual(calls, [
      ["signal", -1234, "SIGKILL"],
      ["signal", -1234, 0],
      ["delay"],
      ["signal", -1234, 0],
      ["delay"],
      ["signal", -1234, 0],
    ]);
    assert.deepStrictEqual(killed, []);
  });

  it("stops waiting for the processes of the group after a timeout", async () => {
    const { process } = createProcess(1234);
    const { env, calls } = createEnvironment("linux", { groupChecks: Infinity });
    await killProcessTreeWith(process, undefined, env);
    assert.strictEqual(calls.filter(call => call[0] === "delay").length, 100);
  });

  it("kills the group with SIGKILL when its processes don't exit in time, even once its leader exited", async () => {
    // ex. a process a plugin started ignores SIGTERM, and the group isn't reused while it has one
    const { process } = createProcess(1234);
    const { env, calls } = createEnvironment("linux", { groupChecks: 30 });
    await killProcessTreeWith(process, undefined, env);
    const signals = calls.filter(call => call[0] === "signal" && call[2] !== 0);
    assert.deepStrictEqual(signals, [["signal", -1234, "SIGTERM"], ["signal", -1234, "SIGKILL"]]);
    // after the grace period
    const killIndex = calls.findIndex(call => call[2] === "SIGKILL");
    assert.strictEqual(calls.slice(0, killIndex).filter(call => call[0] === "delay").length, 20);

    // and not again when it was already
    const killed = createEnvironment("linux", { groupChecks: 30 });
    await killProcessTreeWith(createProcess(1234).process, "SIGKILL", killed.env);
    assert.strictEqual(killed.calls.filter(call => call[2] === "SIGKILL").length, 1);
  });

  it("kills only the process when the group can't be signalled", async () => {
    const { process, killed } = createProcess(1234);
    const { env } = createEnvironment("linux", { signalThrows: true });
    await killProcessTreeWith(process, "SIGTERM", env);
    assert.deepStrictEqual(killed, ["SIGTERM"]);
  });

  it("only kills the process by its handle without a pid or once it exited", async () => {
    // its pid may be another process's once it exited
    for (const [pid, exitCode] of [[undefined, null], [1234, 1]] as const) {
      const { process, killed } = createProcess(pid, exitCode);
      const { env, calls } = createEnvironment("win32");
      await killProcessTreeWith(process, undefined, env);
      assert.deepStrictEqual(calls, []);
      assert.deepStrictEqual(killed, [undefined]);
    }
  });

  function createProcess(pid: number | undefined, exitCode: number | null = null) {
    const killed: (NodeJS.Signals | undefined)[] = [];
    const process: KillableProcess = {
      pid,
      exitCode,
      signalCode: null,
      kill: signal => {
        killed.push(signal);
        return true;
      },
    };
    return { process, killed };
  }

  function createEnvironment(
    platform: NodeJS.Platform,
    options: { runSucceeds?: boolean; groupChecks?: number; signalThrows?: boolean } = {},
  ) {
    const calls: unknown[][] = [];
    let groupChecks = options.groupChecks ?? 0;
    const env: ProcessTreeKillEnvironment = {
      platform,
      systemRoot: undefined,
      signal: (pid, signal) => {
        calls.push(["signal", pid, signal]);
        if (options.signalThrows || (signal === 0 && groupChecks-- <= 0)) {
          throw new Error("ESRCH");
        }
      },
      run: async (command, args) => {
        calls.push(["run", command, ...args]);
        return options.runSucceeds ?? true;
      },
      delay: async () => {
        calls.push(["delay"]);
      },
    };
    return { env, calls };
  }
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

describe("getProcessKey", () => {
  const options = { cwd: "/project", env: undefined, verbose: false };

  it("is the same for a path in a different cwd", () => {
    const command = { kind: "path" as const, path: "/usr/bin/dprint" };
    assert.strictEqual(getProcessKey(command, options), getProcessKey(command, { ...options, cwd: "/other" }));
  });

  it("differs for a setting with a path relative to the cwd", () => {
    const command = { kind: "setting" as const, path: "bin/dprint", cwd: undefined };
    assert.notStrictEqual(getProcessKey(command, options), getProcessKey(command, { ...options, cwd: "/other" }));
    // a command name is found on the PATH instead
    const commandName = { kind: "setting" as const, path: "dprint", cwd: undefined };
    assert.strictEqual(
      getProcessKey(commandName, options),
      getProcessKey(commandName, { ...options, cwd: "/other" }),
    );
  });

  it("differs for the environment and verbosity", () => {
    const command = { kind: "path" as const, path: "/usr/bin/dprint" };
    const key = getProcessKey(command, options);
    assert.notStrictEqual(key, getProcessKey(command, { ...options, env: { DPRINT_CACHE_DIR: "/cache" } }));
    assert.notStrictEqual(key, getProcessKey(command, { ...options, verbose: true }));
    assert.notStrictEqual(key, getProcessKey({ kind: "path", path: "/other/dprint" }, options));
  });
});
