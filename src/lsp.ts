import * as process from "node:process";
import * as vscode from "vscode";
import { LanguageClient, type LanguageClientOptions, type ServerOptions } from "vscode-languageclient/node";
import type { ApprovedConfigPaths } from "./ApprovedConfigPaths";
import { getCombinedDprintConfig } from "./config";
import { ancestorDirsContainConfigFile, discoverWorkspaceConfigFiles } from "./configFile";
import { RealEnvironment } from "./environment";
import { getCliEnv } from "./executable/cliEnv";
import { getCommandLaunchInfo } from "./executable/command";
import { DprintExecutable } from "./executable/DprintExecutable";
import type { ExtensionBackend } from "./ExtensionBackend";
import { ConfigJsonSchemaProvider } from "./legacy/ConfigJsonSchemaProvider";
import type { Logger } from "./logger";

export function activateLsp(
  logger: Logger,
  approvedPaths: ApprovedConfigPaths,
): ExtensionBackend {
  let client: LanguageClient | undefined;
  // the package.json associates dprint config files with this schema, so provide an
  // empty one to prevent vscode erroring that it can't load it (the language server
  // provides completions and hover for config files instead)
  const emptySchemaProvider = vscode.workspace.registerTextDocumentContentProvider(
    ConfigJsonSchemaProvider.scheme,
    { provideTextDocumentContent: () => "{}" },
  );

  const backend: ExtensionBackend = {
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

      const command = await DprintExecutable.resolveCommand({
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
      const launchInfo = getCommandLaunchInfo(command, args, process.platform);
      const serverOptions: ServerOptions = {
        command: launchInfo.command,
        args: launchInfo.args,
        options: {
          env: getCliEnv(process.env, { ensureStableFormat: config.ensureStableFormat }),
          shell: launchInfo.shell,
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
    async onConfigFileChanged() {
      // the language server resolves the config file on each
      // format request, so it picks up the changes itself
    },
    async dispose() {
      emptySchemaProvider.dispose();
      const oldClient = client;
      client = undefined;
      await oldClient?.dispose(2_000);
    },
  };
  return backend;

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
