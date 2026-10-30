import { fileURLToPath } from "node:url";
import {
  APPROVAL_CHANGED_ERROR_CODE,
  type ApprovalDecision,
  type ApproveParams,
  type ApproveResult,
  type ConfigApprovals,
  type ConfigFileIdentifier,
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
  /** Gets what needs to be approved for the config file and whether it's used. */
  pendingApprovals(configFile: ConfigFileIdentifier): Promise<ConfigApprovals>;
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
  /**
   * What the user decided for the session by approval id, which a dprint process that was started
   * again after it exited doesn't know.
   */
  readonly #sessionDecisions = new Map<string, ApprovalDecision>();

  constructor(options: ApprovalsOptions) {
    this.#options = options;
  }

  /** Forgets which approvals the user was asked about (ex. they forgot their decisions), so they're asked again. */
  forget() {
    this.#asked.clear();
    this.#sessionDecisions.clear();
  }

  /**
   * Sends what the user decided for the session again for the approvals that are pending again
   * without asking (ex. for a dprint process that was started again after it exited, which doesn't
   * know it), which resolves to whether any was sent.
   */
  async sendSessionDecisionsAgain(pending: PendingApproval[]) {
    let isSent = false;
    for (const approval of pending) {
      const decision = this.#getSessionDecision(approval);
      if (decision != null) {
        await this.#options.approve({ id: approval.id, decision })
          .then(() => isSent = true)
          .catch(() => {/* it's asked about again */});
      }
    }
    return isSent;
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
    // the decisions to send again for an approval that's pending again after it changed
    const decisionsToSendAgain = new Map<string, ApprovalDecision>();
    // whether an approval wasn't asked about, so not everything was allowed
    let isSkipped = false;
    while (pending.length > 0) {
      const approval = pending.find(approval => !askedNow.has(approval.id));
      if (approval == null) {
        // what's left was denied
        return false;
      }
      askedNow.add(approval.id);
      // what the user decided for the session is sent again (ex. to a dprint process that was
      // started again after it exited, which doesn't know it) instead of asking, except that a
      // command asks about what they denied again
      let decision = decisionsToSendAgain.get(approval.id) ?? this.#getSessionDecision(approval);
      decisionsToSendAgain.delete(approval.id);
      if (options.isExplicit && decision != null && !isAllowed(approval, decision)) {
        decision = undefined;
      }
      if (decision == null) {
        if (!options.isExplicit && (approval.denied || this.#asked.has(approval.id))) {
          // the others are still asked about
          isSkipped = true;
          continue;
        }
        this.#asked.add(approval.id);
        decision = await this.#options.ask(approval, getApprovalChoices(approval));
        if (decision == null) {
          // it stays pending, so the user can still approve it with the command
          return false;
        }
      }
      const allows = isAllowed(approval, decision);
      const configFile = { uri: approval.configFile.uri, dirUri: approval.configFile.dirUri };
      this.#rememberSessionDecision(approval, decision);
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
          ({ approvals: pending, status } = await this.#options.pendingApprovals(configFile));
          if (pending.some(pending => pending.id === approval.id)) {
            // it wasn't used
            throw err;
          }
          continue;
        }
        // what needs to be approved changed (ex. the config file changed), so the decision wasn't used
        ({ approvals: pending, status } = getChangedResult(err) ?? await this.#options.pendingApprovals(configFile));
        if (allows && pending.some(other => other.id === approval.id) && !decisionsToSendAgain.has(approval.id)) {
          // the same approval is pending again, so the user's decision is sent again once
          askedNow.delete(approval.id);
          decisionsToSendAgain.set(approval.id, decision);
          continue;
        }
        if (!allows) {
          // the user denied what replaced it too when it's some of what they saw, which is never done for allowing it
          const deniedItems = new Set(approval.items.map(item => item.specifier));
          const replacement = pending.find(other =>
            other.kind === approval.kind && !other.denied && other.items.every(item => deniedItems.has(item.specifier))
          );
          const denial = replacement?.decisions.find(option => option.id === decision);
          if (replacement != null && denial != null) {
            await this.#options.approve({ id: replacement.id, decision })
              .then(() => this.#rememberSessionDecision(replacement, decision))
              .catch(() => {/* it's asked about later */});
          }
          return false;
        }
        continue;
      }
      if (!allows) {
        return false;
      }
    }
    // it's formatted again once the config file is used
    return !isSkipped && (status == null || status.kind === "ready");
  }

  /**
   * Gets what the user decided for the session about the approval when it's still what's used,
   * which isn't an allow that the user denied since (ex. with "Always Deny" in another window).
   */
  #getSessionDecision(approval: PendingApproval) {
    const decision = this.#sessionDecisions.get(approval.id);
    if (decision == null || !approval.decisions.some(option => option.id === decision)) {
      return undefined;
    }
    if (approval.denied) {
      // dprint knows it's denied, which is newer than an allow
      if (isAllowed(approval, decision)) {
        this.#sessionDecisions.delete(approval.id);
      }
      return undefined;
    }
    return decision;
  }

  /** Remembers what the user decided for the session, which an "Always" decision replaces. */
  #rememberSessionDecision(approval: PendingApproval, decision: ApprovalDecision) {
    if (approval.decisions.find(option => option.id === decision)?.always) {
      this.#sessionDecisions.delete(approval.id);
    } else {
      this.#sessionDecisions.set(approval.id, decision);
    }
  }
}

