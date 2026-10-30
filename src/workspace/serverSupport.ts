import { DPRINT_METHODS_VERSIONS, type InitializeResult } from "./messages";

// note: this file should not import "vscode" so that it can be unit tested

/** Why the language server of an executable can't be used. */
export interface UnsupportedServer {
  error: string;
  /**
   * Whether the executable couldn't be run at all (ex. dprint isn't installed), as
   * opposed to being a version of dprint that doesn't have the `dprint/*` methods.
   */
  isUnavailable: boolean;
}

/**
 * Gets the version of dprint when its language server has the `dprint/*` methods
 * the extension uses, or otherwise why it can't be used.
 */
export function getServerSupport(result: InitializeResult): { version: string } | UnsupportedServer {
  const version = result.serverInfo?.version ?? "unknown";
  if (!isSupportedServer(result)) {
    return {
      error: `dprint ${version} doesn't support the dprint methods of its language server.`,
      isUnavailable: false,
    };
  }
  return { version };
}

/** Gets if the language server has the `dprint/*` methods the extension uses. */
export function isSupportedServer(result: InitializeResult) {
  // the server responds with the version it uses of the ones the extension supports
  const methodsVersion = result.capabilities?.experimental?.dprint?.version;
  return typeof methodsVersion === "number" && DPRINT_METHODS_VERSIONS.includes(methodsVersion);
}

/**
 * Gets why the workspace can't be formatted with the language server, which is
 * undefined when it can.
 *
 * The config files whose executable doesn't support it are formatted with schema
 * version 5 of the editor service on their own, but the default executable, which
 * formats the files without a config file in the workspace, needs to support it when
 * it runs so that those files aren't left unformatted because it's an older dprint.
 * One that can't run doesn't matter unless there's nothing else to format with,
 * because the files it would format can't be formatted either way.
 */
export function getUnsupportedError<TServer extends object>(
  defaultServer: TServer | UnsupportedServer,
  hasConfigFiles: boolean,
): string | undefined {
  if (isUnsupportedServer(defaultServer) && (!defaultServer.isUnavailable || !hasConfigFiles)) {
    return defaultServer.error;
  }
  return undefined;
}

export function isUnsupportedServer<TServer extends object>(
  server: TServer | UnsupportedServer,
): server is UnsupportedServer {
  return "error" in server;
}

/**
 * Gets if starting `dprint lsp` failed because it's a version of dprint without the
 * subcommand, as opposed to dprint not running at all (ex. it's not installed), which
 * is when dprint says it doesn't know the subcommand.
 */
export function isUnknownSubcommandError(err: unknown) {
  return /subcommand '?lsp\b|'lsp' which wasn't expected/i.test(String(err));
}
