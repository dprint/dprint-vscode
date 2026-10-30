import * as assert from "node:assert";
import { describe, it } from "node:test";
import {
  type ApprovalChoice,
  Approvals,
  getApprovalChoices,
  getApprovalDetails,
  getApprovalMessage,
  toPlainNotificationText,
} from "./approvals";
import type { ApprovalDecision, ApproveParams, ConfigFileInfo, FormatStatus, PendingApproval } from "./messages";

const READY: FormatStatus = { kind: "ready" };

describe("Approvals", () => {
  it("asks about the approval and what else needs to be approved after it", async () => {
    const extended = approval("extended");
    const { approvals, asked, approved } = createApprovals({
      decide: () => "allow",
      approvalsAfter: { download: [extended] },
    });

    assert.strictEqual(await approvals.request([approval("download")], { isExplicit: false }), true);
    assert.deepStrictEqual(asked, ["download", "extended"]);
    assert.deepStrictEqual(approved, [{ id: "download", decision: "allow" }, { id: "extended", decision: "allow" }]);
  });

  it("asks about each approval that's pending at once", async () => {
    const processPlugins = approval("processPlugins");
    const { approvals, asked } = createApprovals({
      decide: () => "allow",
      // what's left after allowing the download
      approvalsAfter: { download: [processPlugins] },
    });

    assert.strictEqual(await approvals.request([approval("download"), processPlugins], { isExplicit: false }), true);
    assert.deepStrictEqual(asked, ["download", "processPlugins"]);
  });

  it("is false when the user denies or dismisses it", async () => {
    const denied = createApprovals({ decide: () => "alwaysDeny" });
    assert.strictEqual(await denied.approvals.request([approval("processPlugins")], { isExplicit: false }), false);
    assert.deepStrictEqual(denied.approved, [{ id: "processPlugins", decision: "alwaysDeny" }]);

    const dismissed = createApprovals({ decide: () => undefined });
    assert.strictEqual(await dismissed.approvals.request([approval("download")], { isExplicit: false }), false);
    // it stays pending
    assert.deepStrictEqual(dismissed.approved, []);
  });

  it("only asks once unless the user asks for it", async () => {
    const { approvals, asked } = createApprovals({ decide: () => undefined });

    await approvals.request([approval("download")], { isExplicit: false });
    assert.strictEqual(await approvals.request([approval("download")], { isExplicit: false }), false);
    assert.deepStrictEqual(asked, ["download"]);
    await approvals.request([approval("download")], { isExplicit: true });
    assert.deepStrictEqual(asked, ["download", "download"]);
  });

  it("only asks about what the user denied when they ask for it", async () => {
    const { approvals, asked } = createApprovals({ decide: () => "allow" });

    const denied = { ...approval("download"), denied: true };
    assert.strictEqual(await approvals.request([denied], { isExplicit: false }), false);
    assert.deepStrictEqual(asked, []);
    assert.strictEqual(await approvals.request([denied], { isExplicit: true }), true);
    assert.deepStrictEqual(asked, ["download"]);
  });

  it("shares the request that's in progress", async () => {
    let decide!: (decision: ApprovalDecision) => void;
    const asked: string[] = [];
    const approvals = new Approvals({
      pendingApprovals: async () => ({ configFile: null, approvals: [], status: READY }),
      ask: pending => {
        asked.push(pending.id);
        return new Promise(resolve => decide = resolve);
      },
      approve: async () => ({ configFile: null, approvals: [], status: READY }),
    });

    const first = approvals.request([approval("download")], { isExplicit: false });
    const second = approvals.request([approval("download")], { isExplicit: false });
    await new Promise<void>(resolve => setImmediate(resolve));
    decide("allow");
    assert.deepStrictEqual(await Promise.all([first, second]), [true, true]);
    assert.deepStrictEqual(asked, ["download"]);
  });

  it("rejects when approving fails and it's still pending", async () => {
    const approvals = new Approvals({
      pendingApprovals: async () => ({ configFile: null, approvals: [approval("download")], status: READY }),
      ask: async () => "allow",
      approve: () => Promise.reject(new Error("Failed.")),
    });
    await assert.rejects(approvals.request([approval("download")], { isExplicit: false }), /Failed/);
    // the decision was used when it isn't pending anymore (ex. only the response was lost)
    const used = new Approvals({
      pendingApprovals: async () => ({ configFile: null, approvals: [], status: READY }),
      ask: async () => "allow",
      approve: () => Promise.reject(new Error("Failed.")),
    });
    assert.strictEqual(await used.request([approval("download")], { isExplicit: false }), true);
    // a denial that fails is said
    const denied = new Approvals({
      pendingApprovals: async () => ({ configFile: null, approvals: [], status: READY }),
      ask: async () => "deny",
      approve: () => Promise.reject(new Error("Failed.")),
    });
    await assert.rejects(denied.request([approval("download")], { isExplicit: false }), /Failed/);
  });

  it("formats again when what needs to be approved changed", async () => {
    const changedError = Object.assign(new Error("Changed."), { code: -32803, data: { kind: "approvalChanged" } });
    const allowed = new Approvals({
      ask: async () => "allow",
      approve: () => Promise.reject(changedError),
      pendingApprovals: async () => ({ configFile: null, approvals: [], status: READY }),
    });
    assert.strictEqual(await allowed.request([approval("download")], { isExplicit: false }), true);
    const denied = new Approvals({
      ask: async () => "deny",
      approve: () => Promise.reject(changedError),
      pendingApprovals: async () => ({ configFile: null, approvals: [], status: READY }),
    });
    assert.strictEqual(await denied.request([approval("download")], { isExplicit: false }), false);
  });

  it("asks about what needs to be approved now when the error says", async () => {
    const changed = approval("changed");
    const changedError = Object.assign(new Error("Changed."), {
      code: -32803,
      data: { kind: "approvalChanged", current: { configFile: null, approvals: [changed], status: READY } },
    });
    const asked: string[] = [];
    const approvals = new Approvals({
      pendingApprovals: async () => ({ configFile: null, approvals: [], status: READY }),
      ask: async pending => {
        asked.push(pending.id);
        return "allow";
      },
      approve: async params => {
        if (params.id === "download") {
          throw changedError;
        }
        return { configFile: null, approvals: [], status: READY };
      },
    });
    assert.strictEqual(await approvals.request([approval("download")], { isExplicit: false }), true);
    assert.deepStrictEqual(asked, ["download", "changed"]);
  });

  it("asks about what's pending for the config file when what needs to be approved changed", async () => {
    const changedError = Object.assign(new Error("Changed."), { code: -32803, data: { kind: "approvalChanged" } });
    const changed = { ...approval("changed"), configFile: configFile("file:///dprint.json") };
    const other = { ...approval("other"), configFile: configFile("file:///other/dprint.json") };
    const asked: string[] = [];
    const approvals = new Approvals({
      ask: async pending => {
        asked.push(pending.id);
        return "allow";
      },
      approve: async params => {
        if (params.id === "download") {
          throw changedError;
        }
        return { configFile: null, approvals: [], status: READY };
      },
      // dprint only provides what's pending for the config file
      pendingApprovals: async configFile => ({
        configFile: null,
        approvals: [other, changed].filter(a => a.configFile.uri === configFile.uri),
        status: READY,
      }),
    });
    const download = { ...approval("download"), configFile: configFile("file:///dprint.json") };
    assert.strictEqual(await approvals.request([download], { isExplicit: false }), true);
    assert.deepStrictEqual(asked, ["download", "changed"]);
  });

  it("is false when the config file isn't used after it's allowed", async () => {
    // ex. it has an error
    const { approvals } = createApprovals({
      decide: () => "allow",
      statusAfter: { kind: "notFormatted", reason: "configError", show: "oncePerConfigFile", claim: true },
    });
    assert.strictEqual(await approvals.request([approval("download")], { isExplicit: false }), false);
  });

  it("uses whether a decision that's newer than the extension allows it", async () => {
    const download = approval("download");
    download.decisions.push({
      id: "trustDomain",
      label: "Trust the domain",
      allows: true,
      always: true,
      description: "",
    });
    download.decisions.push({ id: "block", label: "Block", allows: false, always: true, description: "" });
    const allowed = createApprovals({ decide: () => "trustDomain" });
    assert.strictEqual(await allowed.approvals.request([download], { isExplicit: false }), true);
    const denied = createApprovals({ decide: () => "block" });
    assert.strictEqual(await denied.approvals.request([download], { isExplicit: false }), false);
  });

  it("gets what's pending again when approving fails with an error that isn't known", async () => {
    // ex. a language client library's own error with the same code
    const otherError = Object.assign(new Error("Other."), { code: -32803 });
    const pending = { ...approval("processPlugins"), configFile: configFile("file:///dprint.json") };
    const asked: string[] = [];
    const approvals = new Approvals({
      ask: async approval => {
        asked.push(approval.id);
        return "allow";
      },
      approve: async params => {
        if (params.id === "download") {
          throw otherError;
        }
        return { configFile: null, approvals: [], status: READY };
      },
      pendingApprovals: async () => ({ configFile: null, approvals: [pending], status: READY }),
    });
    const download = { ...approval("download"), configFile: configFile("file:///dprint.json") };
    assert.strictEqual(await approvals.request([download], { isExplicit: false }), true);
    assert.deepStrictEqual(asked, ["download", "processPlugins"]);
  });

  it("only denies what replaced a denied approval when it's some of what the user saw", async () => {
    // a plugin was added since the prompt was shown
    const replacement = {
      ...approval("processPlugins"),
      id: "replacement",
      items: [...approval("processPlugins").items, { specifier: "https://example.com/added", kind: "plugin" }],
    };
    const approved: ApproveParams[] = [];
    const approvals = new Approvals({
      ask: async () => "deny",
      approve: async params => {
        approved.push(params);
        throw Object.assign(new Error("Changed."), {
          code: -32803,
          data: { kind: "approvalChanged", current: { configFile: null, approvals: [replacement], status: READY } },
        });
      },
      pendingApprovals: async () => ({ configFile: null, approvals: [], status: READY }),
    });
    assert.strictEqual(await approvals.request([approval("processPlugins")], { isExplicit: false }), false);
    assert.deepStrictEqual(approved, [{ id: "processPlugins", decision: "deny" }]);
  });

  it("doesn't use what the user answers once it's cancelled", async () => {
    let approvals: Approvals;
    const created = createApprovals({
      decide: () => {
        // ex. the user restarted dprint while the prompt was open
        approvals.cancel();
        return "allow";
      },
    });
    approvals = created.approvals;
    assert.strictEqual(await approvals.request([approval("processPlugins")], { isExplicit: false }), false);
    assert.deepStrictEqual(created.approved, []);
  });

  it("sends what the user decided for the session again for the id an approval had before it was set up", async () => {
    const { approvals, approved, asked } = createApprovals({ decide: () => "allow" });
    await approvals.request([approval("processPlugins")], { isExplicit: false });
    approved.length = 0;
    const setUp = { ...approval("processPlugins"), id: "setUp", previousIds: ["processPlugins"] };
    assert.strictEqual(await approvals.sendSessionDecisionsAgain([setUp]), true);
    assert.deepStrictEqual(approved, [{ id: "setUp", decision: "allow" }]);
    assert.deepStrictEqual(asked, ["processPlugins"]);
  });

  it("sends what the user decided for the session again for what a decision that was sent again reveals", async () => {
    const { approvals, approved } = createApprovals({
      decide: () => "allow",
      approvalsAfter: { download: [approval("processPlugins")] },
    });
    await approvals.request([approval("download")], { isExplicit: false });
    approved.length = 0;
    assert.strictEqual(await approvals.sendSessionDecisionsAgain([approval("download")]), true);
    assert.deepStrictEqual(approved, [{ id: "download", decision: "allow" }, {
      id: "processPlugins",
      decision: "allow",
    }]);
  });

  it("doesn't ask again about an approval that was asked about before it was set up", async () => {
    const { approvals, asked } = createApprovals({ decide: () => undefined });
    await approvals.request([approval("processPlugins")], { isExplicit: false });
    const setUp = { ...approval("processPlugins"), id: "setUp", previousIds: ["processPlugins"] };
    assert.strictEqual(await approvals.request([setUp], { isExplicit: false }), false);
    assert.deepStrictEqual(asked, ["processPlugins"]);
  });

  it("sends a decision again only once when its approval keeps being pending again", async () => {
    let sends = 0;
    const approvals = new Approvals({
      ask: async () => "allow",
      approve: async () => {
        sends++;
        throw Object.assign(new Error("Changed."), {
          code: -32803,
          data: {
            kind: "approvalChanged",
            current: { configFile: null, approvals: [approval("download")], status: READY },
          },
        });
      },
      pendingApprovals: async () => ({ configFile: null, approvals: [], status: READY }),
    });
    assert.strictEqual(await approvals.request([approval("download")], { isExplicit: false }), false);
    assert.strictEqual(sends, 2);
  });

  it("doesn't send an allow again for an approval that was denied since", async () => {
    const approved: ApproveParams[] = [];
    const approvals = new Approvals({
      ask: async () => "allow",
      approve: async params => {
        approved.push(params);
        throw Object.assign(new Error("Changed."), {
          code: -32803,
          data: {
            kind: "approvalChanged",
            current: { configFile: null, approvals: [{ ...approval("download"), denied: true }], status: READY },
          },
        });
      },
      pendingApprovals: async () => ({ configFile: null, approvals: [], status: READY }),
    });
    assert.strictEqual(await approvals.request([approval("download")], { isExplicit: false }), false);
    assert.deepStrictEqual(approved, [{ id: "download", decision: "allow" }]);
  });

  it("only keeps the most recent decision for the session about the process plugins of a config file", async () => {
    const { approvals, approved } = createApprovals({ decide: approval => approval.id === "first" ? "allow" : "deny" });
    await approvals.request([{ ...approval("processPlugins"), id: "first" }], { isExplicit: false });
    // a denial of another configuration of them replaces the allow
    await approvals.request([{ ...approval("processPlugins"), id: "second" }], { isExplicit: false });
    approved.length = 0;
    assert.strictEqual(
      await approvals.sendSessionDecisionsAgain([{ ...approval("processPlugins"), id: "first" }]),
      false,
    );
    assert.deepStrictEqual(approved, []);
  });

  it("shows why the config file isn't used after what the user allowed", async () => {
    const shown: string[] = [];
    const configError = {
      kind: "notFormatted" as const,
      reason: "configError",
      message: "The config file has an error.",
      show: "oncePerConfigFile",
      severity: "error",
      claim: true,
    };
    const approvals = new Approvals({
      ask: async () => "allow",
      approve: async () => ({ configFile: null, approvals: [], status: configError }),
      pendingApprovals: async () => ({ configFile: null, approvals: [], status: READY }),
      showNotUsed: notFormatted => shown.push(notFormatted.message),
    });
    assert.strictEqual(await approvals.request([approval("download")], { isExplicit: false }), false);
    assert.deepStrictEqual(shown, ["The config file has an error."]);
  });

  it("keeps an \"Always\" decision for the session when a later result says it couldn't be stored", async () => {
    const approved: ApproveParams[] = [];
    const notice = { message: "Failed storing it.", show: "always", severity: "warning" };
    const approvals = new Approvals({
      ask: async pending => pending.id === "processPlugins" ? "alwaysAllow" : "allow",
      approve: async params => {
        approved.push(params);
        // the process plugins are set up once the download is allowed, which is when it's stored
        return params.id === "processPlugins"
          ? { configFile: null, approvals: [approval("download")], status: READY }
          : { configFile: null, approvals: [], status: READY, notice };
      },
      pendingApprovals: async () => ({ configFile: null, approvals: [], status: READY }),
    });
    assert.strictEqual(await approvals.request([approval("processPlugins")], { isExplicit: false }), true);
    approved.length = 0;
    assert.strictEqual(await approvals.sendSessionDecisionsAgain([approval("processPlugins")]), true);
    // and what it reveals that was decided for the session
    assert.deepStrictEqual(approved, [{ id: "processPlugins", decision: "alwaysAllow" }, {
      id: "download",
      decision: "allow",
    }]);
  });

  it("asks about the other approvals when one was denied", async () => {
    const { approvals, asked } = createApprovals({ decide: () => "allow" });
    const denied = { ...approval("download"), denied: true };
    assert.strictEqual(await approvals.request([denied, approval("processPlugins")], { isExplicit: false }), false);
    assert.deepStrictEqual(asked, ["processPlugins"]);
  });

  it("sends what the user decided for the session again without asking", async () => {
    const { approvals, approved, asked } = createApprovals({ decide: () => "allow" });
    await approvals.request([approval("processPlugins")], { isExplicit: false });
    approved.length = 0;
    assert.strictEqual(
      await approvals.sendSessionDecisionsAgain([approval("processPlugins"), approval("other")]),
      true,
    );
    assert.deepStrictEqual(approved, [{ id: "processPlugins", decision: "allow" }]);
    assert.deepStrictEqual(asked, ["processPlugins"]);
    // not an allow for what was denied since
    approved.length = 0;
    const denied = { ...approval("processPlugins"), denied: true };
    assert.strictEqual(await approvals.sendSessionDecisionsAgain([denied]), false);
    assert.deepStrictEqual(approved, []);
  });

  it("sends what the user decided for the session again to a dprint process that was started again", async () => {
    const { approvals, approved, asked } = createApprovals({ decide: () => "allow" });
    await approvals.request([approval("processPlugins")], { isExplicit: false });
    approved.length = 0;
    // it's pending again because the new process doesn't know it
    assert.strictEqual(await approvals.request([approval("processPlugins")], { isExplicit: false }), true);
    assert.deepStrictEqual(approved, [{ id: "processPlugins", decision: "allow" }]);
    assert.deepStrictEqual(asked, ["processPlugins"]);
    // not when it was denied since
    approved.length = 0;
    const denied = { ...approval("processPlugins"), denied: true };
    assert.strictEqual(await approvals.request([denied], { isExplicit: false }), false);
    assert.deepStrictEqual(approved, []);
    // forgetting them asks again
    approvals.forget();
    await approvals.request([approval("processPlugins")], { isExplicit: false });
    assert.deepStrictEqual(asked, ["processPlugins", "processPlugins"]);
  });

  it("denies what replaced an approval the user denied, but never allows it", async () => {
    const replacement = { ...approval("processPlugins"), id: "replacement" };
    const approved: ApproveParams[] = [];
    const create = (decision: ApprovalDecision) =>
      new Approvals({
        ask: async () => decision,
        approve: async params => {
          approved.push(params);
          if (params.id === "processPlugins") {
            throw Object.assign(new Error("Changed."), {
              code: -32803,
              data: { kind: "approvalChanged", current: { configFile: null, approvals: [replacement], status: READY } },
            });
          }
          return { configFile: null, approvals: [], status: READY };
        },
        pendingApprovals: async () => ({ configFile: null, approvals: [], status: READY }),
      });
    assert.strictEqual(await create("deny").request([approval("processPlugins")], { isExplicit: false }), false);
    assert.deepStrictEqual(approved, [{ id: "processPlugins", decision: "deny" }, {
      id: "replacement",
      decision: "deny",
    }]);
    approved.length = 0;
    // the user is asked about what replaced it instead
    const allowed = create("allow");
    assert.strictEqual(await allowed.request([approval("processPlugins")], { isExplicit: false }), true);
    assert.deepStrictEqual(approved, [{ id: "processPlugins", decision: "allow" }, {
      id: "replacement",
      decision: "allow",
    }]);
  });

  it("doesn't ask about a denied approval after allowing one unless the user asks for it", async () => {
    const processPlugins = { ...approval("processPlugins"), denied: true };
    const { approvals, asked } = createApprovals({
      decide: () => "allow",
      approvalsAfter: { download: [processPlugins] },
    });
    assert.strictEqual(await approvals.request([approval("download")], { isExplicit: false }), false);
    assert.deepStrictEqual(asked, ["download"]);
  });
});

