// note: this file should not import "vscode" so that it can be unit tested

export interface NoConfigMessageOptions {
  useGlobalConfig: boolean;
  hasGlobalConfig: boolean;
}

/** Gets the message to show when no config file was found for a file. */
export function getNoConfigMessage(options: NoConfigMessageOptions) {
  const message = "No dprint configuration file found. Run \"dprint init\" in your project to create one";
  if (options.useGlobalConfig) {
    return message + " or \"dprint init --global\" to create a global one.";
  } else if (options.hasGlobalConfig) {
    return message + " or enable the \"dprint.useGlobalConfig\" setting to use your global one.";
  } else {
    return message + ".";
  }
}
