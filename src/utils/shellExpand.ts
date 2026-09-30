// note: this file should not import "vscode" so that it can be unit tested

/**
 * Expands a leading `~/` to `env.HOME` and environment variables written as `$NAME`
 * or `${NAME}`. Nothing is executed, unlike a shell.
 */
export function shellExpand(path: string, env: { [prop: string]: string | undefined } = process.env) {
  if (path.startsWith("~/")) {
    const home = env.HOME ?? "";
    path = path.replace("~/", home + "/");
  }
  return path.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (text, bracedName, name) => {
    return env[bracedName ?? name] ?? text;
  });
}
