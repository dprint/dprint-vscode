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
  /** Sends what the user decided to dprint. */
  approve(params: ApproveParams): Promise<ApproveResult>;
  /** Gets what needs to be approved for the config file and whether it's used. */
  pendingApprovals(configFile: ConfigFileIdentifier): Promise<ConfigApprovals>;
  /**
   * Shows why the config file isn't used after what the user allowed (ex. allowing a download
   * revealed an error in it).
   */
  showNotUsed?(notFormatted: NotFormatted, configFile: ConfigFileIdentifier): void;
  /**
   * Tells the user that what they allowed was denied since (ex. in another window), which is when
   * sending their decision failed and its approval is denied afterwards, so it wasn't used.
   */
  showDeniedSince?(approval: PendingApproval): void;
}

/**
 * Asks the user about what a config file needs approved for one dprint process. Each
 * approval is only asked about once until the user decides about it, unless the user asks
 * for it (ex. with a command), because the editor formats without the user doing anything
 * in between (ex. on save).
 */
export class Approvals {
  readonly #options: ApprovalsOptions;
  /** The approvals the user was asked about without deciding (ex. they dismissed the prompt), see `getAskedKey`. */
  readonly #asked = new Set<string>();
  /** The approvals being asked about, which the formats of the other documents of the config file share. */
  readonly #inProgress = new Map<string, Promise<boolean>>();
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

