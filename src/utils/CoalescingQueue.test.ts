import * as assert from "node:assert";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { CoalescingQueue } from "./CoalescingQueue";

describe("CoalescingQueue", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it("runs the action once for schedules while waiting", async () => {
    let actionCount = 0;
    const queue = createQueue(async () => {
      actionCount++;
    });

    const runs = [queue.schedule(), queue.schedule(), queue.schedule()];
    assert.strictEqual(runs[1], runs[0]);
    assert.strictEqual(runs[2], runs[0]);
    await tick(100);
    await Promise.all(runs);

    assert.strictEqual(actionCount, 1);
  });

  it("does not run the action before the wait finishes", async () => {
    let actionCount = 0;
    const queue = createQueue(async () => {
      actionCount++;
    });

    const run = queue.schedule();
    await tick(99);
    assert.strictEqual(actionCount, 0);
    await tick(1);
    await run;
    assert.strictEqual(actionCount, 1);
  });

  it("queues one more run for schedules while the action is running", async () => {
    let actionCount = 0;
    let finishAction = () => {};
    const queue = createQueue(async () => {
      actionCount++;
      await new Promise<void>(resolve => finishAction = resolve);
    });

    const firstRun = queue.schedule();
    await tick(100);
    assert.strictEqual(actionCount, 1);
    // the first run is now running the action
    const secondRun = queue.schedule();
    assert.strictEqual(queue.schedule(), secondRun);
    finishAction();
    await firstRun;

    await tick(100);
    assert.strictEqual(actionCount, 2);
    finishAction();
    await secondRun;
  });

  it("continues running after the action fails", async () => {
    let actionCount = 0;
    const queue = createQueue(async () => {
      actionCount++;
      if (actionCount === 1) {
        throw new Error("failed");
      }
    });

    const failedRun = queue.schedule();
    await tick(100);
    await assert.rejects(failedRun, /failed/);

    const secondRun = queue.schedule();
    await tick(100);
    await secondRun;
    assert.strictEqual(actionCount, 2);
  });
});

function createQueue(action: () => Promise<void>) {
  return new CoalescingQueue({
    action,
    wait: () => new Promise<void>(resolve => setTimeout(resolve, 100)),
  });
}

/** Advances the mocked time, letting the queue start and finish its waits. */
async function tick(ms: number) {
  await flushPromises();
  mock.timers.tick(ms);
  await flushPromises();
}

function flushPromises() {
  return new Promise<void>(resolve => setImmediate(resolve));
}
