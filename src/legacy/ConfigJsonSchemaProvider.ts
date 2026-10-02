import * as vscode from "vscode";
import type { Logger } from "../logger";
import { RacyCacheTextDownloader, type TextDownloader } from "../utils";
import { downloadConfigSchema, getDefaultConfigSchema } from "./configSchema";
import {
  getPluginConfigSchema,
  getPluginSchemaUri,
  getPluginSchemaUriConfigKey,
  getPluginSchemaUrls,
} from "./pluginConfigSchema";
import type { FolderInfos } from "./WorkspaceService";

/** Provides the dprint configuration JSON schema and the schemas of the plugins it references to vscode. */
export class ConfigJsonSchemaProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  #folderEditorInfos: FolderInfos | undefined;
  /** The url of each plugin's schema by the plugin's config key. */
  #pluginSchemaUrls: ReadonlyMap<string, string> = new Map();
  #jsonSchemaUri = vscode.Uri.parse("dprint://schemas/config.json");
  #logger: Logger;
  #onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  #cachedTextDownloader: RacyCacheTextDownloader;

  get onDidChange() {
    return this.#onDidChangeEmitter.event;
  }

  constructor(logger: Logger, textDownloader: TextDownloader) {
    this.#logger = logger;
    this.#cachedTextDownloader = new RacyCacheTextDownloader(textDownloader);
  }

  static scheme = "dprint";

  dispose() {
    this.#onDidChangeEmitter.dispose();
  }

  setFolderInfos(infos: FolderInfos | undefined) {
    const previousPluginSchemaUrls = this.#pluginSchemaUrls;
    this.#folderEditorInfos = infos;
    this.#pluginSchemaUrls = getPluginSchemaUrls(infos?.map(info => info.editorInfo.plugins) ?? []);
    // always refresh to reduce complexity (it's cheap to refresh)
    this.#onDidChangeEmitter.fire(this.#jsonSchemaUri);
    for (const configKey of new Set([...previousPluginSchemaUrls.keys(), ...this.#pluginSchemaUrls.keys()])) {
      this.#onDidChangeEmitter.fire(vscode.Uri.parse(getPluginSchemaUri(configKey)));
    }
  }

  async provideTextDocumentContent(uri: vscode.Uri, _token: vscode.CancellationToken) {
    if (uri.toString() === this.#jsonSchemaUri.toString()) {
      return this.#provideConfigSchema();
    }
    const pluginConfigKey = uri.authority === this.#jsonSchemaUri.authority
      ? getPluginSchemaUriConfigKey(uri.path)
      : undefined;
    if (pluginConfigKey != null) {
      return this.#providePluginSchema(pluginConfigKey);
    }
    this.#logger.logWarn("Unknown JSON schema uri:", uri.toString());
    return undefined;
  }

  async #provideConfigSchema() {
    const folderEditorInfos = this.#folderEditorInfos;
    const configSchema = await this.#getRawConfigSchema(folderEditorInfos);
    configSchema["$id"] = this.#jsonSchemaUri.toString();

    if (folderEditorInfos != null) {
      configSchema.properties = configSchema.properties ?? {};
      // compromise: between workspace folders, the same plugin might appear
      // with a different version. We compromise by selecting the first plugin
      // found to be the one used, but perhaps an improvement would be to use
      // the latest plugin version found. This would be a bit more complex to
      // figure out though.
      for (const configKey of this.#pluginSchemaUrls.keys()) {
        if (configSchema.properties[configKey] == null) {
          // vscode only downloads schemas from the domains the user trusts, so
          // reference a uri of this provider, which downloads the plugin's schema
          configSchema.properties[configKey] = getPluginConfigSchema(
            getPluginSchemaUri(configKey),
            configSchema.additionalProperties,
          );
        }
      }
    }

    return formatAsJson(configSchema);
  }

  async #providePluginSchema(configKey: string) {
    const schemaUrl = this.#pluginSchemaUrls.get(configKey);
    if (schemaUrl == null) {
      this.#logger.logWarn("No JSON schema for plugin:", configKey);
      return undefined;
    }

    try {
      this.#logger.logDebug("Fetching plugin JSON schema:", schemaUrl);
      return formatAsJson(await downloadConfigSchema(this.#cachedTextDownloader, schemaUrl));
    } catch (err) {
      this.#logger.logError("Error downloading plugin config schema.", err);
      // vscode then says on the config file that the schema couldn't be loaded
      throw err;
    }
  }

  async #getRawConfigSchema(folderEditorInfos: FolderInfos | undefined) {
    // compromise: settle for the first one though they'll likely always be the same
    const configSchemaUrl = folderEditorInfos?.[0]?.editorInfo?.configSchemaUrl;
    if (configSchemaUrl == null) {
      // provide a default schema while it hasn't loaded
      return this.#getDefaultSchemaObject();
    }

    try {
      this.#logger.logDebug("Fetching JSON schema:", configSchemaUrl);
      return await downloadConfigSchema(this.#cachedTextDownloader, configSchemaUrl);
    } catch (err) {
      this.#logger.logError("Error downloading config schema. Defaulting to built in schema.", err);
      return this.#getDefaultSchemaObject();
    }
  }

  #getDefaultSchemaObject(): { [key: string]: any } {
    return getDefaultConfigSchema(this.#jsonSchemaUri.toString());
  }
}

function formatAsJson(data: object) {
  return JSON.stringify(data, undefined, 2).replace(/\r?\n/, "\n");
}
