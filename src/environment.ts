import * as cp from "node:child_process";
import * as crypto from "node:crypto";
import * as process from "node:process";
import * as os from "os";
import * as vscode from "vscode";
import { Instant, type Logger } from "./logger";

// Over time, update the codebase to use this so it can be unit testable

export type LinuxFamily = "musl" | "glibc";

export interface Environment {
  fileExists(path: vscode.Uri): Promise<boolean>;
  readTextFile(path: vscode.Uri): Promise<string | undefined>;
  atomicCopyFile(from: vscode.Uri, to: vscode.Uri): Promise<void>;
  mkdir(uri: vscode.Uri): Promise<void>;
  isWritableFileSystem(): boolean;
  tmpdir(): string;
  arch(): string;
  platform(): NodeJS.Platform;
  getLinuxFamily(): Promise<LinuxFamily>;
}

let cachedFamily: "musl" | "glibc" | undefined;

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
    if (cachedFamily == null) {
      const start = Instant.now();
      cachedFamily = await innerGet();
      logger.logDebug(`Resolved linux family to ${cachedFamily} in ${start.elapsedMs()}ms`);
    }
    return cachedFamily;

    async function innerGet() {
      try {
        if (os.platform() !== "linux") {
          logger.logWarn("Should not be checking linux family on non-linux system.");
          return "glibc";
        }
        return resolveLinuxFamily(logger);
      } catch (err) {
        logger.logWarn("Error checking if musl. Assuming not.", err);
        return "glibc";
      }
    }
  }
}

// code adapted from https://github.com/lovell/detect-libc
// Copyright Apache 2.0 license, the detect-libc maintainers
async function resolveLinuxFamily(logger: Logger) {
  const family = await getFamilyFromLddPath() ?? await checkWithExecutables();
  if (family != null) {
    return family;
  }
  return isProcessReportMusl() ? "musl" : "glibc";

  async function getFamilyFromLddPath() {
    function includes(bytes: Uint8Array, text: string) {
      const sub = new TextEncoder().encode(text);
      if (sub.length > bytes.length) {
        return false;
      }

      for (let i = 0; i <= bytes.length - sub.length; i++) {
        let match = true;

        for (let j = 0; j < sub.length; j++) {
          if (bytes[i + j] !== sub[j]) {
            match = false;
            break;
          }
        }

        if (match) {
          return true;
        }
      }

      return false;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file("/usr/bin/ldd"));
      if (includes(bytes, "GLIBC") || includes(bytes, "libc")) {
        return "glibc";
      } else if (includes(bytes, "musl")) {
        return "musl";
      }
    } catch (err) {
      logger.logDebug("Failed resolving family from lld path", err);
    }
    logger.logDebug("Linux family not determined by lld path");
    return undefined;
  }

  async function checkWithExecutables() {
    const output = await getCommandOutput();
    if (output == null) {
      return undefined;
    }
    const [_, ldd1] = output.split(/[\r\n]+/);
    if (ldd1 && ldd1.includes("musl")) {
      return "musl";
    } else {
      return "glibc";
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
      } catch {
        return undefined;
      }
    }
  }

  // note: this is extremely slow on WSL in some cases, so try to avoid it
  // https://github.com/nodejs/node/issues/46060
  function isProcessReportMusl() {
    if (!process.report) {
      return false;
    }
    const rawReport = process.report.getReport();
    const report: {
      sharedObjects: string[];
    } = typeof rawReport === "string" ? JSON.parse(rawReport) : rawReport;
    if (!report || !(report.sharedObjects instanceof Array)) {
      return false;
    }
    return report.sharedObjects.some((o: any) => o.includes("libc.musl-") || o.includes("ld-musl-"));
  }
}
