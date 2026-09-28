import * as path from "node:path";
import * as process from "node:process";
import * as vscode from "vscode";
import { LanguageClient, type LanguageClientOptions, type ServerOptions } from "vscode-languageclient/node";
import type { ApprovedConfigPaths } from "./ApprovedConfigPaths";
import { type DprintExtensionConfig, getCombinedDprintConfig, getDprintConfig } from "./config";
import { findConfigFileInAncestorDirectoriesPath, getFileSystemRootPath } from "./configPaths";
import { RealEnvironment } from "./environment";
import { DprintExecutable } from "./executable/DprintExecutable";
import type { ExtensionBackend } from "./ExtensionBackend";
import type { Logger } from "./logger";

export function activateLsp(
  logger: Logger,
  approvedPaths: ApprovedConfigPaths,
): ExtensionBackend {
  let client: LanguageClient | undefined;
  let clientGeneration = 0;
  let launchRootUri: vscode.Uri | undefined;
  const availableGlobalConfigs = new Set<string>();
  const pendingGlobalConfigProbes = new Map<string, Promise<boolean>>();

  const backend: ExtensionBackend = {
    isLsp: true,
    async reInitialize() {
      const generation = ++clientGeneration;
      const oldClient = client;
      client = undefined;
      await oldClient?.dispose(2_000);
      availableGlobalConfigs.clear();
      pendingGlobalConfigProbes.clear();

      const workspaceUri = vscode.workspace.workspaceFolders?.[0].uri;
      const executableSearchUri = workspaceUri ?? vscode.Uri.file(process.cwd());
      const resolveNpmExecutable = workspaceUri != null;
      launchRootUri = vscode.Uri.file(getFileSystemRootPath(executableSearchUri.fsPath));
      const config = getCombinedDprintConfig(vscode.workspace.workspaceFolders ?? []);

      const cmdPath = await DprintExecutable.resolveCmdPath({
        approvedPaths,
        pathInfo: config.pathInfo,
        cwd: launchRootUri,
        executableSearchUri,
        configUri: undefined,
        resolveNpmExecutable,
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
          cwd: launchRootUri.fsPath,
          shell: true,
        },
      };
      const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: "file" }],
        outputChannel: logger.getOutputChannel(),
        middleware: {
          async provideDocumentFormattingEdits(document, options, token, next) {
            // Formatting providers may still receive requests while their
            // language client is being disposed. Do not ask an obsolete client
            // to restart itself while its replacement is initializing.
            if (generation !== clientGeneration) {
              return [];
            }
            if (document.uri.scheme !== "file") {
              return next(document, options, token);
            }

            const configPath = findConfigFileInAncestorDirectoriesPath(path.dirname(document.uri.fsPath));
            if (configPath != null) {
              return next(document, options, token);
            }
            if (!getDprintConfig(document.uri).useGlobalConfig) {
              return [];
            }

            const documentRootUri = vscode.Uri.file(getFileSystemRootPath(document.uri.fsPath));
            if (documentRootUri.fsPath !== launchRootUri?.fsPath) {
              notifyUnavailable(
                document.uri,
                "Global dprint configuration cannot be applied across filesystem roots in one LSP session.",
              );
              return [];
            }

            const globalConfigAvailable = await hasGlobalConfig(
              documentRootUri,
              executableSearchUri,
              resolveNpmExecutable,
              config,
            );
            if (token.isCancellationRequested) {
              return [];
            }
            if (!globalConfigAvailable) {
              notifyUnavailable(document.uri, "No usable ancestor or global dprint configuration was found.");
              return [];
            }
            return next(document, options, token);
          },
        },
      };
      client = new LanguageClient(
        "dprint",
        serverOptions,
        clientOptions,
      );
      await client.start();
      logger.logInfo("Started experimental language server.");
    },
    onConfigFileChanged() {
      // the language server is restarted to pick up config changes
      return backend.reInitialize();
    },
    async dispose() {
      clientGeneration++;
      const oldClient = client;
      client = undefined;
      await oldClient?.dispose(2_000);
    },
  };
  return backend;

  async function hasGlobalConfig(
    rootUri: vscode.Uri,
    executableSearchUri: vscode.Uri,
    resolveNpmExecutable: boolean,
    config: DprintExtensionConfig,
  ) {
    const key = rootUri.toString();
    if (availableGlobalConfigs.has(key)) {
      return true;
    }

    const existingProbe = pendingGlobalConfigProbes.get(key);
    if (existingProbe != null) {
      return existingProbe;
    }

    const probe = probeGlobalConfig();
    pendingGlobalConfigProbes.set(key, probe);
    try {
      const available = await probe;
      if (available) {
        availableGlobalConfigs.add(key);
      }
      return available;
    } finally {
      if (pendingGlobalConfigProbes.get(key) === probe) {
        pendingGlobalConfigProbes.delete(key);
      }
    }

    async function probeGlobalConfig() {
      try {
        const executable = await DprintExecutable.create({
          approvedPaths,
          pathInfo: config.pathInfo,
          cwd: rootUri,
          executableSearchUri,
          configUri: undefined,
          configDiscovery: "global",
          resolveNpmExecutable,
          verbose: config.verbose,
          logger,
          environment: new RealEnvironment(logger),
        });
        const editorInfo = await executable.getEditorInfo();
        return editorInfo.plugins.length > 0;
      } catch (err) {
        logger.logError("Failed probing global dprint configuration.", err);
        return false;
      }
    }
  }

  function notifyUnavailable(uri: vscode.Uri, reason: string) {
    logger.logErrorAndNotify(
      "dprint could not find a usable configuration for this file.",
      `${reason} File: ${uri.fsPath}`,
    );
  }
}
