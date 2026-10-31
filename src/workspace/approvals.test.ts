import * as assert from "node:assert";
import { describe, it } from "node:test";
import {
  type ApprovalChoice,
  Approvals,
  getApprovalChoices,
  getApprovalDetails,
  getApprovalMessage,
  toPlainNotificationText,
  toVisibleText,
} from "./approvals";
import type { ApprovalDecision, ApproveParams, ConfigFileInfo, FormatStatus, PendingApproval } from "./messages";

const READY: FormatStatus = { kind: "ready" };
const APPROVAL_REQUIRED: FormatStatus = {
  kind: "notFormatted",
  reason: "approvalRequired",
  message: "",
  show: "command",
  severity: "warning",
  claim: true,
};

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

  it("rejects when approving fails and it's still pending after it was sent again", async () => {
    for (const decision of ["allow", "deny"]) {
      const approved: ApproveParams[] = [];
      const approvals = new Approvals({
        pendingApprovals: async () => ({ configFile: null, approvals: [approval("download")], status: READY }),
        ask: async () => decision,
        approve: params => {
          approved.push(params);
          return Promise.reject(new Error("Failed."));
        },
      });
      await assert.rejects(approvals.request([approval("download")], { isExplicit: false }), /Failed/);
      assert.deepStrictEqual(approved, [{ id: "download", decision }, { id: "download", decision }]);
    }
  });

  it("uses a decision that isn't pending anymore after approving fails", async () => {
    // ex. only the response was lost
    for (const [decision, expected] of [["allow", true], ["deny", false]] as const) {
      const approved: ApproveParams[] = [];
      const approvals = new Approvals({
        pendingApprovals: async () => ({ configFile: null, approvals: [], status: READY }),
        ask: async () => decision,
        approve: params => {
          approved.push(params);
          return Promise.reject(new Error("Failed."));
        },
      });
      assert.strictEqual(await approvals.request([approval("download")], { isExplicit: false }), expected);
      assert.deepStrictEqual(approved, [{ id: "download", decision }]);
    }
  });

  it("sends a decision again once when approving fails and the same approval is still pending", async () => {
    // ex. dprint was killed before it received it and is started again
    for (const [decision, expected] of [["allow", true], ["deny", false]] as const) {
      const asked: string[] = [];
      const approved: ApproveParams[] = [];
      const approvals = new Approvals({
        pendingApprovals: async () => ({ configFile: null, approvals: [approval("download")], status: READY }),
        ask: async pending => {
          asked.push(pending.id);
          return decision;
        },
        approve: async params => {
          approved.push(params);
          if (approved.length === 1) {
            throw new Error("The dprint language server was stopped while the request was in progress.");
          }
          return { configFile: null, approvals: [], status: READY };
        },
      });
      assert.strictEqual(await approvals.request([approval("download")], { isExplicit: false }), expected);
      assert.deepStrictEqual(asked, ["download"]);
      assert.deepStrictEqual(approved, [{ id: "download", decision }, { id: "download", decision }]);
    }
  });

  it("denies what replaced a denied approval when approving fails, without asking about it", async () => {
    const replacement = { ...approval("processPlugins"), id: "replacement" };
    const asked: string[] = [];
    const approved: ApproveParams[] = [];
    const approvals = new Approvals({
      pendingApprovals: async () => ({ configFile: null, approvals: [replacement], status: READY }),
      ask: async pending => {
        asked.push(pending.id);
        return "deny";
      },
      approve: async params => {
        approved.push(params);
        if (params.id === "processPlugins") {
          throw new Error("Failed.");
        }
        return { configFile: null, approvals: [], status: READY };
      },
    });
    assert.strictEqual(await approvals.request([approval("processPlugins")], { isExplicit: false }), false);
    assert.deepStrictEqual(asked, ["processPlugins"]);
    assert.deepStrictEqual(approved, [{ id: "processPlugins", decision: "deny" }, {
      id: "replacement",
      decision: "deny",
    }]);
  });

  it("rejects with the error of approving when getting what's pending fails", async () => {
    for (const decision of ["allow", "deny"]) {
      const approvals = new Approvals({
        pendingApprovals: () => Promise.reject(new Error("Not running.")),
        ask: async () => decision,
        approve: () => Promise.reject(new Error("Failed.")),
      });
      await assert.rejects(approvals.request([approval("download")], { isExplicit: false }), /Failed/);
    }
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
      decision: "trustDomain",
      label: "Trust the domain",
      allows: true,
      always: true,
      description: "",
    });
    download.decisions.push({ decision: "block", label: "Block", allows: false, always: true, description: "" });
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
    const asked: string[] = [];
    const approvals = new Approvals({
      ask: async pending => {
        asked.push(pending.id);
        return "deny";
      },
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
    assert.strictEqual(await approvals.request([approval("processPlugins")], { isExplicit: false }), false);
    assert.deepStrictEqual(approved, [{ id: "processPlugins", decision: "deny" }]);
    // what replaced it isn't asked about in the same request, but is on a later save
    assert.deepStrictEqual(asked, ["processPlugins"]);
    await approvals.request([replacement], { isExplicit: false });
    assert.deepStrictEqual(asked, ["processPlugins", "replacement"]);
  });

  it("only denies what replaced a denied approval when it's for the same config file", async () => {
    const otherConfigFile = {
      ...approval("processPlugins"),
      id: "other",
      configFile: configFile("file:///sub/dprint.json"),
    };
    const otherDir = {
      ...approval("processPlugins"),
      id: "otherDir",
      configFile: { ...configFile("file:///dprint.json"), dirUri: "file:///sub" },
    };
    const approved: ApproveParams[] = [];
    const approvals = new Approvals({
      ask: async () => "deny",
      approve: async params => {
        approved.push(params);
        throw Object.assign(new Error("Changed."), {
          code: -32803,
          data: {
            kind: "approvalChanged",
            current: { configFile: null, approvals: [otherConfigFile, otherDir], status: READY },
          },
        });
      },
      pendingApprovals: async () => ({ configFile: null, approvals: [], status: READY }),
    });
    assert.strictEqual(await approvals.request([approval("processPlugins")], { isExplicit: false }), false);
    assert.deepStrictEqual(approved, [{ id: "processPlugins", decision: "deny" }]);
  });

  it("sends a decision again once instead of asking when the same approval is pending after it changed", async () => {
    // ex. dprint was started again before it received it, which doesn't know what it was for
    const changedError = Object.assign(new Error("Changed."), { code: -32803, data: { kind: "approvalChanged" } });
    const asked: string[] = [];
    const approved: ApproveParams[] = [];
    const approvals = new Approvals({
      ask: async pending => {
        asked.push(pending.id);
        return "allow";
      },
      approve: async params => {
        approved.push(params);
        if (approved.length === 1) {
          throw changedError;
        }
        return { configFile: null, approvals: [], status: READY };
      },
      pendingApprovals: async () => ({ configFile: null, approvals: [approval("download")], status: READY }),
    });
    assert.strictEqual(await approvals.request([approval("download")], { isExplicit: false }), true);
    assert.deepStrictEqual(asked, ["download"]);
    assert.deepStrictEqual(approved, [{ id: "download", decision: "allow" }, { id: "download", decision: "allow" }]);

    // a denial too, rather than to another approval it replaced
    const subset = { ...approval("processPlugins"), id: "subset", items: [] };
    const deniedAsked: string[] = [];
    const denied: ApproveParams[] = [];
    const denials = new Approvals({
      ask: async pending => {
        deniedAsked.push(pending.id);
        return "deny";
      },
      approve: async params => {
        denied.push(params);
        if (denied.length === 1) {
          throw changedError;
        }
        return { configFile: null, approvals: [], status: READY };
      },
      pendingApprovals: async () => ({
        configFile: null,
        approvals: [subset, approval("processPlugins")],
        status: READY,
      }),
    });
    assert.strictEqual(await denials.request([approval("processPlugins")], { isExplicit: false }), false);
    assert.deepStrictEqual(deniedAsked, ["processPlugins"]);
    assert.deepStrictEqual(denied, [{ id: "processPlugins", decision: "deny" }, {
      id: "processPlugins",
      decision: "deny",
    }]);
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

  it("sends a decision again only once when its approval keeps being pending again", async () => {
    // a denial isn't forwarded to the same approval a third time either
    for (const decision of ["allow", "deny"]) {
      let sends = 0;
      const approvals = new Approvals({
        ask: async () => decision,
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
      await assert.rejects(approvals.request([approval("download")], { isExplicit: false }), /Changed/);
      assert.strictEqual(sends, 2);
    }
  });

  it("doesn't send an allow again for an approval that was denied since, which is said", async () => {
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
    // the user's allow wasn't used
    await assert.rejects(approvals.request([approval("download")], { isExplicit: false }), /Changed/);
    assert.deepStrictEqual(approved, [{ id: "download", decision: "allow" }]);
  });

  it("doesn't say a denial failed when its approval is denied afterwards", async () => {
    const approved: ApproveParams[] = [];
    const approvals = new Approvals({
      ask: async () => "deny",
      approve: async params => {
        approved.push(params);
        throw new Error("Failed.");
      },
      pendingApprovals: async () => ({
        configFile: null,
        approvals: [{ ...approval("download"), denied: true }],
        status: READY,
      }),
    });
    assert.strictEqual(await approvals.request([approval("download")], { isExplicit: false }), false);
    assert.deepStrictEqual(approved, [{ id: "download", decision: "deny" }]);
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

  it("asks about the other approvals when one was denied", async () => {
    const { approvals, asked } = createApprovals({ decide: () => "allow" });
    const denied = { ...approval("download"), denied: true };
    assert.strictEqual(await approvals.request([denied, approval("processPlugins")], { isExplicit: false }), false);
    assert.deepStrictEqual(asked, ["processPlugins"]);
  });

  it("denies what replaced an approval the user denied, but never allows it", async () => {
    const replacement = { ...approval("processPlugins"), id: "replacement" };
    const approved: ApproveParams[] = [];
    const asked: string[] = [];
    const create = (decision: ApprovalDecision) =>
      new Approvals({
        ask: async pending => {
          asked.push(pending.id);
          return decision;
        },
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
    const denied = create("deny");
    assert.strictEqual(await denied.request([approval("processPlugins")], { isExplicit: false }), false);
    assert.deepStrictEqual(approved, [{ id: "processPlugins", decision: "deny" }, {
      id: "replacement",
      decision: "deny",
    }]);
    // what replaced it isn't asked about in the same request
    assert.deepStrictEqual(asked, ["processPlugins"]);
    // or on a later save once dprint says it's denied, but is when it's pending without that (ex. dprint
    // restarted without keeping the session)
    await denied.request([{ ...replacement, denied: true }], { isExplicit: false });
    assert.deepStrictEqual(asked, ["processPlugins"]);
    await denied.request([replacement], { isExplicit: false });
    assert.deepStrictEqual(asked, ["processPlugins", "replacement"]);
    approved.length = 0;
    asked.length = 0;
    // the user is asked about what replaced it instead
    const allowed = create("allow");
    assert.strictEqual(await allowed.request([approval("processPlugins")], { isExplicit: false }), true);
    assert.deepStrictEqual(approved, [{ id: "processPlugins", decision: "allow" }, {
      id: "replacement",
      decision: "allow",
    }]);
    assert.deepStrictEqual(asked, ["processPlugins", "replacement"]);
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

describe("Approvals asked about", () => {
  it("doesn't ask on save again about an approval whose id changed once its process plugins were set up", async () => {
    const { approvals, asked } = createApprovals({ decide: () => undefined });
    await approvals.request([approval("processPlugins")], { isExplicit: false });
    // the same config file, kind, and plugins
    assert.strictEqual(
      await approvals.request([{ ...approval("processPlugins"), id: "setUp" }], { isExplicit: false }),
      false,
    );
    assert.deepStrictEqual(asked, ["processPlugins"]);
  });

  it("asks on save again about an approval the user decided once it's pending again", async () => {
    for (const decision of ["allow", "deny"]) {
      const { approvals, asked } = createApprovals({ decide: () => decision });
      await approvals.request([approval("processPlugins")], { isExplicit: false });
      // ex. its process plugin's configuration changed, or a server that didn't keep the session
      await approvals.request([{ ...approval("processPlugins"), id: "changed" }], { isExplicit: false });
      assert.deepStrictEqual(asked, ["processPlugins", "changed"]);
    }
  });

  it("doesn't ask on save again about a dismissed approval with a new id and its items in another order", async () => {
    const items = [
      { specifier: "https://example.com/a", kind: "plugin" },
      { specifier: "https://example.com/b", kind: "plugin" },
    ];
    const { approvals, asked } = createApprovals({ decide: () => undefined });
    await approvals.request([{ ...approval("processPlugins"), items }], { isExplicit: false });
    // ex. its process plugin's configuration changed
    const changed = { ...approval("processPlugins"), id: "changed", items: [...items].reverse() };
    assert.strictEqual(await approvals.request([changed], { isExplicit: false }), false);
    assert.deepStrictEqual(asked, ["processPlugins"]);
  });

  it("asks on save again about what was asked about once it's forgotten", async () => {
    const { approvals, asked } = createApprovals({ decide: () => undefined });
    await approvals.request([approval("download")], { isExplicit: false });
    approvals.forget();
    await approvals.request([approval("download")], { isExplicit: false });
    assert.deepStrictEqual(asked, ["download", "download"]);
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
      option.decision === "allow" ? { ...option, description: "Downloads it." } : option
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

describe("toVisibleText", () => {
  it("escapes what changes how the text around it looks", () => {
    assert.strictEqual(toVisibleText("a\nb\u202Ec\u2028d\u00A0e"), "a\\u{a}b\\u{202e}c\\u{2028}d\\u{a0}e");
    assert.strictEqual(toVisibleText("C:\\Users\\Jörg\\new"), "C:\\Users\\Jörg\\new");
    // so it can't look like an escape, and a combining mark at the start can't change what's before it
    assert.strictEqual(toVisibleText("C:\\u{a}"), "C:\\u{5c}u{a}");
    assert.strictEqual(toVisibleText("\u0301a"), "\\u{301}a");
    // and the ones that aren't assigned yet
    assert.strictEqual(toVisibleText("a\u0378b"), "a\\u{378}b");
    // the invisible ones that aren't format characters too
    assert.strictEqual(toVisibleText("a\u034Fb\u3164c\uFE0Fd\u{E0041}"), "a\\u{34f}b\\u{3164}c\\u{fe0f}d\\u{e0041}");
  });
});

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
        decisions: [{ decision: "allow", label: "Allow", allows: true, always: false, description: "" }, {
          decision: "deny",
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
          { decision: "allow", label: "Allow", allows: true, always: false, description: "" },
          { decision: "alwaysAllow", label: "Always Allow", allows: true, always: true, description: "" },
          { decision: "deny", label: "Deny", allows: false, always: false, description: "" },
          { decision: "alwaysDeny", label: "Always Deny", allows: false, always: true, description: "" },
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
        decisions: [{ decision: "allow", label: "Allow", allows: true, always: false, description: "" }, {
          decision: "trustDomain",
          label: "Trust the domain",
          allows: true,
          always: false,
          description: "",
        }, { decision: "deny", label: "Deny", allows: false, always: false, description: "" }],
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
    configFile: configFile("file:///dprint.json"),
    items: [{ specifier: `https://example.com/${id}`, kind: "plugin" }],
    decisions: (isProcessPlugins ? ["allow", "alwaysAllow", "deny", "alwaysDeny"] : ["allow", "deny"]).map(id => ({
      decision: id,
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