  /**
   * Forgets which approvals the user was asked about, which is for every config file because the
   * decisions are only forgotten for every one (ex. they forgot their decisions), so they're asked again.
   */
  forget() {
    this.#asked.clear();
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
    // the decisions to send again for an approval that's still pending after sending one failed
    const decisionsToSendAgain = new Map<string, ApprovalDecision>();
    // the approvals a decision was sent again to (or a denial was forwarded to), which is only done once
    // for an approval so the user's decision is sent at most twice
    const sentAgain = new Set<string>();
    // whether an approval wasn't asked about, so not everything was allowed
    let isSkipped = false;
    // the config file of the last decision, which a status after it is for
    let lastConfigFile: ConfigFileIdentifier | undefined;
    while (pending.length > 0) {
      // a decision is sent again before anything else is asked about
      const approval = pending.find(approval => decisionsToSendAgain.has(approval.id))
        ?? pending.find(approval => !askedNow.has(approval.id));
      if (approval == null) {
        // what's left was denied
        return false;
      }
      askedNow.add(approval.id);
      // the user's decision is sent again for an approval that's still pending after sending it failed
      let decision = decisionsToSendAgain.get(approval.id);
      decisionsToSendAgain.delete(approval.id);
      if (decision == null) {
        const askedKey = getAskedKey(approval);
        if (!options.isExplicit && (approval.denied || this.#asked.has(askedKey))) {
          // the others are still asked about
          isSkipped = true;
          continue;
        }
        if (this.#isCancelled) {
          return false;
        }
        this.#asked.add(askedKey);
        decision = await this.#options.ask(approval, getApprovalChoices(approval));
        if (decision != null) {
          // the user decided, so it's asked about again when it's pending again later whatever dprint did
          // with the decision (ex. a changed process plugin configuration, a server that didn't keep the
          // session, or a forget in another window)
          this.#asked.delete(askedKey);
        }
        if (decision == null || this.#isCancelled) {
          // it stays pending, so the user can still approve it with the command
          return false;
        }
      }
      const allows = isAllowed(approval, decision);
      const configFile = { uri: approval.configFile.uri, dirUri: approval.configFile.dirUri };
      lastConfigFile = configFile;
      try {
        const result = await this.#options.approve({ id: approval.id, decision });
        pending = result.approvals;
        status = result.status;
      } catch (err) {
        // what's pending is gotten again whatever the failure was, because the decision may not have been
        // used (ex. dprint was started again before it received it, or what needs to be approved changed)
        // or may have been (ex. only the response was lost)
        try {
          ({ approvals: pending, status } = (isApprovalChangedError(err) ? getChangedResult(err) : undefined)
            ?? await this.#options.pendingApprovals(configFile));
        } catch {
          throw err;
        }
        const same = pending.find(other => other.id === approval.id);
        if (same != null && !same.denied && !sentAgain.has(approval.id)) {
          // the same approval is pending again, which is exactly what the user saw, so the decision is sent again
          // once instead of asking (an allow isn't sent for one that's denied, which would replace a denial made
          // since, ex. in another window)
          askedNow.delete(approval.id);
          sentAgain.add(approval.id);
          decisionsToSendAgain.set(approval.id, decision);
          continue;
        }
        if (!allows) {
          await this.#forwardDenial(approval, decision, pending, sentAgain);
        }
        if (same != null && !same.denied) {
          // the decision still wasn't used, because sending it again failed too
          throw err;
        }
        if (allows && same?.denied) {
          // a denial made since is newer than the user's allow, which isn't sent again
          this.#options.showDeniedSince?.(approval);
        }
        if (!allows) {
          // what replaced it isn't asked about right after the user denied it
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
   * Denies what replaced an approval the user denied when it's some of what they saw for the same config
   * file, which is never done for allowing it. The same approval is preferred, and the denial isn't sent
   * to an approval that was sent a decision again in the request, so it's sent at most twice.
   */
  async #forwardDenial(
    approval: PendingApproval,
    decision: ApprovalDecision,
    pending: PendingApproval[],
    sentAgain: Set<string>,
  ) {
    const deniedItems = new Set(approval.items.map(item => item.specifier));
    const replacements = pending.filter(other =>
      other.kind === approval.kind
      && other.configFile.uri === approval.configFile.uri
      && other.configFile.dirUri === approval.configFile.dirUri
      && !other.denied
      && !sentAgain.has(other.id)
      && other.items.every(item => deniedItems.has(item.specifier))
    );
    const replacement = replacements.find(other => other.id === approval.id) ?? replacements[0];
    if (replacement == null || !replacement.decisions.some(option => option.decision === decision)) {
      return;
    }
    sentAgain.add(replacement.id);
    await this.#options.approve({ id: replacement.id, decision })
      .catch(() => {/* it's asked about later */});
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
      `// what the process plugins run with\n${toVisibleJson(Object.fromEntries(configurations))}`,
    );
  }
  // what a process plugin that wasn't set up before runs with, which includes what the config file extends
  if (approval.trustedConfiguration != null) {
    sections.push(
      `// what the process plugins that weren't set up before run with\n${
        toVisibleJson(approval.trustedConfiguration)
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

/**
 * Gets the JSON text of what's from the project (ex. the configuration of a process plugin), where
 * its strings are escaped like other text from the project apart from the line breaks of the JSON.
 */
function toVisibleJson(value: unknown) {
  return JSON.stringify(value, undefined, 2).split("\n").map(toVisibleText).join("\n");
}

/**
 * Gets what identifies an approval that was asked about, which is what's approved rather than its id
 * because its id changes when what's shown about it does (ex. once its process plugins are set up).
 */
function getAskedKey(approval: PendingApproval) {
  const specifiers = approval.items.map(item => item.specifier).sort();
  return JSON.stringify([approval.configFile.uri, approval.configFile.dirUri, approval.kind, specifiers]);
}

/** Gets the text of an approval's item, which has where it's from. */
function getItemText(item: ApprovalItem) {
  // dprint escaped the specifier and registry already
  if (item.kind === "npmrcProxy") {
    const npmrc = item.npmrcUri == null ? "" : ` that ${getDisplayPath(item.npmrcUri)} sets`;
    return `the proxy ${item.specifier}${npmrc}`;
  }
  if (item.kind === "networkPath") {
    const reachedFrom = item.localUri == null ? "" : `, which ${getDisplayPath(item.localUri)} in the project reaches`;
    return `${item.specifier} (read from another machine${reachedFrom})`;
  }
  if (item.registry == null) {
    return item.specifier;
  }
  // the download of a registry itself, which allows every url under it unlike another url
  if (item.registry === item.specifier) {
    return `the npm registry ${item.specifier} (allowing it allows every package from it)`;
  }
  return `${item.specifier} (from the npm registry ${item.registry})`;
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
 * after it) like dprint escapes the text it provides (see `ApprovalItem.specifier` in its spec).
 */
export function toVisibleText(text: string) {
  return text.replace(ESCAPED_TEXT_PATTERN, char => `\\u{${char.codePointAt(0)!.toString(16)}}`);
}

/**
 * What dprint escapes in what it provides from the project (see `ApprovalItem.specifier` in its spec):
 * a combining mark at the start, a character other than a plain space that's a control, format,
 * separator or default ignorable one (ex. a bidi override), and a backslash followed by `u{`.
 */
const ESCAPED_TEXT_PATTERN =
  /^[\p{Mn}\p{Me}]|(?! )[\p{Cc}\p{Cf}\p{Cn}\p{Z}\p{Default_Ignorable_Code_Point}]|\\(?=u\{)/gu;

/** Gets what the user can decide about the approval, which are the decisions dprint says it has. */
export function getApprovalChoices(approval: Pick<PendingApproval, "decisions">): ApprovalChoice[] {
  return approval.decisions.map(option => ({ title: option.label, decision: option.decision }));
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
  const option = approval.decisions.find(option => option.decision === decision);
  return option?.allows ?? (decision === "allow" || decision === "alwaysAllow");
}
