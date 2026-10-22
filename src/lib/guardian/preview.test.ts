import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { previewProtectiveOrder, rawPercent, type PreviewRequest } from "./preview.ts";

function request(overrides: Partial<PreviewRequest> = {}): PreviewRequest {
  return {
    account: "0xd167376D0431131b4C2EC25e3581c6AF734794F3",
    market: "BTC",
    pool: "0x4181dd08E73BbCdd1Ba3E615A18f6abD941b94C0",
    firstSize: "1000",
    freshSize: "1000",
    requestedReduction: "250",
    maxAllowedReduction: "250",
    openOrderIds: [],
    band: "clear",
    ratio: "3.000000",
    blocksConsistent: true,
    healthAgrees: true,
    priceable: true,
    marginBlock: "10",
    busy: false,
    rpcError: null,
    ...overrides,
  };
}

describe("dry-run protective preview", () => {
  it("sells to reduce a long", () => {
    const preview = previewProtectiveOrder(request());
    assert.equal(preview.label, "DRY RUN ONLY");
    assert.equal(preview.state, "simulated");
    assert.deepEqual(preview.steps, ["proposed", "validated", "simulated"]);
    assert.equal(preview.positionDirection, "long");
    assert.equal(preview.protectiveDirection, "sell");
    assert.equal(preview.isBid, false);
    assert.equal(preview.proposedQuantity, "250");
    assert.equal(preview.reductionBps, "2500");
  });

  it("buys to reduce a short", () => {
    const preview = previewProtectiveOrder(request({ firstSize: "-800", freshSize: "-800", requestedReduction: "100", maxAllowedReduction: "200" }));
    assert.equal(preview.state, "simulated");
    assert.equal(preview.positionDirection, "short");
    assert.equal(preview.protectiveDirection, "buy");
    assert.equal(preview.isBid, true);
    assert.equal(preview.proposedQuantity, "100");
  });

  it("takes no action on a zero position", () => {
    const preview = previewProtectiveOrder(request({ firstSize: "0", freshSize: "0" }));
    assert.equal(preview.state, "rejected");
    assert.equal(preview.protectiveDirection, "none");
    assert.match(preview.reason, /closed/);
  });

  it("rejects a sign flip between the two reads", () => {
    const preview = previewProtectiveOrder(request({ firstSize: "1000", freshSize: "-1000" }));
    assert.equal(preview.state, "rejected");
    assert.match(preview.reason, /direction changed/);
    assert.equal(preview.proposedQuantity, "0");
  });

  it("clamps an oversized reduction with integer min", () => {
    const preview = previewProtectiveOrder(request({ requestedReduction: "5000", maxAllowedReduction: "400" }));
    assert.equal(preview.state, "simulated");
    assert.equal(preview.proposedQuantity, "400");
    assert.match(preview.reason, /clamped/);
    assert.equal(rawPercent(1000n, 250n), 2500n);
  });

  it("rejects a duplicate while another preview is in flight", () => {
    const preview = previewProtectiveOrder(request({ busy: true }));
    assert.equal(preview.state, "rejected");
    assert.deepEqual(preview.steps, ["rejected"]);
    assert.match(preview.reason, /Another preview/);
  });

  it("rejects when the pool has open orders", () => {
    const preview = previewProtectiveOrder(request({ openOrderIds: ["99"] }));
    assert.equal(preview.state, "rejected");
    assert.match(preview.reason, /Open orders/);
  });

  it("rejects stale market data", () => {
    const preview = previewProtectiveOrder(request({ priceable: false, band: "unpriced", ratio: null }));
    assert.equal(preview.state, "rejected");
    assert.match(preview.reason, /stale/);
  });

  it("rejects inconsistent snapshots", () => {
    const health = previewProtectiveOrder(request({ healthAgrees: false, band: "inconsistent", ratio: null }));
    const blocks = previewProtectiveOrder(request({ blocksConsistent: false }));
    assert.match(health.reason, /inconsistent/);
    assert.match(blocks.reason, /blocks conflict/);
    assert.equal(health.state, "rejected");
    assert.equal(blocks.state, "rejected");
  });

  it("rejects an RPC failure before proposing a quantity", () => {
    const preview = previewProtectiveOrder(request({ rpcError: "socket closed" }));
    assert.equal(preview.state, "rejected");
    assert.equal(preview.proposedQuantity, "0");
    assert.match(preview.reason, /socket closed/);
  });
});
