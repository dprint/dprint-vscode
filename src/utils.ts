export class ObjectDisposedError extends Error {}

/** For now, only expands ~/ to env.HOME */
export function shellExpand(path: string, env: { [prop: string]: string | undefined } = process.env) {
  if (path.startsWith("~/")) {
    const home = env.HOME ?? "";
    path = path.replace("~/", home + "/");
  }
  return path;
}
