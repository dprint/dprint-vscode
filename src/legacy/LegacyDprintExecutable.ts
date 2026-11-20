import * as process from "node:process";
import * as vscode from "vscode";
import { DprintExecutable, type DprintExecutableOptions } from "../executable/DprintExecutable";
import type { Logger } from "../logger";
import { getCliEnv } from "./cliEnv";

export interface EditorInfo {
  schemaVersion: number;
  cliVersion: string;
  configSchemaUrl: string;
  plugins: PluginInfo[];
}

export interface PluginInfo {
  name: string;
  version: string;
  configKey: string;
  fileExtensions: string[];
  fileNames: string[];
  configSchemaUrl: string | undefined;
  helpUrl: string;
}

/** A config discovery mode supported by the cli. */
export type ConfigDiscovery = "ignore-descendants";

export interface LegacyDprintExecutableOptions extends Omit<DprintExecutableOptions, "env"> {
  configUri: vscode.Uri | undefined;
  /** The cli's config discovery mode. Defaults to the cli's default. */
  configDiscovery?: ConfigDiscovery;
  /** Whether to format again until the output is stable. Defaults to false. */
  ensureStableFormat?: boolean;
}

/** The dprint executable of a config file, which gets the editor info and starts an editor service for it. */
export class LegacyDprintExecutable {
  readonly #executable: DprintExecutable;
  readonly #cwd: vscode.Uri;
  readonly #configUri: vscode.Uri | undefined;
  readonly #verbose: boolean;
  readonly #logger: Logger;

  private constructor(executable: DprintExecutable, options: LegacyDprintExecutableOptions) {
    this.#executable = executable;
    this.#logger = options.logger;
    this.#cwd = options.cwd;
    this.#configUri = options.configUri;
    this.#verbose = options.verbose;
  }

  static async create(options: LegacyDprintExecutableOptions) {
    const executable = await DprintExecutable.create({ ...options, env: getCliEnv(process.env, options) });
    return new LegacyDprintExecutable(executable, options);
  }

  get cmdPath() {
    return this.#executable.cmdPath;
  }

  get initializationFolderUri() {
    if (this.#configUri != null) {
      return vscode.Uri.joinPath(this.#configUri, "../");
    }
    return this.#cwd;
  }

  async checkInstalled() {
    try {
      await this.#executable.execShell(["-v"], undefined, undefined);
      return true;
    } catch (err: any) {
      this.#logger.logError(`Problem launching ${this.cmdPath}.`, err);
      return false;
    }
  }

  async getEditorInfo() {
    const stdout = await this.#executable.execShell(
      ["editor-info", ...this.#getConfigArgs()],
      undefined,
      undefined,
    );
    const editorInfo = parseEditorInfo();

    if (
      !(editorInfo.plugins instanceof Array) || typeof editorInfo.schemaVersion !== "number"
      || isNaN(editorInfo.schemaVersion)
    ) {
      throw new Error("Error getting editor info. Your editor extension or dprint CLI might be out of date.");
    }

    return editorInfo;

    function parseEditorInfo() {
      try {
        return JSON.parse(stdout) as EditorInfo;
      } catch (err) {
        throw new Error(`Error parsing editor info. Output was: ${stdout}\n\nError: ${err}`);
      }
    }
  }

  spawnEditorService() {
    const currentProcessId = process.pid;
    const args = ["editor-service", "--parent-pid", currentProcessId.toString(), ...this.#getConfigArgs()];
    if (this.#verbose) {
      args.push("--verbose");
    }
    return this.#executable.spawn(args);
  }

  #getConfigArgs() {
    if (this.#configUri) {
      return ["--config", this.#configUri.fsPath];
    } else {
      return [];
    }
  }
}
