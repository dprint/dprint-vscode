import * as vscode from "vscode";
import { LanguageClient, type LanguageClientOptions, type ServerOptions } from "vscode-languageclient/node";
import type { ApprovedConfigPaths } from "./ApprovedConfigPaths";
import { getCombinedDprintConfig } from "./config";
import { ancestorDirsContainConfigFile, discoverWorkspaceConfigFiles } from "./configFile";
import { RealEnvironment } from "./environment";
import { DprintExecutable } from "./executable/DprintExecutable";
import type { ExtensionBackend } from "./ExtensionBackend";
import type { Logger } from "./logger";
import { ActivatedDisposables } from "./utils";

export function activateLsp(
  logger: Logger,
  approvedPaths: ApprovedConfigPaths,
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

      // prompt for approval if using a workspace-configured path
      const approved = await approvedPaths.promptForApproval(config.pathInfo);
      if (!approved) {
        logger.logWarn("Custom dprint path was not approved by user.");
        return;
      }

      const cmdPath = await DprintExecutable.resolveCmdPath({
        cmdPath: config.pathInfo?.path,
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
      resourceStores.push(client);
      await client.start();
      logger.logInfo("Started experimental language server.");
    },
    async dispose() {
      resourceStores.dispose();
      client = undefined;
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
