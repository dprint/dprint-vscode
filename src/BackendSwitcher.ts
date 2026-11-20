// note: this file should not import "vscode" so that it can be unit tested

/** The parts of a backend that are used, which is a subset so this can be unit tested. */
export interface SwitchableBackend {
  reInitialize(options?: ReInitializeOptions): Promise<void>;
  dispose(): void;
}

export interface ReInitializeOptions {
  /** Whether to start new dprint processes (ex. for the restart command). */
  restart?: boolean;
}

export interface BackendSwitcherOptions<TLegacyBackend extends SwitchableBackend> {
  /**
   * Initializes the backend that uses dprint's language server, which is false when
   * the dprint executable in use doesn't support it.
   *
   * @param onSupported - Called once it's supported and ready, right before it
   * registers the formatter.
   */
  initializeWorkspace(onSupported: () => void, options: ReInitializeOptions): Promise<boolean>;
  /** Creates the legacy backend, which uses schema version 5 of dprint's editor service. */
  createLegacyBackend(): TLegacyBackend;
}

/**
 * Initializes the backend that uses dprint's language server or falls back to the legacy backend
 * when it's not supported, which is checked again on each initialization.
 */
export class BackendSwitcher<TLegacyBackend extends SwitchableBackend> {
  readonly #options: BackendSwitcherOptions<TLegacyBackend>;
  #legacyBackend: TLegacyBackend | undefined;
  // the initializations run one at a time because each one may switch the backend
  #initialization = Promise.resolve();
  /** The initialization that's waiting on the current one, which the later requests use too. */
  #queuedInitialization: Promise<void> | undefined;
  /** The options of the queued initialization, which has what any of its requests asked for. */
  #queuedOptions: ReInitializeOptions = {};
  #disposed = false;

  constructor(options: BackendSwitcherOptions<TLegacyBackend>) {
    this.#options = options;
  }

  /** The legacy backend when it's the one in use. */
  get legacyBackend() {
    return this.#legacyBackend;
  }

  reInitialize(options: ReInitializeOptions = {}) {
    this.#queuedOptions = { restart: this.#queuedOptions.restart || options.restart };
    // the queued initialization hasn't started, so it covers this request too
    if (this.#queuedInitialization != null) {
      return this.#queuedInitialization;
    }
    const result = this.#initialization.then(() => {
      const options = this.#queuedOptions;
      this.#queuedInitialization = undefined;
      this.#queuedOptions = {};
      return this.#initialize(options);
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

  async #initialize(options: ReInitializeOptions) {
    if (this.#disposed) {
      return;
    }
    const isSupported = await this.#options.initializeWorkspace(() => {
      // stop the legacy backend before the formatter is registered again
      this.#legacyBackend?.dispose();
      this.#legacyBackend = undefined;
    }, options);
    if (!isSupported && !this.#disposed) {
      this.#legacyBackend ??= this.#options.createLegacyBackend();
      await this.#legacyBackend.reInitialize(options);
    }
  }
}
