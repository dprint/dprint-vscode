import * as vscode from "vscode";
import { LanguageClient, type LanguageClientOptions, type ServerOptions } from "vscode-languageclient/node";
import type { ApprovedConfigPaths } from "./ApprovedConfigPaths";
import { getCombinedDprintConfig } from "./config";
import { ancestorDirsContainConfigFile, discoverWorkspaceConfigFiles } from "./configFile";
import { RealEnvironment } from "./environment";
import { DprintExecutable } from "./executable/DprintExecutable";
import type { ExtensionBackend } from "./ExtensionBackend";
import type { Logger } from "./logger";

export function activateLsp(
  logger: Logger,
  approvedPaths: ApprovedConfigPaths,
): ExtensionBackend {
  let client: LanguageClient | undefined;

  return {
    isLsp: true,
    async reInitialize() {
      const oldClient = client;
      client = undefined;
      await oldClient?.dispose(2_000);
      if (!(await workspaceHasConfigFile())) {
        logger.logInfo("Configuration file not found.");
        return;
      }
      // todo: make this handle multiple workspace folders
      const rootUri = vscode.workspace.workspaceFolders?.[0].uri;
      const config = getCombinedDprintConfig(vscode.workspace.workspaceFolders ?? []);

      const cmdPath = await DprintExecutable.resolveCmdPath({
        approvedPaths,
        pathInfo: config.pathInfo,
        cwd: rootUri!,
        configUri: undefined,
        verbose: config.verbose,
        logger,
        environment: new RealEnvironment(logger),
      });
      const args = ["lsp"];
      if (config?.verbose) {
        args.push("--verbose");
      }
      const serverOptions: ServerOptions = {
        command: cmdPath,
        args,
        options: {
          shell: true,
        },
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
      await client.start();
      logger.logInfo("Started experimental language server.");
    },
    async dispose() {
      const oldClient = client;
      client = undefined;
      await oldClient?.dispose(2_000);
    },
  };

  async function workspaceHasConfigFile() {
    const configFiles = await discoverWorkspaceConfigFiles({
      maxResults: 1,
      logger,
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
}
