// note: this file should not import "vscode" so that it can be unit tested

/** Options for the cli that are provided via environment variables. */
export interface CliEnvOptions {
  /** The cli's config discovery mode. Defaults to the cli's default. */
  configDiscovery?: string;
  /** Whether to format again until the output is stable. Defaults to false. */
  ensureStableFormat?: boolean;
}

/**
 * Gets the environment variables to launch the cli with or undefined to inherit
 * this process' environment. Environment variables are used instead of flags
 * because older cli versions error on an unknown flag, but ignore an unknown
 * environment variable.
 */
export function getCliEnv(processEnv: NodeJS.ProcessEnv, options: CliEnvOptions) {
  const vars: NodeJS.ProcessEnv = {};
  if (options.configDiscovery != null) {
    vars.DPRINT_CONFIG_DISCOVERY = options.configDiscovery;
  }
  if (options.ensureStableFormat) {
    vars.DPRINT_EDITOR_STABLE_FORMAT = "1";
  }
  return Object.keys(vars).length === 0 ? undefined : { ...processEnv, ...vars };
}
