import * as assert from "node:assert";
import { describe, it } from "node:test";
import { type ApprovalChoice, Approvals, getApprovalChoices, getApprovalMessage } from "./approvals";
import type { ApprovalDecision, ApproveParams, PendingApproval } from "./messages";

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
      ask: pending => {
        asked.push(pending.id);
        return new Promise(resolve => decide = resolve);
      },
      approve: async () => ({ approvals: [] }),
    });

    const first = approvals.request([approval("download")], { isExplicit: false });
    const second = approvals.request([approval("download")], { isExplicit: false });
    await new Promise<void>(resolve => setImmediate(resolve));
    decide("allow");
    assert.deepStrictEqual(await Promise.all([first, second]), [true, true]);
    assert.deepStrictEqual(asked, ["download"]);
  });

  it("rejects when approving fails", async () => {
    const approvals = new Approvals({
      ask: async () => "allow",
      approve: () => Promise.reject(new Error("Nothing is pending.")),
    });
    await assert.rejects(approvals.request([approval("download")], { isExplicit: false }), /Nothing is pending/);
  });

  it("formats again when what needs to be approved changed", async () => {
    const changedError = Object.assign(new Error("Changed."), { code: -32801 });
    const allowed = new Approvals({ ask: async () => "allow", approve: () => Promise.reject(changedError) });
    assert.strictEqual(await allowed.request([approval("download")], { isExplicit: false }), true);
    const denied = new Approvals({ ask: async () => "deny", approve: () => Promise.reject(changedError) });
    assert.strictEqual(await denied.request([approval("download")], { isExplicit: false }), false);
  });

  it("asks about what needs to be approved now when the error says", async () => {
    const changed = approval("changed");
    const changedError = Object.assign(new Error("Changed."), { code: -32801, data: { approvals: [changed] } });
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
        return { approvals: [] };
      },
    });
    assert.strictEqual(await approvals.request([approval("download")], { isExplicit: false }), true);
    assert.deepStrictEqual(asked, ["download", "changed"]);
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
  it("has what the process plugins run with", () => {
    assert.strictEqual(getApprovalMessage(approval("download")), "Approve download?");
    const processPlugins = approval("processPlugins");
    processPlugins.items[0] = {
      ...processPlugins.items[0],
      configKey: "exec",
      configuration: { commands: [{ command: "a" }] },
    };
    assert.strictEqual(
      getApprovalMessage(processPlugins),
      "Approve processPlugins? They run with this configuration: {\"exec\":{\"commands\":[{\"command\":\"a\"}]}}",
    );
  });
});

describe("getApprovalChoices", () => {
  it("offers the decisions dprint says the approval has", () => {
    assert.deepStrictEqual(
      getApprovalChoices({ decisions: ["allow", "deny"] }).map(choice => [choice.title, choice.decision]),
      [["Allow", "allow"], ["Deny", "deny"]],
    );
    assert.deepStrictEqual(
      getApprovalChoices({ decisions: ["allow", "alwaysAllow", "deny", "alwaysDeny"] }).map(choice => [
        choice.title,
        choice.decision,
      ]),
      [["Allow", "allow"], ["Always Allow", "alwaysAllow"], ["Deny", "deny"], ["Always Deny", "alwaysDeny"]],
    );
  });

  it("leaves out a decision that's newer than the extension", () => {
    assert.deepStrictEqual(
      getApprovalChoices({ decisions: ["allow", "trustDomain", "deny"] }).map(choice => choice.decision),
      ["allow", "deny"],
    );
  });
});

function createApprovals(options: {
  decide: (approval: PendingApproval, choices: ApprovalChoice[]) => ApprovalDecision | undefined;
  approvalsAfter?: Record<string, PendingApproval[]>;
}) {
  const asked: string[] = [];
  const approved: ApproveParams[] = [];
  const approvals = new Approvals({
    ask: async (pending, choices) => {
      asked.push(pending.id);
      return options.decide(pending, choices);
    },
    approve: async params => {
      approved.push(params);
      return { approvals: options.approvalsAfter?.[params.id] ?? [] };
    },
  });
  return { approvals, asked, approved };
}

function approval(id: string): PendingApproval {
  const isProcessPlugins = id === "processPlugins";
  return {
    id,
    kind: isProcessPlugins ? "processPlugins" : "download",
    items: [{ specifier: `https://example.com/${id}` }],
    decisions: isProcessPlugins ? ["allow", "alwaysAllow", "deny", "alwaysDeny"] : ["allow", "deny"],
    denied: false,
    message: `Approve ${id}?`,
  };
}
