import { Disposable } from "vscode";
import { Logger } from "../logger";

interface ExtendedDisposable extends Disposable {
  stop(): Promise<void>;
}

/**
 * ActivatedDisposables
 *
 * A utility class to manage disposables created during the `activate` lifecycle.
 * Automatically disposes all registered resources when the parent is disposed.
 */
export class ActivatedDisposables {
  readonly #resourceStores: Disposable[] = [];
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  push(...disposables: Disposable[]) {
    this.#resourceStores.push(...disposables);
  }

  dispose() {
    for (const disposable of this.#resourceStores) {
      try {
        disposable.dispose();
      } catch (err) {
        this.#logger.logWarn("Dispose failed (sync):", err);
      }
    }
    this.#resourceStores.length = 0;
  }

  async disposeAsync(timeoutMs = 2000): Promise<void> {
    const results = await Promise.allSettled(
      this.#resourceStores.map(d => this.#disposeWithStopSupport(d, timeoutMs)),
    );
    this.#resourceStores.length = 0;

    for (const res of results) {
      if (res.status === "rejected") {
        this.#logger.logWarn("Dispose failed (async):", res.reason);
      }
    }
  }

  async #disposeWithStopSupport(
    disposable: Disposable,
    timeoutMs: number,
  ): Promise<void> {
    try {
      if (isExtendedDisposable(disposable)) {
        await Promise.race([
          disposable.stop(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Stop timeout exceeded")), timeoutMs)),
        ]);
      }

      const result = disposable.dispose();
      if (result instanceof Promise) {
        await Promise.race([
          result,
          new Promise((_, reject) => setTimeout(() => reject(new Error("Dispose timeout exceeded")), timeoutMs)),
        ]);
      }
    } catch (err) {
      this.#logger.logWarn("Failed to dispose/stop resource:", err);
    }
  }
}

function isExtendedDisposable(disposable: unknown): disposable is ExtendedDisposable {
  return disposable != null
    && typeof disposable === "object"
    && "stop" in disposable
    && typeof disposable.stop === "function";
}
