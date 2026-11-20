import * as assert from "node:assert";
import { describe, it } from "node:test";
import { BackendSwitcher } from "./BackendSwitcher";

describe("BackendSwitcher", () => {
  it("uses the workspace backend when it's supported", async () => {
    const { switcher, events } = createSwitcher([true]);
    await switcher.reInitialize();
    assert.strictEqual(switcher.legacyBackend, undefined);
    assert.deepStrictEqual(events, ["initialize workspace", "workspace supported"]);
  });

  it("switches between the legacy backend and the workspace backend", async () => {
    const { switcher, events } = createSwitcher([false, false, true, false]);

    await switcher.reInitialize();
    const legacyBackend = switcher.legacyBackend;
    assert.notStrictEqual(legacyBackend, undefined);
    // the same legacy backend is initialized again
    await switcher.reInitialize();
    assert.strictEqual(switcher.legacyBackend, legacyBackend);
    // the legacy backend is stopped once the workspace backend is ready
    await switcher.reInitialize();
    assert.strictEqual(switcher.legacyBackend, undefined);
    await switcher.reInitialize();
    assert.notStrictEqual(switcher.legacyBackend, undefined);
    assert.notStrictEqual(switcher.legacyBackend, legacyBackend);

    assert.deepStrictEqual(events, [
      "initialize workspace",
      "create legacy 1",
      "initialize legacy 1",
      "initialize workspace",
      "initialize legacy 1",
      "initialize workspace",
      "dispose legacy 1",
      "workspace supported",
      "initialize workspace",
      "create legacy 2",
      "initialize legacy 2",
    ]);
  });

  it("runs the initializations one at a time and queues one for the requests while one runs", async () => {
    const { switcher, events, workspaceInitializations } = createSwitcher([true, true, true], { manual: true });

    const first = switcher.reInitialize();
    await nextTick();
    const second = switcher.reInitialize();
    const third = switcher.reInitialize();
    // the queued initialization covers the requests made before it starts
    assert.strictEqual(second, third);
    assert.strictEqual(workspaceInitializations.length, 1);

    workspaceInitializations[0]();
    await first;
    await nextTick();
    assert.strictEqual(workspaceInitializations.length, 2);
    // a request after the queued one started queues another
    const fourth = switcher.reInitialize();
    assert.notStrictEqual(fourth, second);
    workspaceInitializations[1]();
    await second;
    await nextTick();
    workspaceInitializations[2]();
    await fourth;
    assert.strictEqual(events.filter(event => event === "initialize workspace").length, 3);
  });

  it("initializes again after an initialization fails", async () => {
    const { switcher, events } = createSwitcher([new Error("failed"), true]);
    await assert.rejects(switcher.reInitialize(), /failed/);
    await switcher.reInitialize();
    assert.deepStrictEqual(events, ["initialize workspace", "initialize workspace", "workspace supported"]);
  });

  it("stops the legacy backend and doesn't initialize once disposed", async () => {
    const { switcher, events } = createSwitcher([false, false]);
    await switcher.reInitialize();
    switcher.dispose();
    assert.strictEqual(switcher.legacyBackend, undefined);
    await switcher.reInitialize();
    assert.deepStrictEqual(events, [
      "initialize workspace",
      "create legacy 1",
      "initialize legacy 1",
      "dispose legacy 1",
    ]);
  });
});

/**
 * Creates a switcher where each workspace initialization is supported or not (or fails)
 * in the order provided. With `manual`, each one only finishes once its function is called.
 */
function createSwitcher(results: (boolean | Error)[], options: { manual?: boolean } = {}) {
  const events: string[] = [];
  const workspaceInitializations: (() => void)[] = [];
  let legacyCount = 0;
  const switcher = new BackendSwitcher({
    async initializeWorkspace(onSupported) {
      events.push("initialize workspace");
      if (options.manual) {
        await new Promise<void>(resolve => workspaceInitializations.push(resolve));
      }
      const result = results.shift();
      if (result instanceof Error) {
        throw result;
      }
      if (result) {
        onSupported();
        events.push("workspace supported");
      }
      return result ?? false;
    },
    createLegacyBackend() {
      const id = ++legacyCount;
      events.push(`create legacy ${id}`);
      return {
        async reInitialize() {
          events.push(`initialize legacy ${id}`);
        },
        dispose() {
          events.push(`dispose legacy ${id}`);
        },
      };
    },
  });
  return { switcher, events, workspaceInitializations };
}

/** Waits for the pending promise callbacks and immediates to run. */
function nextTick() {
  return new Promise<void>(resolve => setImmediate(resolve));
}
