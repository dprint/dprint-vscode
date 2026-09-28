// note: this file should not import "vscode" so that it can be unit tested

export interface CoalescingQueueOptions {
  action: () => Promise<void>;
  /** Waits before running the action so that schedules in quick succession run it once. */
  wait: () => Promise<void>;
}

/**
 * Runs an action one at a time after a wait. Scheduling while a run is waiting
 * joins that run and scheduling while the action is running queues one more run.
 */
export class CoalescingQueue {
  readonly #action: () => Promise<void>;
  readonly #wait: () => Promise<void>;
  #queue = Promise.resolve();
  #pendingRun: Promise<void> | undefined;

  constructor(options: CoalescingQueueOptions) {
    this.#action = options.action;
    this.#wait = options.wait;
  }

  /** Schedules the action, resolving or rejecting when that run of the action completes. */
  schedule(): Promise<void> {
    if (this.#pendingRun != null) {
      return this.#pendingRun;
    }
    const run = this.#queue.then(async () => {
      await this.#wait();
      this.#pendingRun = undefined;
      await this.#action();
    });
    this.#pendingRun = run;
    // keep the queue going when a run fails
    this.#queue = run.catch(() => {/* ignore */});
    return run;
  }
}
