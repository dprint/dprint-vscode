import * as path from "node:path";
import type { Environment, LinuxFamily } from "./environment";

// note: this file should not import "vscode" so that it can be used in unit tests

type Entry =
  | { kind: "dir" }
  | { kind: "file"; text: string }
  | { kind: "symlink"; target: string };

export interface TestEnvironmentOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  linuxFamily?: LinuxFamily;
  tmpdir?: string;
  isWritableFileSystem?: boolean;
}

/** An in-memory environment for unit tests. */
export class TestEnvironment implements Environment {
  readonly #entries = new Map<string, Entry>();
  readonly #options: Required<TestEnvironmentOptions>;

  constructor(options: TestEnvironmentOptions = {}) {
    this.#options = {
      platform: options.platform ?? "linux",
      arch: options.arch ?? "x64",
      linuxFamily: options.linuxFamily ?? "glibc",
      tmpdir: options.tmpdir ?? path.resolve("/tmp"),
      isWritableFileSystem: options.isWritableFileSystem ?? true,
    };
  }

  /** Writes a file, creating any missing parent directories. */
  writeFile(filePath: string, text: string) {
    const resolvedPath = this.#resolveParent(filePath);
    this.#assertNotDir(resolvedPath);
    this.#entries.set(resolvedPath, { kind: "file", text });
  }

  /** Creates a symlink at `linkPath` that points to `target`, creating any missing parent directories. */
  symlink(target: string, linkPath: string) {
    const resolvedPath = this.#resolveParent(linkPath);
    if (this.#entries.has(resolvedPath)) {
      throw new Error(`Path already exists: ${resolvedPath}`);
    }
    this.#entries.set(resolvedPath, { kind: "symlink", target: path.resolve(path.dirname(resolvedPath), target) });
  }

  /** Reads a file synchronously, following symlinks. */
  readTextFileSync(filePath: string) {
    const realPath = this.#realPath(filePath);
    const entry = realPath == null ? undefined : this.#entries.get(realPath);
    return entry?.kind === "file" ? entry.text : undefined;
  }

  fileExists(filePath: string) {
    return Promise.resolve(this.#realPath(filePath) != null);
  }

  readTextFile(filePath: string) {
    return Promise.resolve(this.readTextFileSync(filePath));
  }

  realPath(filePath: string) {
    return Promise.resolve(this.#realPath(filePath));
  }

  atomicCopyFile(from: string, to: string) {
    const text = this.readTextFileSync(from);
    if (text == null) {
      return Promise.reject(new Error(`File not found: ${from}`));
    }
    const parentDir = this.#realPath(path.dirname(to));
    if (parentDir == null || this.#entries.get(parentDir)?.kind !== "dir") {
      return Promise.reject(new Error(`Directory not found: ${path.dirname(to)}`));
    }
    const resolvedPath = path.join(parentDir, path.basename(to));
    this.#assertNotDir(resolvedPath);
    this.#entries.set(resolvedPath, { kind: "file", text });
    return Promise.resolve();
  }

  mkdir(dirPath: string) {
    this.#mkdirAll(dirPath);
    return Promise.resolve();
  }

  isWritableFileSystem() {
    return this.#options.isWritableFileSystem;
  }

  tmpdir() {
    return this.#options.tmpdir;
  }

  arch() {
    return this.#options.arch;
  }

  platform() {
    return this.#options.platform;
  }

  getLinuxFamily() {
    return Promise.resolve(this.#options.linuxFamily);
  }

  /** Resolves the parent directory's real path (creating it if necessary) and joins the basename. */
  #resolveParent(filePath: string) {
    const parentDir = this.#mkdirAll(path.dirname(path.resolve(filePath)));
    return path.join(parentDir, path.basename(filePath));
  }

  #mkdirAll(dirPath: string): string {
    const resolvedPath = path.resolve(dirPath);
    const parentPath = path.dirname(resolvedPath);
    if (parentPath === resolvedPath) {
      return resolvedPath; // root
    }
    const realParentPath = this.#mkdirAll(parentPath);
    const childPath = path.join(realParentPath, path.basename(resolvedPath));
    const entry = this.#entries.get(childPath);
    if (entry == null) {
      this.#entries.set(childPath, { kind: "dir" });
      return childPath;
    }
    const realChildPath = this.#realPath(childPath);
    if (realChildPath == null || this.#entries.get(realChildPath)?.kind !== "dir") {
      throw new Error(`Not a directory: ${childPath}`);
    }
    return realChildPath;
  }

  /** Resolves all the symlinks in the path, returning undefined when it doesn't exist. */
  #realPath(filePath: string, depth = 0): string | undefined {
    if (depth > 40) {
      throw new Error(`Too many levels of symbolic links: ${filePath}`);
    }
    const resolvedPath = path.resolve(filePath);
    const parentPath = path.dirname(resolvedPath);
    if (parentPath === resolvedPath) {
      return resolvedPath; // root
    }
    const realParentPath = this.#realPath(parentPath, depth);
    if (realParentPath == null) {
      return undefined;
    }
    const childPath = path.join(realParentPath, path.basename(resolvedPath));
    const entry = this.#entries.get(childPath);
    if (entry == null) {
      return undefined;
    } else if (entry.kind === "symlink") {
      return this.#realPath(entry.target, depth + 1);
    } else {
      return childPath;
    }
  }

  #assertNotDir(resolvedPath: string) {
    if (this.#entries.get(resolvedPath)?.kind === "dir") {
      throw new Error(`Cannot write a file at a directory: ${resolvedPath}`);
    }
  }
}
