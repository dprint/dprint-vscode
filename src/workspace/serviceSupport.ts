// note: this file should not import "vscode" so that it can be unit tested

/** Why the editor service of an executable can't be used. */
export interface UnsupportedService {
  error: string;
  /**
   * Whether the executable couldn't be run at all (ex. dprint isn't installed), as
   * opposed to being a version of dprint that doesn't support the schema version.
   */
  isUnavailable: boolean;
}

/**
 * Gets why the workspace can't be formatted with schema version 6 of the editor
 * service, which is undefined when it can.
 *
 * The config files whose executable doesn't support it are formatted with schema
 * version 5 on their own, but the default executable, which formats the files
 * without a config file in the workspace, needs to support it when it runs so that
 * those files aren't left unformatted because it's an older dprint. One that can't
 * run doesn't matter unless there's nothing else to format with, because the files
 * it would format can't be formatted either way.
 */
export function getUnsupportedError<TService extends object>(
  defaultService: TService | UnsupportedService,
  hasConfigFiles: boolean,
): string | undefined {
  if (isUnsupportedService(defaultService) && (!defaultService.isUnavailable || !hasConfigFiles)) {
    return defaultService.error;
  }
  return undefined;
}

export function isUnsupportedService<TService extends object>(
  service: TService | UnsupportedService,
): service is UnsupportedService {
  return "error" in service;
}

/**
 * Gets if running `dprint editor-service --info` failed because it's a version of dprint
 * without it, as opposed to dprint not running at all (ex. it's not installed), which is
 * when dprint says it doesn't know the argument or the subcommand.
 */
export function isOldDprintError(err: unknown) {
  return /--info|editor-service/.test(String(err));
}
