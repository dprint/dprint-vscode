import { fileURLToPath } from "node:url";
import {
  APPROVAL_CHANGED_ERROR_CODE,
  type ApprovalDecision,
  type ApprovalItem,
  type ApproveParams,
  type ApproveResult,
  type ConfigApprovals,
  type ConfigFileIdentifier,
  type ErrorData,
  type FormatStatus,
  getNotFormatted,
  type NotFormatted,
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
  /**
   * Sends what the user decided to dprint, which is sent again without the user doing anything
   * when `isResent` is true (ex. after dprint was started again).
   */
  approve(params: ApproveParams, options?: { isResent?: boolean }): Promise<ApproveResult>;
  /** Gets what needs to be approved for the config file and whether it's used. */
  pendingApprovals(configFile: ConfigFileIdentifier): Promise<ConfigApprovals>;
  /**
   * Shows why the config file isn't used after what the user allowed (ex. allowing a download
   * revealed an error in it).
   */
  showNotUsed?(notFormatted: NotFormatted, configFile: ConfigFileIdentifier): void;
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
  readonly #sessionDecisions = new Map<string, SessionDecision>();
  /**
   * The "Always" decisions by config file that aren't known to be stored yet, which are kept for the
   * session when a later result for the config file says one couldn't be stored (ex. after allowing
   * the download that sets up the process plugins, which may be asked about on its own).
   */
  readonly #unstoredAlwaysDecisions = new Map<string, [PendingApproval, ApprovalDecision][]>();
  /** Whether what the user answers isn't used anymore (see `cancel`). */
  #isCancelled = false;

  constructor(options: ApprovalsOptions) {
    this.#options = options;
  }

  /**
   * Stops using what the user answers to the prompts that are open and asking about anything else
   * (ex. after the restart command, which starts a new dprint process that asks again).
   */
  cancel() {
    this.#isCancelled = true;
  }

  /** Forgets which approvals the user was asked about (ex. they forgot their decisions), so they're asked again. */
  forget() {
    this.#asked.clear();
    this.#sessionDecisions.clear();
    this.#unstoredAlwaysDecisions.clear();
  }

  /**
   * Sends what the user decided for the session again for the approvals that are pending again
   * without asking (ex. for a dprint process that was started again after it exited, which doesn't
   * know it), which resolves to whether any was sent.
   */
  async sendSessionDecisionsAgain(pending: PendingApproval[]) {
    let isSent = false;
    const queue = [...pending];
    const sent = new Set<string>();
    while (queue.length > 0 && !this.#isCancelled) {
      const approval = queue.shift()!;
      const decision = sent.has(approval.id) ? undefined : this.#getSessionDecision(approval);
      if (decision == null) {
        continue;
      }
      sent.add(approval.id);
      try {
        const result = await this.#options.approve({ id: approval.id, decision }, { isResent: true });
        isSent = true;
        // what a decision that was sent again reveals may have a decision for the session too
        queue.push(...result.approvals);
      } catch {
        // it's asked about again
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
    // the decisions to send again for an approval that's pending again after it changed, which is
    // only done once for an approval
    const decisionsToSendAgain = new Map<string, ApprovalDecision>();
    const sentAgain = new Set<string>();
    // whether an approval wasn't asked about, so not everything was allowed
    let isSkipped = false;
    // the config file of the last decision, which a status after it is for
    let lastConfigFile: ConfigFileIdentifier | undefined;
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
      let decision = decisionsToSendAgain.get(approval.id);
      decisionsToSendAgain.delete(approval.id);
      if (decision != null && approval.denied && isAllowed(approval, decision)) {
        // dprint knows it was denied since (ex. in another window), which is newer
        decision = undefined;
      }
      decision ??= this.#getSessionDecision(approval);
      if (options.isExplicit && decision != null && !isAllowed(approval, decision)) {
        decision = undefined;
      }
      if (decision == null) {
        // an approval of process plugins that were set up since was asked about by the id it had before
        const wasAsked = this.#asked.has(approval.id)
          || getPreviousIds(approval).some(id => this.#asked.has(id));
        if (!options.isExplicit && (approval.denied || wasAsked)) {
          // the others are still asked about
          isSkipped = true;
          continue;
        }
        if (this.#isCancelled) {
          return false;
        }
        this.#asked.add(approval.id);
        decision = await this.#options.ask(approval, getApprovalChoices(approval));
        if (decision == null || this.#isCancelled) {
          // it stays pending, so the user can still approve it with the command
          return false;
        }
      }
      const allows = isAllowed(approval, decision);
      const configFile = { uri: approval.configFile.uri, dirUri: approval.configFile.dirUri };
      lastConfigFile = configFile;
      this.#rememberSessionDecision(approval, decision);
      const configFileKey = `${configFile.uri}\n${configFile.dirUri}`;
      if (approval.decisions.find(option => option.id === decision)?.always) {
        const unstored = this.#unstoredAlwaysDecisions.get(configFileKey) ?? [];
        unstored.push([approval, decision]);
        this.#unstoredAlwaysDecisions.set(configFileKey, unstored);
      }
      try {
        const result = await this.#options.approve({ id: approval.id, decision });
        if (result.notice != null) {
          // ex. an "Always" decision that couldn't be stored is still used for the session
          for (const [alwaysApproval, alwaysDecision] of this.#unstoredAlwaysDecisions.get(configFileKey) ?? []) {
            this.#setSessionDecision(alwaysApproval, alwaysDecision);
          }
          this.#unstoredAlwaysDecisions.delete(configFileKey);
        } else if (result.status.kind === "ready") {
          // dprint stored them once the config file is used
          this.#unstoredAlwaysDecisions.delete(configFileKey);
        }
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
        if (allows && pending.some(other => other.id === approval.id) && !sentAgain.has(approval.id)) {
          // the same approval is pending again, so the user's decision is sent again once
          askedNow.delete(approval.id);
          sentAgain.add(approval.id);
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
    const notFormatted = status == null ? undefined : getNotFormatted(status);
    if (!isSkipped && notFormatted != null && (notFormatted.approvals ?? []).every(approval => approval.denied)) {
      this.#options.showNotUsed?.(notFormatted, lastConfigFile!);
    }
    return !isSkipped && notFormatted == null;
  }

  /**
   * Gets what the user decided for the session about the approval when it's still what's used,
   * which isn't an allow that the user denied since (ex. with "Always Deny" in another window).
   */
  #getSessionDecision(approval: PendingApproval) {
    // an approval may have had other ids before (ex. before its process plugins were set up),
    // where the one for its id wins and then the earlier ones in order
    const decision = [approval.id, ...getPreviousIds(approval)]
      .map(id => this.#sessionDecisions.get(id))
      .find(decision => decision != null)?.decision;
    if (decision == null || !approval.decisions.some(option => option.id === decision)) {
      return undefined;
    }
    if (approval.denied) {
      // dprint knows it's denied, which is newer than an allow
      if (isAllowed(approval, decision)) {
        this.#forgetSessionDecision(approval);
      }
      return undefined;
    }
    return decision;
  }

  /** Remembers what the user decided for the session, which an "Always" decision replaces. */
  #rememberSessionDecision(approval: PendingApproval, decision: ApprovalDecision) {
    this.#forgetSessionDecision(approval);
    if (approval.decisions.find(option => option.id === decision)?.always) {
      // it replaces what was decided before in its group too
      this.#forgetGroup(getDecisionGroup(approval));
    } else {
      this.#setSessionDecision(approval, decision);
    }
  }

  /**
   * Uses the decision for the session, which replaces what was decided before in its group (ex. a
   * denial replaces an allow of an earlier configuration of a config file's process plugins).
   */
  #setSessionDecision(approval: PendingApproval, decision: ApprovalDecision) {
    const decisionGroup = getDecisionGroup(approval);
    this.#forgetGroup(decisionGroup);
    this.#sessionDecisions.set(approval.id, { decision, decisionGroup });
  }

  /** Forgets what the user decided for the session in the group. */
  #forgetGroup(decisionGroup: string) {
    for (const [id, existing] of this.#sessionDecisions) {
      if (existing.decisionGroup === decisionGroup) {
        this.#sessionDecisions.delete(id);
      }
    }
  }

  /** Forgets what the user decided for the session about the approval, including by its earlier ids. */
  #forgetSessionDecision(approval: PendingApproval) {
    for (const id of [approval.id, ...getPreviousIds(approval)]) {
      this.#sessionDecisions.delete(id);
    }
  }
}

/** What the user decided for the session about an approval. */
interface SessionDecision {
  decision: ApprovalDecision;
  /** The decisions it replaces have the same group. */
  decisionGroup: string;
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
  // a notification is cut off after 1000 characters, so what's approved is shown on its own
  message += ` Choose "${SHOW_DETAILS_TITLE}" to see what's approved.`;
  // the descriptions of the decisions, which can't be tooltips of the buttons
  const descriptions = approval.decisions
    .filter(option => option.description.length > 0)
    .map(option => `${option.label}: ${option.description}`);
  if (descriptions.length > 0) {
    message += ` (${descriptions.join(" ")})`;
  }
  return message;
}

/** The title of the button that shows what's approved and what the process plugins run with. */
export const SHOW_DETAILS_TITLE = "Show Details";

/**
 * Gets what's approved (each item, and what the process plugins run with) as text to show the
 * user before they decide.
 */
export function getApprovalDetails(approval: PendingApproval) {
  const sections = [`// ${toCommentLine(approval.title)}\n${toCommentLines(approval.message)}`];
  sections.push(
    `// what's approved\n${approval.items.map(item => `// - ${toCommentLine(getItemText(item))}`).join("\n")}`,
  );
  const configurations = approval.items
    .filter(item => item.configuration != null)
    .map(item => [item.plugin?.configKey ?? item.specifier, item.configuration]);
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
  return sections.join("\n\n");
}

/** Gets text as lines of comments, which text from a config file can't end (ex. to add a section). */
function toCommentLines(text: string) {
  return text.split(/\r\n|[\r\n\u2028\u2029]/).map(line => `// ${line}`).join("\n");
}

/** Gets text as one line of a comment. */
function toCommentLine(text: string) {
  return text.replace(/\r\n|[\r\n\u2028\u2029]/g, " ");
}

/** Gets the group of the approval's decisions, which is its own when dprint doesn't say. */
function getDecisionGroup(approval: PendingApproval) {
  return approval.decisionGroup ?? approval.id;
}

/** Gets the earlier ids of the approval, which are like its id. */
function getPreviousIds(approval: PendingApproval) {
  return approval.previousIds ?? [];
}

/** Gets the text of an approval's item, which has where it's from. */
function getItemText(item: ApprovalItem) {
  const specifier = toVisibleText(item.specifier);
  if (item.kind === "npmrcProxy") {
    const npmrc = item.npmrcUri == null ? "" : ` that ${getDisplayPath(item.npmrcUri)} sets`;
    return `the proxy ${specifier}${npmrc}`;
  }
  return item.registry == null ? specifier : `${specifier} (from the npm registry ${toVisibleText(item.registry)})`;
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
  let path: string;
  try {
    const url = new URL(uri);
    path = url.protocol === "file:" ? fileURLToPath(url) : uri;
  } catch {
    path = uri;
  }
  // it's from the project (ex. the name of a directory)
  return toVisibleText(path);
}

/**
 * Gets text from the project that's shown with the extension's own text, where the characters that
 * change how text around them looks are escaped (ex. a line break or one that reverses the text
 * after it) like dprint escapes them in its messages.
 */
export function toVisibleText(text: string) {
  return text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, char => `\\u{${char.codePointAt(0)!.toString(16)}}`);
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
