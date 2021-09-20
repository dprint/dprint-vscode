import axios from "axios";
import * as vscode from "vscode";
import { Config } from "./editor-service/configuration";
import { Logger } from "./logger";

/** Provides the dprint configuration JSON schema to vscode. */
export class ConfigJsonSchemaProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  #cache: Map<string, string> = new Map();
  #workspaceConfig: Config | undefined;
  #jsonSchemaUri = vscode.Uri.parse("dprint://schemas/config.json");
  #logger: Logger;
  #onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();

  get onDidChange() {
    return this.#onDidChangeEmitter.event;
  }

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  static scheme = "dprint";

  dispose() {
    this.#onDidChangeEmitter.dispose();
  }

  setEditorInfo(info: Config) {
    this.#workspaceConfig = info;
    // always refresh to reduce complexity (it's cheap to refresh)
    this.#onDidChangeEmitter.fire(this.#jsonSchemaUri);
  }

  async provideTextDocumentContent(uri: vscode.Uri, _token: vscode.CancellationToken) {
    if (uri.toString() !== this.#jsonSchemaUri.toString()) {
      this.#logger.logWarn("Unknown uri:", uri.toString());
      return undefined;
    }

    const config = this.#workspaceConfig;
    if (config == null) {
      // provide a default schema while it hasn't loaded
      return this.#getDefaultSchemaText();
    }

    try {
      this.#logger.logVerbose("Fetching JSON schema...");
      const configSchema = await this.#getUrl(config["$schema"]);
      configSchema["$id"] = this.#jsonSchemaUri.toString();

      // TODO: implement
      // for (const plugin of config.plugins) {
      //   if (plugin.configSchemaUrl != null) {
      //     configSchema.properties[plugin.configKey] = {
      //       "$ref": plugin.configSchemaUrl,
      //     };
      //   }
      // }

      return formatAsJson(configSchema);
    } catch (err) {
      this.#logger.logError("Error downloading config schema. Defaulting to built in schema.", err);
      return this.#getDefaultSchemaText();
    }
  }

  async #getUrl(url: string) {
    // don't worry about race conditions here as making two
    // or more of the same request is not a big deal
    let text = this.#cache.get(url);

    if (text == null) {
      // store an immutable snapshot
      text = JSON.stringify(await axios.get(url).then(r => r.data));
      this.#cache.set(url, text);
    }

    return JSON.parse(text);
  }

  #getDefaultSchemaText() {
    return formatAsJson({
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: this.#jsonSchemaUri.toString(),
      title: "dprint configuration file",
      description: "Schema for a dprint configuration file.",
      type: "object",
      properties: {
        incremental: {
          description:
            "Whether to format files only when they change. Setting this to `true` will dramatically speed up formatting.",
          type: "boolean",
          default: false,
        },
        extends: {
          description: "Configurations to extend.",
          anyOf: [{
            description: "A file path or url to a configuration file to extend.",
            type: "string",
          }, {
            description: "A collection of file paths and/or urls to configuration files to extend.",
            type: "array",
            items: {
              type: "string",
            },
          }],
        },
        lineWidth: {
          description:
            "The width of a line the printer will try to stay under. Note that the printer may exceed this width in certain cases.",
          type: "number",
          default: 120,
        },
        indentWidth: {
          description: "The number of characters for an indent.",
          type: "number",
          default: 4,
        },
        useTabs: {
          description: "Whether to use tabs (true) or spaces (false) for indentation.",
          type: "boolean",
          default: false,
        },
        newLineKind: {
          description: "The kind of newline to use.",
          type: "string",
          oneOf: [{
            const: "auto",
            description: "For each file, uses the newline kind found at the end of the last line.",
          }, {
            const: "crlf",
            description: "Uses carriage return, line feed.",
          }, {
            const: "lf",
            description: "Uses line feed.",
          }, {
            const: "system",
            description: "Uses the system standard (ex. crlf on Windows).",
          }],
        },
        includes: {
          description: "Array of patterns (globs) to use to find files to format.",
          type: "array",
          items: {
            type: "string",
          },
        },
        excludes: {
          description: "Array of patterns (globs) to exclude files or directories to format.",
          type: "array",
          items: {
            type: "string",
          },
        },
        plugins: {
          description: "Array of plugin URLs to format files.",
          type: "array",
          items: {
            type: "string",
          },
        },
      },
      additionalProperties: {
        description: "Plugin configuration.",
        type: "object",
      },
    });
  }
}

function formatAsJson(data: object) {
  return JSON.stringify(data, undefined, 2).replace(/\r?\n/, "\n");
}
