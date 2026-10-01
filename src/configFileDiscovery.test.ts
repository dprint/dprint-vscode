import * as assert from "node:assert";
import { describe, it } from "node:test";
import { type ConfigFileDiscoveryHost, discoverConfigFiles } from "./configFileDiscovery";

describe("discoverConfigFiles", () => {
  it("finds nothing right away when the workspace has no folders", async () => {
    const host = createHost({ hasWorkspaceFolders: false, findFilesResults: [["/folder/dprint.json"]] });

    assert.deepStrictEqual(await discoverConfigFiles(host), []);

    // it shouldn't wait for folders that may never be added or search an empty workspace
    assert.deepStrictEqual(host.delays, []);
    assert.strictEqual(host.findFilesCount, 0);
    assert.strictEqual(host.findRootConfigFileCount, 0);
  });

  it("returns the found files after waiting a little", async () => {
    const host = createHost({ findFilesResults: [["/folder/dprint.json", "/folder/sub/dprint.json"]] });

    assert.deepStrictEqual(await discoverConfigFiles(host), ["/folder/dprint.json", "/folder/sub/dprint.json"]);

    assert.deepStrictEqual(host.delays, [250]);
    assert.strictEqual(host.findFilesCount, 1);
    assert.strictEqual(host.findRootConfigFileCount, 0);
  });

  it("finds nothing when no files are found and there's no config file in a root", async () => {
    const host = createHost({ findFilesResults: [[]] });

    assert.deepStrictEqual(await discoverConfigFiles(host), []);

    assert.deepStrictEqual(host.delays, [250]);
    assert.strictEqual(host.findFilesCount, 1);
    assert.strictEqual(host.findRootConfigFileCount, 1);
  });

  it("retries finding files when there's a config file in a root", async () => {
    const host = createHost({
      findFilesResults: [[], [], ["/folder/dprint.json"]],
      rootConfigFile: "/folder/dprint.json",
    });

    assert.deepStrictEqual(await discoverConfigFiles(host), ["/folder/dprint.json"]);

    assert.deepStrictEqual(host.delays, [250, 1_000, 1_000]);
    assert.strictEqual(host.findFilesCount, 3);
    assert.deepStrictEqual(host.warnings, []);
  });

  it("falls back to the config file in a root after giving up retrying", async () => {
    const host = createHost({ findFilesResults: [], rootConfigFile: "/folder/dprint.json" });

    assert.deepStrictEqual(await discoverConfigFiles(host), ["/folder/dprint.json"]);

    assert.deepStrictEqual(host.delays, [250, 1_000, 1_000, 1_000, 1_000]);
    assert.strictEqual(host.findFilesCount, 5);
    assert.strictEqual(host.warnings.length, 1);
  });
});

interface TestHostOptions {
  hasWorkspaceFolders?: boolean;
  /** The results of each file search in order. Searches after these find nothing. */
  findFilesResults: string[][];
  rootConfigFile?: string;
}

function createHost(options: TestHostOptions) {
  const host: ConfigFileDiscoveryHost<string> & {
    delays: number[];
    findFilesCount: number;
    findRootConfigFileCount: number;
    warnings: string[];
  } = {
    delays: [],
    findFilesCount: 0,
    findRootConfigFileCount: 0,
    warnings: [],
    hasWorkspaceFolders: () => options.hasWorkspaceFolders ?? true,
    findFiles: async () => options.findFilesResults[host.findFilesCount++] ?? [],
    findRootConfigFile: async () => {
      host.findRootConfigFileCount++;
      return options.rootConfigFile;
    },
    delay: async ms => {
      // fail instead of hanging the test run when something polls without end
      if (host.delays.length >= 20) {
        throw new Error("Delayed too many times.");
      }
      host.delays.push(ms);
    },
    logger: {
      logDebug: () => {},
      logWarn: message => host.warnings.push(message),
    },
  };
  return host;
}
