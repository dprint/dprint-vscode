// note: this file should not import "vscode" so that it can be unit tested

/** The parts of a backend that are used, which is a subset so this can be unit tested. */
export interface SwitchableBackend {
  reInitialize(): Promise<void>;
  dispose(): void;
}

export interface BackendSwitcherOptions<TLegacyBackend extends SwitchableBackend> {
  /**
   * Initializes the backend of schema version 6, which is false when one of the
   * dprint executables in use doesn't support it.
   *
   * @param onSupported - Called once it's supported and ready, right before it
   * registers the formatter.
   */
  initializeWorkspace(onSupported: () => void): Promise<boolean>;
  /** Creates the legacy backend, which uses schema version 5. */
  createLegacyBackend(): TLegacyBackend;
}

/**
 * Initializes the backend of schema version 6 or falls back to the legacy backend
 * when it's not supported, which is checked again on each initialization.
 */
export class BackendSwitcher<TLegacyBackend extends SwitchableBackend> {
  readonly #options: BackendSwitcherOptions<TLegacyBackend>;
  #legacyBackend: TLegacyBackend | undefined;
  // the initializations run one at a time because each one may switch the backend
  #initialization = Promise.resolve();
  /** The initialization that's waiting on the current one, which the later requests use too. */
  #queuedInitialization: Promise<void> | undefined;
  #disposed = false;

  constructor(options: BackendSwitcherOptions<TLegacyBackend>) {
    this.#options = options;
  }

  /** The legacy backend when it's the one in use. */
  get legacyBackend() {
    return this.#legacyBackend;
  }

  reInitialize() {
    // the queued initialization hasn't started, so it covers this request too
    if (this.#queuedInitialization != null) {
      return this.#queuedInitialization;
    }
    const result = this.#initialization.then(() => {
      this.#queuedInitialization = undefined;
      return this.#initialize();
    });
    this.#queuedInitialization = result;
    this.#initialization = result.catch(() => {/* ignore */});
    return result;
  }

  dispose() {
    this.#disposed = true;
    this.#legacyBackend?.dispose();
    this.#legacyBackend = undefined;
  }

  async #initialize() {
    if (this.#disposed) {
      return;
    }
    const isSupported = await this.#options.initializeWorkspace(() => {
      // stop the legacy backend before the formatter is registered again
      this.#legacyBackend?.dispose();
      this.#legacyBackend = undefined;
    });
    if (!isSupported && !this.#disposed) {
      this.#legacyBackend ??= this.#options.createLegacyBackend();
      await this.#legacyBackend.reInitialize();
    }
  }
}
