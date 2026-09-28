import * as assert from "node:assert";
import { describe, it } from "node:test";
import { DebouncedQueue } from "./DebouncedQueue";

describe("DebouncedQueue", { timeout: 5_000 }, () => {
  it("runs the action once for schedules while waiting", async () => {
    const harness = createHarness();

    const runs = [harness.queue.schedule(), harness.queue.schedule(), harness.queue.schedule()];
    assert.strictEqual(runs[1], runs[0]);
    assert.strictEqual(runs[2], runs[0]);
    await harness.finishWait();
    await Promise.all(runs);

    assert.strictEqual(harness.actionCount, 1);
  });

  it("queues one more run for schedules while the action is running", async () => {
    const harness = createHarness({ blockAction: true });

    const firstRun = harness.queue.schedule();
    await harness.finishWait();
    await harness.waitActionStarted();
    // the first run is now running the action
    const secondRun = harness.queue.schedule();
    const thirdRun = harness.queue.schedule();
    assert.strictEqual(secondRun, thirdRun);

    harness.finishAction();
    await firstRun;
    await harness.finishWait();
    await harness.waitActionStarted();
    harness.finishAction();
    await secondRun;

    assert.strictEqual(harness.actionCount, 2);
  });

  it("does not run the action before the wait finishes", async () => {
    const harness = createHarness();

    const run = harness.queue.schedule();
    await flushPromises();
    assert.strictEqual(harness.actionCount, 0);

    await harness.finishWait();
    await run;
    assert.strictEqual(harness.actionCount, 1);
  });

  it("continues running after the action fails", async () => {
    let shouldFail = true;
    const harness = createHarness({
      onAction: () => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("failed");
        }
      },
    });

    const failedRun = harness.queue.schedule();
    await harness.finishWait();
    await assert.rejects(failedRun, /failed/);

    const secondRun = harness.queue.schedule();
    await harness.finishWait();
    await secondRun;
    assert.strictEqual(harness.actionCount, 2);
  });
});

/** Creates a queue whose waits and (optionally) actions are finished manually. */
function createHarness(options: { blockAction?: boolean; onAction?: () => void } = {}) {
  const waits: Array<() => void> = [];
  const actionStarts: Array<() => void> = [];
  let pendingActionStart: Promise<void> | undefined;
  let finishActionFn: (() => void) | undefined;
  let actionCount = 0;

  function nextActionStart() {
    pendingActionStart = new Promise<void>(resolve => actionStarts.push(resolve));
  }
  nextActionStart();

  const queue = new DebouncedQueue({
    wait: () => new Promise<void>(resolve => waits.push(resolve)),
    action: async () => {
      actionCount++;
      actionStarts.shift()?.();
      options.onAction?.();
      if (options.blockAction) {
        await new Promise<void>(resolve => finishActionFn = resolve);
      }
    },
  });

  return {
    queue,
    get actionCount() {
      return actionCount;
    },
    /** Finishes the oldest pending wait once it's been requested. */
    async finishWait() {
      for (let i = 0; waits.length === 0; i++) {
        if (i === 100) {
          throw new Error("The queue never started waiting.");
        }
        await flushPromises();
      }
      waits.shift()!();
      await flushPromises();
    },
    async waitActionStarted() {
      await pendingActionStart;
      nextActionStart();
    },
    finishAction() {
      finishActionFn!();
    },
  };
}

function flushPromises() {
  return new Promise<void>(resolve => setImmediate(resolve));
}
