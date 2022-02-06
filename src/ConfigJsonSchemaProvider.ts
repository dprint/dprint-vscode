import * as vscode from "vscode";
import { EditorInfo } from "./executable";
import { Logger } from "./logger";
import { RacyCacheTextDownloader, TextDownloader } from "./TextDownloader";

/** Provides the dprint configuration JSON schema to vscode. */
export class ConfigJsonSchemaProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  #editorInfo: EditorInfo | undefined;
  #jsonSchemaUri = vscode.Uri.parse("dprint://schemas/config.json");
  #logger: Logger;
  #onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  #cachedTextDownloader: TextDownloader;

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

  setEditorInfo(info: EditorInfo) {
    this.#editorInfo = info;
    // always refresh to reduce complexity (it's cheap to refresh)
    this.#onDidChangeEmitter.fire(this.#jsonSchemaUri);
  }

  async provideTextDocumentContent(uri: vscode.Uri, _token: vscode.CancellationToken) {
    if (uri.toString() !== this.#jsonSchemaUri.toString()) {
      this.#logger.logWarn("Unknown uri:", uri.toString());
      return undefined;
    }

    const editorInfo = this.#editorInfo;
    const configSchema = await this.#getRawConfigSchema(editorInfo);
    configSchema["$id"] = this.#jsonSchemaUri.toString();

    if (editorInfo != null) {
      configSchema.properties = configSchema.properties ?? {};
      for (const plugin of editorInfo.plugins) {
        if (plugin.configSchemaUrl != null) {
          configSchema.properties[plugin.configKey] = {
            "$ref": plugin.configSchemaUrl,
          };
        }
      }
    }

    return formatAsJson(configSchema);
  }

  async #getRawConfigSchema(editorInfo: EditorInfo | undefined) {
    if (editorInfo == null) {
      // provide a default schema while it hasn't loaded
      return this.#getDefaultSchemaObject();
    }

    try {
      this.#logger.logVerbose("Fetching JSON schema:", editorInfo.configSchemaUrl);
      const text = await this.#cachedTextDownloader.get(editorInfo.configSchemaUrl);
      return JSON.parse(text);
    } catch (err) {
      this.#logger.logError("Error downloading config schema. Defaulting to built in schema.", err);
      return this.#getDefaultSchemaObject();
    }
  }

  #getDefaultSchemaObject() {
    return {
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
    };
  }
}

function formatAsJson(data: object) {
  return JSON.stringify(data, undefined, 2).replace(/\r?\n/, "\n");
}
