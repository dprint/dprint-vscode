import {
  type ApprovalDecision,
  type ApprovalKind,
  type ApproveParams,
  type ApproveResult,
  CONTENT_MODIFIED_ERROR_CODE,
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
   * Asks the user about the approval and then what else needs to be approved after it,
   * which resolves to whether it was all allowed. That's when a document is formatted again.
   *
   * @param options.isExplicit - Whether the user asked for it (ex. with a command), which asks
   * about what they denied or were already asked about.
   */
  request(approval: PendingApproval, options: { isExplicit: boolean }): Promise<boolean> {
    const inProgress = this.#inProgress.get(approval.id);
    if (inProgress != null) {
      return inProgress;
    }
    const request = this.#request(approval, options).finally(() => this.#inProgress.delete(approval.id));
    this.#inProgress.set(approval.id, request);
    return request;
  }

  async #request(approval: PendingApproval, options: { isExplicit: boolean }) {
    let pending: PendingApproval | null = approval;
    while (pending != null) {
      if (!options.isExplicit && (pending.denied || this.#asked.has(pending.id))) {
        return false;
      }
      this.#asked.add(pending.id);
      const decision = await this.#options.ask(pending, getApprovalChoices(pending.kind));
      if (decision == null) {
        // it stays pending, so the user can still approve it with the command
        return false;
      }
      let result: ApproveResult;
      try {
        result = await this.#options.approve({ id: pending.id, decision });
      } catch (err) {
        if (isContentModifiedError(err)) {
          // what needs to be approved changed (ex. the config file changed), which formatting again gets
          return isAllowed(decision);
        }
        throw err;
      }
      if (!isAllowed(decision)) {
        return false;
      }
      // allowing it only allows what was shown (ex. not what a downloaded config file extends)
      pending = result.approval;
    }
    return true;
  }
}

/** Gets the message to ask the user with, which has what the process plugins run with. */
export function getApprovalMessage(approval: PendingApproval) {
  if (approval.configuration == null || Object.keys(approval.configuration).length === 0) {
    return approval.message;
  }
  return `${approval.message} They run with this configuration: ${JSON.stringify(approval.configuration)}`;
}

/** Gets what the user can decide about an approval of the kind. */
export function getApprovalChoices(kind: ApprovalKind): ApprovalChoice[] {
  if (kind === "processPlugins") {
    return [
      { title: "Allow", decision: "allow" },
      { title: "Always Allow", decision: "alwaysAllow" },
      { title: "Deny", decision: "deny" },
      { title: "Always Deny", decision: "alwaysDeny" },
    ];
  }
  // a download is only decided for the session, which includes the kinds that are newer than the extension
  return [
    { title: "Allow", decision: "allow" },
    { title: "Deny", decision: "deny" },
  ];
}

function isContentModifiedError(err: unknown) {
  return typeof err === "object" && err != null && "code" in err && err.code === CONTENT_MODIFIED_ERROR_CODE;
}

function isAllowed(decision: ApprovalDecision) {
  return decision === "allow" || decision === "alwaysAllow";
}
