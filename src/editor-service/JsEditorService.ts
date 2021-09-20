import { createFromBuffer, Formatter, PluginInfo } from "@dprint/formatter";
import * as fetch from "isomorphic-fetch";
import * as path from "path";
import * as vscode from "vscode";
import { Logger } from "../logger";
import { Config } from "./configuration";
import { EditorService } from "./EditorService";

export class JsFormatter implements EditorService {
  private readonly formatters: Formatter[];
  private readonly logger: Logger;

  static async fromPluginUrls(
    logger: Logger,
    urls: string[],
    config: Config,
  ): Promise<JsFormatter> {
    const buffers = await Promise.all(
      urls.map((u) => fetch(u).then((resp: any) => resp.arrayBuffer())),
    );
    const formatters = buffers.map(createFromBuffer);
    formatters.forEach((formatter) => {
      const configKey = formatter.getPluginInfo().configKey;
      const pluginConfig = (config as any)[configKey] as Record<string, unknown> | undefined ?? {};
      formatter.setConfig(config, pluginConfig);
    });
    logger.logInfo("got formatters", formatters);
    return new JsFormatter(logger, formatters);
  }

  constructor(logger: Logger, plugins: Formatter[]) {
    this.formatters = plugins;
    this.logger = logger;
  }

  canFormat(filePath: string): Promise<boolean> {
    const formatter = this.findFormatter(filePath);
    return Promise.resolve(formatter !== null);
  }

  private findFormatter(filePath: string): Formatter | null {
    for (const formatter of this.formatters) {
      const filepathExtension = path.parse(filePath).ext.replace(".", "");

      const formatterInfo = formatter.getPluginInfo();

      const fileExtensionMatch = formatterInfo.fileExtensions.some(
        (extension) => extension.match(filepathExtension) !== null,
      );
      if (fileExtensionMatch) {
        return formatter;
      }
      const fileNameMatch = formatterInfo.fileNames.some(
        (name) => name.match(filePath) !== null,
      );
      if (fileNameMatch) {
        this.logger.logInfo("file name matched", fileNameMatch);
        return formatter;
      }
    }
    this.logger.logInfo("a valid formatter not found for file", filePath);
    return null;
  }

  kill(): void {}

  async formatText(
    filePath: string,
    fileText: string,
    _token: vscode.CancellationToken,
  ): Promise<string> {
    this.logger.logInfo("formatting file", filePath);

    const formatter = this.findFormatter(filePath);
    const text = formatter?.formatText(filePath, fileText);
    if (text === undefined) {
      throw new Error(
        `failed to format text: path = ${filePath}, text = ${fileText}`,
      );
    }
    return text;
  }

  plugInfo(): PluginInfo[] {
    return this.formatters.map((formatter) => formatter.getPluginInfo());
  }
}
