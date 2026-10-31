import * as assert from "node:assert";
import { describe, it } from "node:test";
import { AncestorConfigFileWatchers } from "./AncestorConfigFileWatchers";
import type { ConfigFileInfo } from "./messages";

describe("AncestorConfigFileWatchers", () => {
  it("watches each directory once", () => {
    const { watchers, watched } = createWatchers();
    watchers.watch("/a");
    watchers.update([{ dirPath: "/a", info: { configFile: configFile(false) } }]);
    watchers.update([{ dirPath: "/b", info: { configFile: configFile(false) } }]);
    assert.deepStrictEqual(watched, ["/a", "/b"]);
  });

  it("only watches a config file on another machine once it's allowed", () => {
    const { watchers, watched } = createWatchers();
    watchers.update([{ dirPath: "/a", info: { configFile: configFile(true) } }]);
    assert.deepStrictEqual(watched, []);
    watchers.update([{ dirPath: "/a", info: { configFile: configFile(false) } }]);
    assert.deepStrictEqual(watched, ["/a"]);
  });

  it("stops watching a config file that's on another machine now", () => {
    // ex. a local one was replaced with a symlink to another machine
    const { watchers, watched, disposed } = createWatchers();
    watchers.update([{ dirPath: "/a", info: { configFile: configFile(false) } }]);
    watchers.update([{ dirPath: "/a", info: { configFile: configFile(true) } }]);
    assert.deepStrictEqual(disposed, ["/a"]);
    // and watches it again once it's allowed
    watchers.update([{ dirPath: "/a", info: { configFile: configFile(false) } }]);
    assert.deepStrictEqual(watched, ["/a", "/a"]);
  });

  it("doesn't keep what doesn't need to be watched", () => {
    const watched: string[] = [];
    const watchers = new AncestorConfigFileWatchers(dirPath => {
      watched.push(dirPath);
      return undefined;
    });
    watchers.watch("/a");
    watchers.watch("/a");
    assert.deepStrictEqual(watched, ["/a", "/a"]);
  });

  it("disposes the watchers", () => {
    const { watchers, disposed } = createWatchers();
    watchers.watch("/a");
    watchers.watch("/b");
    watchers.dispose();
    assert.deepStrictEqual(disposed, ["/a", "/b"]);
  });
});

function createWatchers() {
  const watched: string[] = [];
  const disposed: string[] = [];
  const watchers = new AncestorConfigFileWatchers(dirPath => {
    watched.push(dirPath);
    return { dispose: () => disposed.push(dirPath) };
  });
  return { watchers, watched, disposed };
}

function configFile(onAnotherMachine: boolean): ConfigFileInfo {
  return {
    uri: "file:///a/dprint.json",
    dirUri: "file:///a/project",
    kind: "local",
    inWorkspace: false,
    ...(onAnotherMachine ? { onAnotherMachine } : {}),
  };
}
