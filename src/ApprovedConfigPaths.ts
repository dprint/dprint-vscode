import * as vscode from "vscode";
import type { DprintExtensionConfigPathInfo } from "./config";

const APPROVED_PATHS_KEY = "dprint.approvedPaths";

export class ApprovedConfigPaths {
  readonly #context: vscode.ExtensionContext;
  readonly #sessionDeniedPaths = new Set<string>();

  constructor(context: vscode.ExtensionContext) {
    this.#context = context;
  }

  #getApprovedPaths(): string[] {
    const value = this.#context.workspaceState.get(APPROVED_PATHS_KEY);
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((item): item is string => typeof item === "string");
  }

  isPathApproved(pathInfo: DprintExtensionConfigPathInfo): boolean {
    const approvedPaths = this.#getApprovedPaths();
    return approvedPaths.includes(pathInfo.path);
  }

  async #approvePath(pathInfo: DprintExtensionConfigPathInfo): Promise<void> {
    const approvedPaths = this.#getApprovedPaths();
    if (!approvedPaths.includes(pathInfo.path)) {
      approvedPaths.push(pathInfo.path);
      await this.#context.workspaceState.update(APPROVED_PATHS_KEY, approvedPaths);
    }
  }

  /** Prompts the user for approval if the path hasn't been approved yet. */
  async promptForApproval(pathInfo: DprintExtensionConfigPathInfo): Promise<boolean> {
    if (!pathInfo.isFromWorkspace) {
      return true; // global paths don't need approval
    }

    if (this.isPathApproved(pathInfo)) {
      return true;
    }

    // already denied for this session
    if (this.#sessionDeniedPaths.has(pathInfo.path)) {
      return false;
    }

    const allow = "Allow";
    const deny = "Don't Allow";
    const result = await vscode.window.showWarningMessage(
      `A workspace setting wants to run a custom dprint executable: ${pathInfo.path}`,
      allow,
      deny,
    );

    if (result === allow) {
      await this.#approvePath(pathInfo);
      return true;
    }
    if (result === deny) {
      this.#sessionDeniedPaths.add(pathInfo.path);
    }
    return false;
  }
}
