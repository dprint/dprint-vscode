import { Disposable } from "vscode";
import { Logger } from "../logger";

type ExtendedDisposable = Disposable & {
  stop?: () => Promise<void>;
};

/**
 * ActivatedDisposables
 *
 * A utility class to manage disposables created during the `activate` lifecycle.
 * Automatically disposes all registered resources when the parent is disposed.
 */
export class ActivatedDisposables {
  private readonly _resourceStores: Disposable[] = [];
  private readonly _logger = Logger.getLogger();

  public push(...disposables: Disposable[]) {
    this._resourceStores.push(...disposables);
  }

  public dispose() {
    for (const disposable of this._resourceStores) {
      try {
        disposable.dispose();
      } catch (err) {
        this._logger.logWarn("Dispose failed (sync):", err);
      }
    }
    this._resourceStores.length = 0;
  }

  public async disposeAsync(timeoutMs = 2000): Promise<void> {
    const results = await Promise.allSettled(
      this._resourceStores.map(d => this.#disposeWithStopSupport(d as ExtendedDisposable, timeoutMs)),
    );
    this._resourceStores.length = 0;

    for (const res of results) {
      if (res.status === "rejected") {
        this._logger.logWarn("Dispose failed (async):", res.reason);
      }
    }
  }

  async #disposeWithStopSupport(
    disposable: ExtendedDisposable,
    timeoutMs: number,
  ): Promise<void> {
    try {
      if (typeof disposable.stop === "function") {
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
      this._logger.logWarn("Failed to dispose/stop resource:", err);
    }
  }
}

export default ActivatedDisposables;
