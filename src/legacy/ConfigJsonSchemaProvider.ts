import * as vscode from "vscode";
import type { Logger } from "../logger";
import { RacyCacheTextDownloader, type TextDownloader } from "../utils";
import { downloadConfigSchema, getDefaultConfigSchema } from "./configSchema";
import { getPluginConfigSchema } from "./pluginConfigSchema";
import type { FolderInfos } from "./WorkspaceService";

/** Provides the dprint configuration JSON schema to vscode. */
export class ConfigJsonSchemaProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  #folderEditorInfos: FolderInfos | undefined;
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
    this.#folderEditorInfos = infos;
    // always refresh to reduce complexity (it's cheap to refresh)
    this.#onDidChangeEmitter.fire(this.#jsonSchemaUri);
  }

  async provideTextDocumentContent(uri: vscode.Uri, _token: vscode.CancellationToken) {
    if (uri.toString() !== this.#jsonSchemaUri.toString()) {
      this.#logger.logWarn("Unknown JSON schema uri:", uri.toString());
      return undefined;
    }

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
      for (const { editorInfo: info } of folderEditorInfos) {
        for (const plugin of info.plugins) {
          if (plugin.configSchemaUrl != null && configSchema.properties[plugin.configKey] == null) {
            configSchema.properties[plugin.configKey] = getPluginConfigSchema(
              plugin.configSchemaUrl,
              configSchema.additionalProperties,
            );
          }
        }
      }
    }

    return formatAsJson(configSchema);
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
