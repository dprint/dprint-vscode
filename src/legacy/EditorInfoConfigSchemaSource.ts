import * as vscode from "vscode";
import { ConfigJsonSchemaProvider, type ConfigSchemaSource } from "../ConfigJsonSchemaProvider";
import { getDefaultConfigSchema } from "../configSchema";
import type { Logger } from "../logger";
import { downloadConfigSchema } from "./configSchema";
import {
  getPluginConfigSchema,
  getPluginSchemaUri,
  getPluginSchemaUriConfigKey,
  getPluginSchemaUrls,
} from "./pluginConfigSchema";
import type { RacyCacheTextDownloader } from "./TextDownloader";

/** What the schema is provided from for each configuration file in use. */
export interface ConfigSchemaInfo {
  /** The url of the schema of the configuration file. */
  configSchemaUrl: string;
  plugins: ReadonlyArray<{ configKey: string; configSchemaUrl: string | undefined }>;
}

/** Builds the schema from the urls of the schemas of the config files and their plugins. */
export class EditorInfoConfigSchemaSource implements ConfigSchemaSource {
  readonly #configSchemaInfos: ReadonlyArray<ConfigSchemaInfo>;
  /** The url of each plugin's schema by the plugin's config key. */
  readonly #pluginSchemaUrls: ReadonlyMap<string, string>;
  readonly #logger: Logger;
  readonly #cachedTextDownloader: RacyCacheTextDownloader;

  constructor(
    infos: ReadonlyArray<ConfigSchemaInfo>,
    logger: Logger,
    cachedTextDownloader: RacyCacheTextDownloader,
  ) {
    this.#configSchemaInfos = infos;
    this.#pluginSchemaUrls = getPluginSchemaUrls(infos.map(info => info.plugins));
    this.#logger = logger;
    this.#cachedTextDownloader = cachedTextDownloader;
  }

  get referencedSchemaUris() {
    return [...this.#pluginSchemaUrls.keys()].map(configKey => vscode.Uri.parse(getPluginSchemaUri(configKey)));
  }

  async getConfigSchema() {
    const configSchema = await this.#getRawConfigSchema();
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
    return configSchema;
  }

  async getReferencedSchema(uri: vscode.Uri) {
    const configKey = uri.authority === ConfigJsonSchemaProvider.configSchemaUri.authority
      ? getPluginSchemaUriConfigKey(uri.path)
      : undefined;
    if (configKey == null) {
      this.#logger.logWarn("Unknown JSON schema uri:", uri.toString());
      return undefined;
    }
    const schemaUrl = this.#pluginSchemaUrls.get(configKey);
    if (schemaUrl == null) {
      this.#logger.logWarn("No JSON schema for plugin:", configKey);
      return undefined;
    }

    try {
      this.#logger.logDebug("Fetching plugin JSON schema:", schemaUrl);
      return await downloadConfigSchema(this.#cachedTextDownloader, schemaUrl);
    } catch (err) {
      this.#logger.logError("Error downloading plugin config schema.", err);
      // vscode then says on the config file that the schema couldn't be loaded
      throw err;
    }
  }

  async #getRawConfigSchema() {
    // compromise: settle for the first one though they'll likely always be the same
    const configSchemaUrl = this.#configSchemaInfos[0]?.configSchemaUrl;
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
    return getDefaultConfigSchema(ConfigJsonSchemaProvider.configSchemaUri.toString());
  }
}
