import * as vscode from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from "vscode-languageclient/node";
import { getCombinedDprintConfig, getDprintConfig } from "./config";
import { DPRINT_CONFIG_FILEPATH_GLOB } from "./constants";
import { DprintExecutable } from "./DprintExecutable";
import type { ExtensionBackend } from "./ExtensionBackend";
import { Logger } from "./logger";

export function activateLsp(
  _context: vscode.ExtensionContext,
  logger: Logger,
  outputChannel: vscode.OutputChannel,
): ExtensionBackend {
  let client: LanguageClient | undefined;

  return {
    isLsp: true,
    async reInitialize() {
      await client?.stop(2_000);
      client = undefined;
      // todo: make this handle multiple workspace folders
      const rootUri = vscode.workspace.workspaceFolders?.[0].uri;
      const config = getCombinedDprintConfig(vscode.workspace.workspaceFolders ?? []);
      const cmdPath = await DprintExecutable.resolveCmdPath({
        cmdPath: config?.path,
        cwd: rootUri,
      });
      const args = ["lsp"];
      if (config?.verbose) {
        args.push("--verbose");
      }
      const serverOptions: ServerOptions = {
        command: cmdPath ?? "dprint",
        args,
      };
      const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: "file" }],
        outputChannel,
      };
      client = new LanguageClient(
        "dprint",
        serverOptions,
        clientOptions,
      );
      await client.start();
      logger.logInfo("Started experimental language server.");
    },
    async dispose() {
      await client?.stop(2_000);
      await client?.dispose(2_000);
      client = undefined;
    },
  };
}
