import * as path from "node:path";
import * as vscode from "vscode";
import type { Environment } from "./environment";

// This isn't used yet, but in the future it should be used for unit testing.

class Directory {
  entries: Map<string, string | Directory> = new Map();
}

export class TestEnvironment implements Environment {
  #directories: Map<string, Directory> = new Map();

  fileExists(uri: vscode.Uri): Promise<boolean> {
    const directory = this.#directories.get(path.dirname(uri.fsPath));
    if (directory == null) {
      return Promise.resolve(false);
    }
    return Promise.resolve(directory.entries.has(path.basename(uri.fsPath)));
  }

  readTextFile(path: vscode.Uri): Promise<string | undefined> {
    throw new Error("Method not implemented.");
  }

  atomicCopyFile(from: vscode.Uri, to: vscode.Uri): Promise<void> {
    throw new Error("Method not implemented.");
  }

  mkdir(uri: vscode.Uri): Promise<void> {
    throw new Error("Method not implemented.");
  }

  isWritableFileSystem(): boolean {
    throw new Error("Method not implemented.");
  }

  tmpdir(): string {
    throw new Error("Method not implemented.");
  }

  arch(): string {
    throw new Error("Method not implemented.");
  }

  platform(): NodeJS.Platform {
    throw new Error("Method not implemented.");
  }

  getLinuxFamily(): Promise<"musl" | "glibc"> {
    throw new Error("Method not implemented.");
  }

  writeFile(uri: vscode.Uri, content: string): void {
    const directory = this.#ensureDirectory(vscode.Uri.joinPath(uri, ".."));
    const basename = path.basename(uri.fsPath);
    if (directory.entries.get(basename) instanceof Directory) {
      throw new Error("Cannot create a file at a directory.");
    }
    directory.entries.set(basename, content);
  }

  #ensureDirectory(uri: vscode.Uri): Directory {
    if (uri.fsPath === "/") {
      let dir = this.#directories.get("/");
      if (dir == null) {
        dir = new Directory();
        this.#directories.set("/", dir);
      }
      return dir;
    } else {
      let dir = this.#directories.get(uri.fsPath);
      if (dir == null) {
        const parentDir = this.#ensureDirectory(vscode.Uri.joinPath(uri, ".."));
        if (parentDir.entries.has(path.basename(uri.fsPath))) {
          throw new Error("Cannot create a directory at a file.");
        }
        dir = new Directory();
        parentDir.entries.set(path.basename(uri.fsPath), dir);
        this.#directories.set(uri.fsPath, dir);
      }
      return dir;
    }
  }
}
