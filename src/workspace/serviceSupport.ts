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
 * Every executable of a config file needs to support it. The default executable,
 * which formats the files without a config file in the workspace, needs to support
 * it too when it runs, so that those files aren't left unformatted because it's an
 * older dprint. One that can't run doesn't matter unless there's nothing else to
 * format with, because the files it would format can't be formatted either way.
 */
export function getUnsupportedError<TService extends object>(
  configServices: ReadonlyArray<TService | UnsupportedService>,
  defaultService: TService | UnsupportedService,
): string | undefined {
  const unsupported = configServices.find(isUnsupportedService);
  if (unsupported != null) {
    return unsupported.error;
  }
  if (isUnsupportedService(defaultService) && (!defaultService.isUnavailable || configServices.length === 0)) {
    return defaultService.error;
  }
  return undefined;
}

export function isUnsupportedService<TService extends object>(
  service: TService | UnsupportedService,
): service is UnsupportedService {
  return "error" in service;
}