/**
 * Gets the message to ask the user with, which has what the process plugins run with and
 * says when the config file is outside the workspace.
 */
export function getApprovalMessage(approval: PendingApproval) {
  // the config file is first because a notification is cut off after 1000 characters, and the
  // message may have long urls from the config file
  const configFilePath = getDisplayPath(approval.configFile.uri);
  let message = approval.configFile.inWorkspace
    ? `Configuration file: ${configFilePath}. ${approval.message}`
    : `The configuration file is outside the workspace: ${configFilePath}. ${approval.message}`;
  // a notification is cut off after 1000 characters, so what they run with is shown on its own
  if (getApprovalConfiguration(approval) != null) {
    message += ` Choose "${SHOW_CONFIGURATION_TITLE}" to see what they run with.`;
  }
  // the descriptions of the decisions, which can't be tooltips of the buttons
  const descriptions = approval.decisions
    .filter(option => option.description.length > 0)
    .map(option => `${option.label}: ${option.description}`);
  if (descriptions.length > 0) {
    message += ` (${descriptions.join(" ")})`;
  }
  return message;
}

/** The title of the button that shows what the process plugins of an approval run with. */
export const SHOW_CONFIGURATION_TITLE = "Show Configuration";

/**
 * Gets what the process plugins of the approval run with as text to show the user before they
 * decide, which is undefined when there's nothing to show.
 */
export function getApprovalConfiguration(approval: PendingApproval) {
  const configurations = approval.items
    .filter(item => item.configuration != null)
    .map(item => [item.plugin?.configKey ?? item.specifier, item.configuration]);
  const sections: string[] = [];
  if (configurations.length > 0) {
    sections.push(
      `// what the process plugins run with\n${JSON.stringify(Object.fromEntries(configurations), undefined, 2)}`,
    );
  }
  // what a process plugin that wasn't set up before runs with, which includes what the config file extends
  if (approval.trustedConfiguration != null) {
    sections.push(
      `// what the process plugins that weren't set up before run with\n${
        JSON.stringify(approval.trustedConfiguration, undefined, 2)
      }`,
    );
  }
  return sections.length === 0 ? undefined : sections.join("\n\n");
}

/**
 * Gets text that's shown as it is in a notification, which shows a Markdown link (ex. one that runs
 * a command) as a link otherwise. dprint's messages have text from config files.
 */
export function toPlainNotificationText(text: string) {
  return text.replace(/\]\(/g, "]\u200B(");
}

/** Gets the path of a file uri to show the user, which is the uri for another kind of uri (ex. https). */
export function getDisplayPath(uri: string) {
  try {
    const url = new URL(uri);
    return url.protocol === "file:" ? fileURLToPath(url) : uri;
  } catch {
    return uri;
  }
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
function getChangedResult(err: unknown): ConfigApprovals | undefined {
  const data = typeof err === "object" && err != null && "data" in err ? err.data as ErrorData | undefined : undefined;
  const current = data?.kind === "approvalChanged" && "current" in data
    ? data.current as ConfigApprovals | undefined
    : undefined;
  return current != null && Array.isArray(current.approvals) ? current : undefined;
}

/** Gets if the decision allows the approval, which dprint says for a decision the extension doesn't know. */
function isAllowed(approval: PendingApproval, decision: ApprovalDecision) {
  const option = approval.decisions.find(option => option.id === decision);
  return option?.allows ?? (decision === "allow" || decision === "alwaysAllow");
}
