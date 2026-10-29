import * as assert from "node:assert";
import { describe, it } from "node:test";
import { type ApprovalChoice, Approvals, getApprovalChoices } from "./approvals";
import type { ApprovalDecision, ApproveParams, PendingApproval } from "./messages";

describe("Approvals", () => {
  it("asks about the approval and what else needs to be approved after it", async () => {
    const extended = approval("extended");
    const { approvals, asked, approved } = createApprovals({
      decide: () => "allow",
      approvalAfter: { download: extended },
    });

    assert.strictEqual(await approvals.request(approval("download"), { isExplicit: false }), true);
    assert.deepStrictEqual(asked, ["download", "extended"]);
    assert.deepStrictEqual(approved, [{ id: "download", decision: "allow" }, { id: "extended", decision: "allow" }]);
  });

  it("is false when the user denies or dismisses it", async () => {
    const denied = createApprovals({ decide: () => "alwaysDeny" });
    assert.strictEqual(await denied.approvals.request(approval("processPlugins"), { isExplicit: false }), false);
    assert.deepStrictEqual(denied.approved, [{ id: "processPlugins", decision: "alwaysDeny" }]);

    const dismissed = createApprovals({ decide: () => undefined });
    assert.strictEqual(await dismissed.approvals.request(approval("download"), { isExplicit: false }), false);
    // it stays pending
    assert.deepStrictEqual(dismissed.approved, []);
  });

  it("only asks once unless the user asks for it", async () => {
    const { approvals, asked } = createApprovals({ decide: () => undefined });

    await approvals.request(approval("download"), { isExplicit: false });
    assert.strictEqual(await approvals.request(approval("download"), { isExplicit: false }), false);
    assert.deepStrictEqual(asked, ["download"]);
    await approvals.request(approval("download"), { isExplicit: true });
    assert.deepStrictEqual(asked, ["download", "download"]);
  });

  it("only asks about what the user denied when they ask for it", async () => {
    const { approvals, asked } = createApprovals({ decide: () => "allow" });

    const denied = { ...approval("download"), denied: true };
    assert.strictEqual(await approvals.request(denied, { isExplicit: false }), false);
    assert.deepStrictEqual(asked, []);
    assert.strictEqual(await approvals.request(denied, { isExplicit: true }), true);
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
      approve: async () => ({ approval: null }),
    });

    const first = approvals.request(approval("download"), { isExplicit: false });
    const second = approvals.request(approval("download"), { isExplicit: false });
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
    await assert.rejects(approvals.request(approval("download"), { isExplicit: false }), /Nothing is pending/);
  });
});

describe("getApprovalChoices", () => {
  it("only allows or denies a download for the session", () => {
    assert.deepStrictEqual(getApprovalChoices("download").map(choice => [choice.title, choice.decision]), [
      ["Allow", "allow"],
      ["Deny", "deny"],
    ]);
    // a kind that's newer than the extension
    assert.deepStrictEqual(getApprovalChoices("other"), getApprovalChoices("download"));
  });

  it("can always allow or deny process plugins", () => {
    assert.deepStrictEqual(getApprovalChoices("processPlugins").map(choice => [choice.title, choice.decision]), [
      ["Allow", "allow"],
      ["Always Allow", "alwaysAllow"],
      ["Deny", "deny"],
      ["Always Deny", "alwaysDeny"],
    ]);
  });
});

function createApprovals(options: {
  decide: (approval: PendingApproval, choices: ApprovalChoice[]) => ApprovalDecision | undefined;
  approvalAfter?: Record<string, PendingApproval>;
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
      return { approval: options.approvalAfter?.[params.id] ?? null };
    },
  });
  return { approvals, asked, approved };
}

function approval(id: string): PendingApproval {
  return {
    id,
    kind: id === "processPlugins" ? "processPlugins" : "download",
    items: [`https://example.com/${id}`],
    denied: false,
    message: `Approve ${id}?`,
  };
}
