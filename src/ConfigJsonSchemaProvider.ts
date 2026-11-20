import * as vscode from "vscode";
import { getDefaultConfigSchema } from "./configSchema";
import type { Logger } from "./logger";

/** Where the provider gets the schemas from. */
export interface ConfigSchemaSource {
  /**
   * Gets the schema of the configuration files, which is the default schema when
   * it's undefined or getting it fails.
   */
  getConfigSchema(): Promise<{ [key: string]: any } | undefined>;
  /** The other uris of the provider's scheme that the config schema references. */
  readonly referencedSchemaUris?: ReadonlyArray<vscode.Uri>;
  /** Gets the schema of one of the other uris, which logs when the uri is unknown. */
  getReferencedSchema?(uri: vscode.Uri): Promise<object | undefined>;
}

/** Provides the dprint configuration JSON schema and the schemas it references to vscode. */
export class ConfigJsonSchemaProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  #source: ConfigSchemaSource | undefined;
  #logger: Logger;
  #onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();

  get onDidChange() {
    return this.#onDidChangeEmitter.event;
  }

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  static scheme = "dprint";
  static configSchemaUri = vscode.Uri.parse("dprint://schemas/config.json");

  dispose() {
    this.#onDidChangeEmitter.dispose();
  }

  /** Provides the schemas from the source, which is asked again each time vscode gets them. */
  setSource(source: ConfigSchemaSource | undefined) {
    const uris = [
      ConfigJsonSchemaProvider.configSchemaUri,
      ...this.#source?.referencedSchemaUris ?? [],
      ...source?.referencedSchemaUris ?? [],
    ];
    this.#source = source;
    // always refresh to reduce complexity (it's cheap to refresh)
    for (const uri of new Set(uris.map(uri => uri.toString()))) {
      this.#onDidChangeEmitter.fire(vscode.Uri.parse(uri));
    }
  }

  async provideTextDocumentContent(uri: vscode.Uri, _token: vscode.CancellationToken) {
    if (uri.toString() === ConfigJsonSchemaProvider.configSchemaUri.toString()) {
      return this.#provideConfigSchema();
    }
    if (this.#source?.getReferencedSchema == null) {
      this.#logger.logWarn("Unknown JSON schema uri:", uri.toString());
      return undefined;
    }
    const schema = await this.#source.getReferencedSchema(uri);
    return schema == null ? undefined : formatAsJson(schema);
  }

  async #provideConfigSchema() {
    let configSchema: { [key: string]: any } | undefined;
    try {
      configSchema = await this.#source?.getConfigSchema();
    } catch (err) {
      this.#logger.logError("Error getting the config schema. Defaulting to built in schema.", err);
    }
    configSchema ??= getDefaultConfigSchema(ConfigJsonSchemaProvider.configSchemaUri.toString());
    configSchema["$id"] = ConfigJsonSchemaProvider.configSchemaUri.toString();
    return formatAsJson(configSchema);
  }
}

function formatAsJson(data: object) {
  return JSON.stringify(data, undefined, 2).replace(/\r?\n/, "\n");
}
