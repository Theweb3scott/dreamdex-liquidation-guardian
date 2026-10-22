import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  confirm,
  disarm,
  emptyJournal,
  propose,
  reconcile,
  restoreJournal,
  serializeJournal,
  type ExecutionAdapter,
  type ProposeInput,
} from "./execution.ts";

function input(overrides: Partial<ProposeInput> = {}): ProposeInput {
  return {
    mode: "protection",
    account: "0xabc",
    market: "BTC",
    pool: "0xpool",
    band: "danger",
    ratio: "1.400000",
    priceable: true,
    healthAgrees: true,
    blocksConsistent: true,
    includeWarning: false,
    firstSize: "1000",
    freshSize: "1000",
    requestedReduction: "250",
    maxAllowedReduction: "250",
    openOrderIds: [],
    marginBlock: "10",
    rpcError: null,
    timedOut: false,
    ...overrides,
  };
}

const adapter: ExecutionAdapter = {
  authorized: true,
  submit: async () => ({ hash: "0xhash" }),
};

describe("execution journal", () => {
  it("rejects a healthy account for auto-protection", () => {
    const { proposal } = propose(emptyJournal(), input({ band: "clear", ratio: "3.000000" }));
    assert.equal(proposal.state, "failed");
    assert.match(proposal.reason, /Healthy/);
    assert.equal(proposal.signingReachable, false);
  });

  it("allows a danger account to wait for confirmation and still not send", async () => {
    const { journal, proposal } = propose(emptyJournal(), input());
    assert.equal(proposal.state, "awaiting_confirmation");
    assert.equal(proposal.label, "PROTECTION PREVIEW — NOT SENT");
    const held = await confirm(journal, proposal.intentId ?? "", "1000", null);
    assert.equal(held.state, "awaiting_confirmation");
    assert.match(held.reason, /No execution adapter/);
  });

  it("allows a critical account the same unsigned preview", () => {
    const { proposal } = propose(emptyJournal(), input({ band: "critical", ratio: "1.000000" }));
    assert.equal(proposal.state, "awaiting_confirmation");
    assert.equal(proposal.protectiveDirection, "sell");
  });

  it("lets a demo preview a healthy position without sending", async () => {
    const { journal, proposal } = propose(emptyJournal(), input({ mode: "demo", band: "clear", ratio: "4.000000" }));
    assert.equal(proposal.label, "DEMONSTRATION ONLY");
    assert.equal(proposal.state, "awaiting_confirmation");
    const held = await confirm(journal, proposal.intentId ?? "", "1000", null);
    assert.equal(held.signingReachable, false);
  });

  it("blocks a duplicate while a preview is open", () => {
    const first = propose(emptyJournal(), input());
    const second = propose(first.journal, input());
    assert.match(second.proposal.reason, /Pending work/);
    assert.equal(second.proposal.state, "failed");
  });

  it("blocks a new order while a receipt is pending", () => {
    const opened = propose(emptyJournal(), input());
    const id = opened.proposal.intentId ?? "";
    const pending = {
      ...opened.journal,
      records: opened.journal.records.map((record) =>
        record.intentId === id ? { ...record, state: "receipt_pending" as const, hash: "0xhash" } : record,
      ),
    };
    const next = propose(pending, input({ freshSize: "900", firstSize: "900" }));
    assert.match(next.proposal.reason, /Pending work/);
  });

  it("keeps an unknown outcome locked across a restart", () => {
    const opened = propose(emptyJournal(), input());
    const id = opened.proposal.intentId ?? "";
    const unknown = reconcile(
      {
        ...opened.journal,
        records: opened.journal.records.map((record) =>
          record.intentId === id ? { ...record, state: "receipt_pending" as const, hash: "0xhash" } : record,
        ),
      },
      { intentId: id, receipt: "unknown", filled: "0", sizeAfter: "1000" },
    );
    assert.equal(unknown.state, "outcome_unknown");
    const restored = restoreJournal(serializeJournal(unknown.journal));
    const blocked = propose(restored, input({ freshSize: "800", firstSize: "800" }));
    assert.equal(restored.lockIntentId, id);
    assert.match(blocked.proposal.reason, /Pending work/);
  });

  it("does not send when the position changes before execution", async () => {
    let called = false;
    const { journal, proposal } = propose(emptyJournal(), input());
    const result = await confirm(journal, proposal.intentId ?? "", "900", {
      authorized: true,
      submit: async () => {
        called = true;
        return { hash: "0xno" };
      },
    });
    assert.equal(called, false);
    assert.match(result.reason, /Position changed before execution/);
    assert.equal(result.state, "failed");
  });

  it("records a failed receipt", async () => {
    const opened = propose(emptyJournal(), input());
    const sent = await confirm(opened.journal, opened.proposal.intentId ?? "", "1000", adapter);
    assert.equal(sent.state, "receipt_pending");
    const failed = reconcile(sent.journal, {
      intentId: opened.proposal.intentId ?? "",
      receipt: "failed",
      filled: "0",
      sizeAfter: "1000",
    });
    assert.equal(failed.state, "failed");
    assert.match(failed.reason, /Receipt status failed/);
  });

  it("does not treat a partial fill as complete", async () => {
    const opened = propose(emptyJournal(), input());
    const sent = await confirm(opened.journal, opened.proposal.intentId ?? "", "1000", adapter);
    const partial = reconcile(sent.journal, {
      intentId: opened.proposal.intentId ?? "",
      receipt: "success",
      filled: "100",
      sizeAfter: "900",
    });
    assert.equal(partial.state, "failed");
    assert.match(partial.reason, /Partial fill/);
  });

  it("fails closed when the sign flips after a fill", async () => {
    const opened = propose(emptyJournal(), input());
    const sent = await confirm(opened.journal, opened.proposal.intentId ?? "", "1000", adapter);
    const flipped = reconcile(sent.journal, {
      intentId: opened.proposal.intentId ?? "",
      receipt: "success",
      filled: "250",
      sizeAfter: "-10",
    });
    assert.equal(failedState(flipped.state), "failed");
    assert.match(flipped.reason, /sign flipped/);
  });

  it("disarms an unsent preview and refuses the next one", () => {
    const opened = propose(emptyJournal(), input());
    const stopped = disarm(opened.journal);
    assert.equal(stopped.disarmed, true);
    assert.equal(stopped.records[0]?.state, "failed");
    assert.match(stopped.records[0]?.reason ?? "", /Disarmed before send/);
    const next = propose(stopped, input());
    assert.match(next.proposal.reason, /Disarmed/);
  });

  it("does not clear an unknown transaction on disarm", () => {
    const opened = propose(emptyJournal(), input());
    const id = opened.proposal.intentId ?? "";
    const pending = {
      ...opened.journal,
      records: opened.journal.records.map((record) =>
        record.intentId === id ? { ...record, state: "outcome_unknown" as const, hash: "0xhash" } : record,
      ),
    };
    const stopped = disarm(pending);
    assert.equal(stopped.lockIntentId, id);
    assert.equal(stopped.records[0]?.state, "outcome_unknown");
    assert.match(stopped.records[0]?.reason ?? "", /not cancelled/);
  });
});

function failedState(state: string): string {
  return state;
}
