import * as path from "node:path";
import * as process from "node:process";
import * as vscode from "vscode";
import {
  DocumentFormattingRequest,
  DocumentRangeFormattingRequest,
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";
import type { ApprovedConfigPaths } from "./ApprovedConfigPaths";
import { getCombinedDprintConfig } from "./config";
import { ancestorDirsContainConfigFile, discoverWorkspaceConfigFiles } from "./configFile";
import { FILE_SCHEME } from "./constants";
import { RealEnvironment } from "./environment";
import { getCliEnv } from "./executable/cliEnv";
import { getCommandLaunchInfo } from "./executable/command";
import { DprintExecutable } from "./executable/DprintExecutable";
import type { ExtensionBackend } from "./ExtensionBackend";
import { ConfigJsonSchemaProvider } from "./legacy/ConfigJsonSchemaProvider";
import type { Logger } from "./logger";

interface StartClientOptions {
  /** Directory to run dprint in. */
  cwd: vscode.Uri;
  /**
   * Whether the language server should only provide formatting for the files in directories
   * with a config file instead of for every file (requires dprint 0.59+).
   */
  scopedFormatting: boolean;
}

export function activateLsp(
  logger: Logger,
  approvedPaths: ApprovedConfigPaths,
): ExtensionBackend {
  let client: LanguageClient | undefined;
  /** Incremented when the client is stopped so a start that's in progress knows it was superseded. */
  let generation = 0;
  let lazyStart: Promise<LanguageClient | undefined> | undefined;
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
      await stopClient();
      if (!(await workspaceHasConfigFile())) {
        logger.logInfo("Configuration file not found.");
        return;
      }
      // todo: make this handle multiple workspace folders
      const rootUri = vscode.workspace.workspaceFolders?.[0].uri;
      if (await startClient({ cwd: rootUri!, scopedFormatting: false }) != null) {
        logger.logInfo("Started experimental language server.");
      }
    },
    onConfigFileChanged() {
      // the language server is restarted to pick up config changes
      return backend.reInitialize();
    },
    async provideGlobalConfigFormattingEdits(document, range, options, token) {
      const currentClient = client ?? await startClientLazily(document);
      if (currentClient == null) {
        logger.logWarn("Cannot format because the language server is not running.");
        return undefined;
      }
      // the language server uses the global config file when provided this option (requires dprint 0.59+)
      const textDocument = currentClient.code2ProtocolConverter.asTextDocumentIdentifier(document);
      const formattingOptions = { tabSize: options.tabSize, insertSpaces: options.insertSpaces, useGlobalConfig: true };
      const edits = range == null
        ? await currentClient.sendRequest(
          DocumentFormattingRequest.type,
          { textDocument, options: formattingOptions },
          token,
        )
        : await currentClient.sendRequest(DocumentRangeFormattingRequest.type, {
          textDocument,
          range: currentClient.code2ProtocolConverter.asRange(range),
          options: formattingOptions,
        }, token);
      return await currentClient.protocol2CodeConverter.asTextEdits(edits, token);
    },
    async dispose() {
      emptySchemaProvider.dispose();
      await stopClient();
    },
  };
  return backend;

  /**
   * Starts the language server in order to format the document using the global config
   * file. The language server isn't started when the workspace has no config file, so
   * this starts it the first time it's needed instead of always having it running.
   */
  function startClientLazily(document: vscode.TextDocument) {
    lazyStart ??= (async () => {
      const cwd = vscode.workspace.workspaceFolders?.[0].uri
        ?? (document.uri.scheme === FILE_SCHEME ? vscode.Uri.file(path.dirname(document.uri.fsPath)) : undefined);
      if (cwd == null) {
        return undefined;
      }
      // Scope the formatting so that dprint doesn't become a formatter for the
      // files of a project that doesn't use dprint because the server is running.
      const newClient = await startClient({ cwd, scopedFormatting: true });
      if (newClient != null) {
        logger.logInfo("Started experimental language server to format using the global configuration file.");
      }
      return newClient;
    })().finally(() => {
      lazyStart = undefined;
    });
    return lazyStart;
  }

  async function startClient(opts: StartClientOptions) {
    const startGeneration = generation;
    const config = getCombinedDprintConfig(vscode.workspace.workspaceFolders ?? []);

    const command = await DprintExecutable.resolveCommand({
      approvedPaths,
      pathInfo: config.pathInfo,
      cwd: opts.cwd,
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
        env: getCliEnv(process.env, {
          ensureStableFormat: config.ensureStableFormat,
          useGlobalConfig: config.useGlobalConfig,
        }),
        shell: launchInfo.shell,
      },
    };
    const clientOptions: LanguageClientOptions = {
      documentSelector: [{ scheme: FILE_SCHEME }],
      initializationOptions: opts.scopedFormatting ? { scopedFormatting: true } : undefined,
      outputChannel: logger.getOutputChannel(),
    };
    const newClient = new LanguageClient(
      "dprint",
      serverOptions,
      clientOptions,
    );
    await newClient.start();
    if (startGeneration !== generation) {
      // stopped or reinitialized while starting
      await newClient.dispose(2_000);
      return undefined;
    }
    client = newClient;
    return newClient;
  }

  async function stopClient() {
    generation++;
    const oldClient = client;
    client = undefined;
    await oldClient?.dispose(2_000);
  }

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