describe("getApprovalMessage", () => {
  it("has the config file", () => {
    assert.match(getApprovalMessage(approval("download")), /^Configuration file: .*dprint\.json\. Approve download\? /);
  });

  it("says how to see what's approved", () => {
    assert.match(getApprovalMessage(approval("processPlugins")), /Choose "Show Details" to see what's approved\.$/);
  });

  it("says when the config file is outside the workspace", () => {
    const download = {
      ...approval("download"),
      configFile: { ...configFile("file:///tmp/dprint.json"), inWorkspace: false },
    };
    assert.match(getApprovalMessage(download), /^The configuration file is outside the workspace: .*dprint\.json\. /);
  });

  it("has the descriptions of the decisions", () => {
    const download = approval("download");
    download.decisions = download.decisions.map(option =>
      option.id === "allow" ? { ...option, description: "Downloads it." } : option
    );
    assert.match(getApprovalMessage(download), / \(allow: Downloads it\.\)$/);
  });
});

describe("getApprovalDetails", () => {
  it("has what's approved and where it's from", () => {
    const download = approval("download");
    download.items = [
      { specifier: "https://example.com/plugin.wasm", kind: "plugin" },
      { specifier: "https://registry.example.com/", kind: "plugin", registry: "https://registry.example.com/" },
      { specifier: "https://${TOKEN}@proxy.example", kind: "npmrcProxy", npmrcUri: "https://example.com/.npmrc" },
    ];
    assert.strictEqual(
      getApprovalDetails(download),
      "// download\n// Approve download?\n\n// what's approved\n"
        + "// - https://example.com/plugin.wasm\n"
        + "// - https://registry.example.com/ (from the npm registry https://registry.example.com/)\n"
        + "// - the proxy https://${TOKEN}@proxy.example that https://example.com/.npmrc sets",
    );
  });

  it("has what the process plugins run with", () => {
    const processPlugins = approval("processPlugins");
    processPlugins.items[0] = {
      ...processPlugins.items[0],
      plugin: { name: "dprint-plugin-exec", version: "0.5.0", configKey: "exec" },
      configuration: { commands: [{ command: "a" }] },
    };
    assert.match(
      getApprovalDetails(processPlugins),
      new RegExp(
        "// what the process plugins run with\n"
          + escapeRegExp(JSON.stringify({ exec: { commands: [{ command: "a" }] } }, undefined, 2))
          + "$",
      ),
    );
  });

  it("has what the process plugins that weren't set up run with", () => {
    const processPlugins = { ...approval("processPlugins"), trustedConfiguration: { exec: { commands: [] } } };
    assert.match(
      getApprovalDetails(processPlugins),
      new RegExp(
        "// what the process plugins that weren't set up before run with\n"
          + escapeRegExp(JSON.stringify({ exec: { commands: [] } }, undefined, 2))
          + "$",
      ),
    );
  });
});

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("toPlainNotificationText", () => {
  it("doesn't have Markdown links", () => {
    assert.strictEqual(
      toPlainNotificationText("Run [this](command:workbench.action.terminal.new) [a] (b)"),
      "Run [this]\u200B(command:workbench.action.terminal.new) [a] (b)",
    );
  });
});

describe("getApprovalChoices", () => {
  it("offers the decisions dprint says the approval has", () => {
    assert.deepStrictEqual(
      getApprovalChoices({
        decisions: [{ id: "allow", label: "Allow", allows: true, always: false, description: "" }, {
          id: "deny",
          label: "Deny",
          allows: false,
          always: false,
          description: "",
        }],
      }).map(
        choice => [choice.title, choice.decision],
      ),
      [["Allow", "allow"], ["Deny", "deny"]],
    );
    assert.deepStrictEqual(
      getApprovalChoices({
        decisions: [
          { id: "allow", label: "Allow", allows: true, always: false, description: "" },
          { id: "alwaysAllow", label: "Always Allow", allows: true, always: true, description: "" },
          { id: "deny", label: "Deny", allows: false, always: false, description: "" },
          { id: "alwaysDeny", label: "Always Deny", allows: false, always: true, description: "" },
        ],
      }).map(choice => [
        choice.title,
        choice.decision,
      ]),
      [["Allow", "allow"], ["Always Allow", "alwaysAllow"], ["Deny", "deny"], ["Always Deny", "alwaysDeny"]],
    );
  });

  it("shows a decision that's newer than the extension with its label", () => {
    assert.deepStrictEqual(
      getApprovalChoices({
        decisions: [{ id: "allow", label: "Allow", allows: true, always: false, description: "" }, {
          id: "trustDomain",
          label: "Trust the domain",
          allows: true,
          always: false,
          description: "",
        }, { id: "deny", label: "Deny", allows: false, always: false, description: "" }],
      }).map(
        choice => [choice.title, choice.decision],
      ),
      [["Allow", "allow"], ["Trust the domain", "trustDomain"], ["Deny", "deny"]],
    );
  });
});

function createApprovals(options: {
  decide: (approval: PendingApproval, choices: ApprovalChoice[]) => ApprovalDecision | undefined;
  approvalsAfter?: Record<string, PendingApproval[]>;
  statusAfter?: FormatStatus;
}) {
  const asked: string[] = [];
  const approved: ApproveParams[] = [];
  const approvals = new Approvals({
    pendingApprovals: async () => ({ configFile: null, approvals: [], status: READY }),
    ask: async (pending, choices) => {
      asked.push(pending.id);
      return options.decide(pending, choices);
    },
    approve: async params => {
      approved.push(params);
      return {
        configFile: null,
        approvals: options.approvalsAfter?.[params.id] ?? [],
        status: options.statusAfter ?? READY,
      };
    },
  });
  return { approvals, asked, approved };
}

function approval(id: string): PendingApproval {
  const isProcessPlugins = id === "processPlugins";
  return {
    id,
    kind: isProcessPlugins ? "processPlugins" : "downloads",
    title: id,
    // the process plugins of a config file are one group, and a download is its own
    decisionGroup: isProcessPlugins ? "processPlugins:file:///dprint.json" : id,
    configFile: configFile("file:///dprint.json"),
    items: [{ specifier: `https://example.com/${id}`, kind: "plugin" }],
    decisions: (isProcessPlugins ? ["allow", "alwaysAllow", "deny", "alwaysDeny"] : ["allow", "deny"]).map(id => ({
      id,
      label: id,
      allows: id.endsWith("llow"),
      always: id.startsWith("always"),
      description: "",
    })),
    denied: false,
    message: `Approve ${id}?`,
  };
}

function configFile(uri: string): ConfigFileInfo {
  return { uri, dirUri: uri.slice(0, uri.lastIndexOf("/")), kind: "local", inWorkspace: true };
}
