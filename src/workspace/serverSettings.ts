import type { ServerSettings } from "./messages";

// note: this file should not import "vscode" so that it can be unit tested

/** The extension's settings that the server has. */
export interface ServerSettingsConfig {
  /** Only from the user's settings because the global config file's process plugins run without being approved. */
  useGlobalConfig: boolean;
  ensureStableFormat: boolean;
  verbose: boolean;
}

/**
 * Gets the settings to send to the server. Each one is always provided because one that
 * isn't keeps its value (ex. after the user turned it off), so a setting that's off has
 * the server's default, which is what its environment variable says.
 */
export function getServerSettings(
  config: ServerSettingsConfig,
  env: { [name: string]: string | undefined },
): Required<ServerSettings> {
  return {
    useGlobalConfig: config.useGlobalConfig || isEnabledEnvVar(env.DPRINT_EDITOR_USE_GLOBAL_CONFIG),
    ensureStableFormat: config.ensureStableFormat || isEnabledEnvVar(env.DPRINT_EDITOR_STABLE_FORMAT),
    verbose: config.verbose,
  };
}

/** Gets if an environment variable is `1` or `true`, which is how dprint reads its boolean environment variables. */
function isEnabledEnvVar(value: string | undefined) {
  const trimmed = value?.trim().toLowerCase();
  return trimmed === "1" || trimmed === "true";
}
