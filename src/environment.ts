import * as cp from "node:child_process";
import * as crypto from "node:crypto";
import * as process from "node:process";
import * as os from "os";
import * as vscode from "vscode";
import type { Logger } from "./logger";

// Over time, update the codebase to use this so it can be unit testable

export interface Environment {
  fileExists(path: vscode.Uri): Promise<boolean>;
  readTextFile(path: vscode.Uri): Promise<string | undefined>;
  atomicCopyFile(from: vscode.Uri, to: vscode.Uri): Promise<void>;
  mkdir(uri: vscode.Uri): Promise<void>;
  isWritableFileSystem(): boolean;
  tmpdir(): string;
  arch(): string;
  platform(): NodeJS.Platform;
  getLinuxFamily(): Promise<"musl" | "glibc">;
}

let cachedIsMusl: boolean | undefined;

export class RealEnvironment implements Environment {
  #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  async readTextFile(path: vscode.Uri) {
    try {
      const bytes = await vscode.workspace.fs.readFile(path);
      return new TextDecoder().decode(bytes);
    } catch {
      return undefined;
    }
  }

  async fileExists(path: vscode.Uri) {
    try {
      await vscode.workspace.fs.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async atomicCopyFile(from: vscode.Uri, to: vscode.Uri) {
    const rand = crypto.randomBytes(4).toString("hex");
    const tempFilePath = to.with({
      path: to.path + "." + rand,
    });
    await vscode.workspace.fs.copy(from, tempFilePath, { overwrite: true });
    try {
      await vscode.workspace.fs.rename(tempFilePath, to, { overwrite: true });
    } catch (err) {
      try {
        await vscode.workspace.fs.delete(tempFilePath);
      } catch {
        // ignore
      }
      throw err;
    }
  }

  isWritableFileSystem() {
    return vscode.workspace.fs.isWritableFileSystem("file") ?? true;
  }

  async mkdir(uri: vscode.Uri) {
    await vscode.workspace.fs.createDirectory(uri);
  }

  tmpdir(): string {
    return os.tmpdir();
  }

  arch() {
    return os.arch();
  }

  platform() {
    return os.platform();
  }

  async getLinuxFamily() {
    const logger = this.#logger;
    return await getIsMusl() ? "musl" : "glibc";

    async function getIsMusl() {
      // code adapted from https://github.com/lovell/detect-libc
      // Copyright Apache 2.0 license, the detect-libc maintainers
      if (cachedIsMusl == null) {
        cachedIsMusl = await innerGet();
      }
      return cachedIsMusl;

      async function innerGet() {
        try {
          if (os.platform() !== "linux") {
            return false;
          }
          return isProcessReportMusl() || await isConfMusl();
        } catch (err) {
          logger.logWarn("Error checking if musl. Assuming not.", err);
          return false;
        }
      }

      function isProcessReportMusl() {
        if (!process.report) {
          return false;
        }
        const rawReport = process.report.getReport();
        const report = typeof rawReport === "string" ? JSON.parse(rawReport) : rawReport;
        if (!report || !(report.sharedObjects instanceof Array)) {
          return false;
        }
        return report.sharedObjects.some((o: any) => o.includes("libc.musl-") || o.includes("ld-musl-"));
      }

      async function isConfMusl() {
        const output = await getCommandOutput();
        const [_, ldd1] = output.split(/[\r\n]+/);
        return ldd1 && ldd1.includes("musl");
      }

      async function getCommandOutput() {
        try {
          const command = "getconf GNU_LIBC_VERSION 2>&1 || true; ldd --version 2>&1 || true";
          return await new Promise<string>((resolve, reject) => {
            cp.exec(command, { encoding: "utf8" }, (err, stdout) => {
              if (err) {
                reject(err);
              } else {
                resolve(stdout);
              }
            });
          });
        } catch (_err) {
          return "";
        }
      }
    }
  }
}
