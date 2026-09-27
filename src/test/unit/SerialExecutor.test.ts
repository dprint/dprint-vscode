import * as assert from "node:assert/strict";
import test from "node:test";
import { SerialExecutor } from "../../legacy/editor-service/common/SerialExecutor";

test("SerialExecutor runs asynchronous work in submission order", async () => {
  const executor = new SerialExecutor();
  const events: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const first = executor.execute(async () => {
    events.push("first-start");
    await new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    events.push("first-end");
    return 1;
  });
  const second = executor.execute(async () => {
    events.push("second");
    return 2;
  });

  assert.deepEqual(events, ["first-start"]);
  releaseFirst?.();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(events, ["first-start", "first-end", "second"]);
  assert.equal(executor.isEmpty(), true);
});

test("SerialExecutor rejects queued work when cleared", async () => {
  const executor = new SerialExecutor();
  let releaseFirst: (() => void) | undefined;
  const first = executor.execute(async () => {
    await new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
  });
  const queued = executor.execute(async () => "not reached");

  executor.clear();
  await Promise.all([first, queued].map(promise =>
    promise.then(
      () => assert.fail("Expected queued work to be cancelled."),
      reason => assert.equal(reason, "Cancelling all pending tasks."),
    )
  ));
  releaseFirst?.();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(executor.isEmpty(), true);
});
