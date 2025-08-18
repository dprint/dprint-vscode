import * as vscode from "vscode";
import { LanguageClient, type LanguageClientOptions, type ServerOptions } from "vscode-languageclient/node";
import { getCombinedDprintConfig } from "./config";
import { ancestorDirsContainConfigFile, discoverWorkspaceConfigFiles } from "./configFile";
import { RealEnvironment } from "./environment";
import { DprintExecutable } from "./executable/DprintExecutable";
import type { ExtensionBackend } from "./ExtensionBackend";
import type { Logger } from "./logger";
import { ActivatedDisposables } from "./utils";

export function activateLsp(
  _context: vscode.ExtensionContext,
  logger: Logger,
): ExtensionBackend {
  const resourceStores = new ActivatedDisposables(logger);
  let client: LanguageClient | undefined;

  return {
    isLsp: true,
    async reInitialize() {
      await client?.stop(2_000);
      client = undefined;
      if (!(await workspaceHasConfigFile())) {
        logger.logInfo("Configuration file not found.");
        return;
      }
      // todo: make this handle multiple workspace folders
      const rootUri = vscode.workspace.workspaceFolders?.[0].uri;
      const config = getCombinedDprintConfig(vscode.workspace.workspaceFolders ?? []);
      const cmdPath = await DprintExecutable.resolveCmdPath({
        cmdPath: config?.path,
        cwd: rootUri,
        logger,
        environment: new RealEnvironment(logger),
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
        outputChannel: logger.getOutputChannel(),
      };
      client = new LanguageClient(
        "dprint",
        serverOptions,
        clientOptions,
      );
      resourceStores.push(client);
      await client.start();
      logger.logInfo("Started experimental language server.");
    },
    async dispose() {
      resourceStores.dispose();
      client = undefined;
    },
  };
}

async function workspaceHasConfigFile() {
  const configFiles = await discoverWorkspaceConfigFiles({
    maxResults: 1,
  });
  if (configFiles.length > 0) {
    return true;
  }
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder == null) {
    return false;
  }
  return ancestorDirsContainConfigFile(workspaceFolder.uri);
}
