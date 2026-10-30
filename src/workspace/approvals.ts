import {
  APPROVAL_CHANGED_ERROR_CODE,
  type ApprovalDecision,
  type ApproveParams,
  type ApproveResult,
  type ErrorData,
  type FormatStatus,
  type PendingApproval,
} from "./messages";

// note: this file should not import "vscode" so that it can be unit tested

/** A button for what the user decides about an approval. */
export interface ApprovalChoice {
  title: string;
  decision: ApprovalDecision;
}

export interface ApprovalsOptions {
  /** Asks the user about the approval, which resolves to undefined when they dismissed it. */
  ask(approval: PendingApproval, choices: ApprovalChoice[]): Promise<ApprovalDecision | undefined>;
  /** Sends what the user decided to dprint. */
  approve(params: ApproveParams): Promise<ApproveResult>;
  /** Gets what needs to be approved for the config files dprint used. */
  pendingApprovals(): Promise<PendingApproval[]>;
}

/**
 * Asks the user about what a config file needs approved for one dprint process. Each
 * approval is only asked about once unless the user asks for it (ex. with a command),
 * because the editor formats without the user doing anything in between (ex. on save).
 */
export class Approvals {
  readonly #options: ApprovalsOptions;
  /** The approvals the user was asked about. */
  readonly #asked = new Set<string>();
  /** The approvals being asked about, which the formats of the other documents of the config file share. */
  readonly #inProgress = new Map<string, Promise<boolean>>();

  constructor(options: ApprovalsOptions) {
    this.#options = options;
  }

  /**
   * Asks the user about the approvals and then what else needs to be approved after them,
   * which resolves to whether it was all allowed. That's when a document is formatted again.
   *
   * @param options.isExplicit - Whether the user asked for it (ex. with a command), which asks
   * about what they denied or were already asked about.
   */
  request(approvals: PendingApproval[], options: { isExplicit: boolean }): Promise<boolean> {
    const key = approvals.map(approval => approval.id).sort().join("\n");
    const inProgress = this.#inProgress.get(key);
    if (inProgress != null) {
      return inProgress;
    }
    const request = this.#request(approvals, options).finally(() => this.#inProgress.delete(key));
    this.#inProgress.set(key, request);
    return request;
  }

  async #request(approvals: PendingApproval[], options: { isExplicit: boolean }) {
    let pending = approvals;
    // whether the config file is used now, which is only known after something was approved
    let status: FormatStatus | undefined;
    const askedNow = new Set<string>();
    while (pending.length > 0) {
      const approval = pending.find(approval => !askedNow.has(approval.id));
      if (approval == null) {
        // what's left was denied
        return false;
      }
      if (!options.isExplicit && (approval.denied || this.#asked.has(approval.id))) {
        return false;
      }
      askedNow.add(approval.id);
      this.#asked.add(approval.id);
      const decision = await this.#options.ask(approval, getApprovalChoices(approval));
      if (decision == null) {
        // it stays pending, so the user can still approve it with the command
        return false;
      }
      const allows = isAllowed(approval, decision);
      const isForConfigFile = (other: PendingApproval) => other.configFile?.uri === approval.configFile?.uri;
      try {
        const result = await this.#options.approve({ id: approval.id, decision });
        pending = result.approvals;
        status = result.status;
      } catch (err) {
        if (!isApprovalChangedError(err)) {
          if (!allows) {
            throw err;
          }
          // the decision may still have been used, so what's pending is gotten again
          pending = (await this.#options.pendingApprovals()).filter(isForConfigFile);
          status = undefined;
          if (pending.some(pending => pending.id === approval.id)) {
            // it wasn't used
            throw err;
          }
          continue;
        }
        if (!allows) {
          return false;
        }
        // what needs to be approved changed (ex. the config file changed), which the error may have
        pending = getChangedApprovals(err) ?? (await this.#options.pendingApprovals()).filter(isForConfigFile);
        status = undefined;
        continue;
      }
      if (!allows) {
        return false;
      }
    }
    // it's formatted again once the config file is used
    return status == null || status.kind === "ready";
  }
}

/** Gets the message to ask the user with, which has what the process plugins run with. */
export function getApprovalMessage(approval: PendingApproval) {
  const configurations = approval.items
    .filter(item => item.configuration != null)
    .map(item => [item.configKey ?? item.specifier, item.configuration]);
  if (configurations.length === 0) {
    return approval.message;
  }
  return `${approval.message} They run with this configuration: ${JSON.stringify(Object.fromEntries(configurations))}`;
}

/** Gets what the user can decide about the approval, which are the decisions dprint says it has. */
export function getApprovalChoices(approval: Pick<PendingApproval, "decisions">): ApprovalChoice[] {
  return approval.decisions.map(option => ({ title: option.label, decision: option.id }));
}

/**
 * Gets if the error is for an approval that isn't pending anymore, which is recognized by its data
 * because a language client library may use the same code for its own errors.
 */
function isApprovalChangedError(err: unknown) {
  return typeof err === "object" && err != null && "code" in err && err.code === APPROVAL_CHANGED_ERROR_CODE
    && "data" in err && typeof err.data === "object" && err.data != null && "kind" in err.data
    && err.data.kind === "approvalChanged";
}

/** Gets what needs to be approved now from the error for an approval that isn't pending anymore. */
function getChangedApprovals(err: unknown): PendingApproval[] | undefined {
  const data = typeof err === "object" && err != null && "data" in err ? err.data as ErrorData | undefined : undefined;
  return data?.kind === "approvalChanged" && "approvals" in data && Array.isArray(data.approvals)
    ? data.approvals
    : undefined;
}

/** Gets if the decision allows the approval, which dprint says for a decision the extension doesn't know. */
function isAllowed(approval: PendingApproval, decision: ApprovalDecision) {
  const option = approval.decisions.find(option => option.id === decision);
  return option?.allows ?? (decision === "allow" || decision === "alwaysAllow");
}
