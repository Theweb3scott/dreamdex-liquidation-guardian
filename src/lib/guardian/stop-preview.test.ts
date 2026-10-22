import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PLACE_ORDER_FOR_SELECTOR as SDK_SELECTOR } from "@somnia-chain/markets-sdk";
import { PLACE_ORDER_FOR_SELECTOR, previewProtectiveStop, protectiveQuantity, protectiveTerms, type StopPreviewInput } from "./stop-preview.ts";

const REGISTRY = "0x52E2ccebAeC9332672C247e9A90AA3d61FB615ef";
const PERMS = "0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a";

function input(overrides: Partial<StopPreviewInput> = {}): StopPreviewInput {
  return {
    deploymentId: "hideki-v2",
    wallet: "0xd167376D0431131b4C2EC25e3581c6AF734794F3",
    market: "BTC",
    pool: "0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0",
    registry: REGISTRY,
    operatorRegistry: PERMS,
    positionSize: 26000n,
    mark: 100_000n,
    liquidation: 80_000n,
    tickSize: 100n,
    lotSize: 1000n,
    minQuantity: 13000n,
    reducingCapacity: 26000n,
    requestedQuantity: 13000n,
    somiPayment: 150000000000000000n,
    resolvedAuthorized: false,
    globalApproved: false,
    poolApproved: false,
    existingStops: [],
    stopsReadable: true,
    priceable: true,
    healthAgrees: true,
    quotedAt: 1_000,
    now: 1_000,
    ...overrides,
  };
}

describe("protective stop preview", () => {
  it("locks the place selector to the SDK constant", () => {
    assert.equal(PLACE_ORDER_FOR_SELECTOR, SDK_SELECTOR);
    assert.equal(PLACE_ORDER_FOR_SELECTOR, "0x80054449");
  });

  it("plans a long stop below the mark and above liquidation", () => {
    const terms = protectiveTerms({ positionSize: 26000n, mark: 100_000n, liquidation: 80_000n, tickSize: 100n });
    assert.equal(terms.ok, true);
    if (!terms.ok) return;
    assert.equal(terms.direction, "sell");
    assert.equal(terms.triggerOperator, 1);
    assert.ok(terms.triggerPrice > 80_000n && terms.triggerPrice < 100_000n);
    const preview = previewProtectiveStop(input());
    assert.equal(preview.ok, true);
    assert.equal(preview.signingReachable, false);
    assert.equal(preview.submissionEnabled, false);
    assert.equal(preview.createFunction, "createPendingOrder");
    assert.equal(preview.intent, "reduceOnly");
    assert.equal(preview.operator.address, REGISTRY);
    assert.equal(preview.operator.grantFunction, "setOperatorApprovalForPool");
    assert.equal(preview.operator.globalGrantRefused, true);
    assert.equal(preview.somiWei, "150000000000000000");
    assert.deepEqual(preview.steps.map((step) => step.id), ["approve", "create", "monitor", "cancel", "revoke"]);
  });

  it("plans a short stop above the mark and below liquidation", () => {
    const terms = protectiveTerms({ positionSize: -26000n, mark: 100_000n, liquidation: 120_000n, tickSize: 100n });
    assert.equal(terms.ok, true);
    if (!terms.ok) return;
    assert.equal(terms.direction, "buy");
    assert.equal(terms.triggerOperator, 0);
    assert.ok(terms.triggerPrice > 100_000n && terms.triggerPrice < 120_000n);
  });

  it("refuses a trigger with no room before liquidation", () => {
    const crossed = protectiveTerms({ positionSize: 26000n, mark: 80_000n, liquidation: 90_000n, tickSize: 1n });
    assert.equal(crossed.ok, false);
    const zero = protectiveTerms({ positionSize: 26000n, mark: 100_000n, liquidation: 0n, tickSize: 1n });
    assert.equal(zero.ok, false);
  });

  it("refuses the whole-position sentinel and an undersized lot", () => {
    assert.equal(protectiveQuantity({ positionSize: 26000n, requested: 0n, capacity: 26000n, lotSize: 1000n, minQuantity: 13000n }).ok, false);
    const clamped = protectiveQuantity({ positionSize: 26000n, requested: 50000n, capacity: 20000n, lotSize: 1000n, minQuantity: 13000n });
    assert.equal(clamped.ok, true);
    if (clamped.ok) assert.equal(clamped.quantity, 20000n);
    const tiny = protectiveQuantity({ positionSize: 26000n, requested: 1000n, capacity: 26000n, lotSize: 1000n, minQuantity: 13000n });
    assert.equal(tiny.ok, false);
  });

  it("blocks a duplicate reduce-only stop and an unknown intent", () => {
    const duplicate = previewProtectiveStop(input({
      existingStops: [{ orderId: "1", live: true, intent: "reduceOnly", isBid: false, triggerOperator: 1, quantity: "13000", triggerPrice: "90000" }],
    }));
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.reason, /already covers/);
    const unknown = previewProtectiveStop(input({
      existingStops: [{ orderId: "2", live: true, intent: null, isBid: false, triggerOperator: 1, quantity: "13000", triggerPrice: "90000" }],
    }));
    assert.match(unknown.reason, /unknown intent/);
  });

  it("blocks a stale quote and an unreadable stop list", () => {
    assert.match(previewProtectiveStop(input({ now: 30_000 })).reason, /stale/);
    assert.match(previewProtectiveStop(input({ stopsReadable: false })).reason, /could not be read/);
  });

  it("names the global revoke when that slot is already set, and still does not grant it", () => {
    const preview = previewProtectiveStop(input({ globalApproved: true, resolvedAuthorized: true }));
    assert.equal(preview.ok, true);
    assert.equal(preview.operator.revokeFunction, "setOperatorApprovalGlobal");
    assert.equal(preview.operator.globalGrantRefused, true);
    assert.match(preview.steps.find((step) => step.id === "revoke")?.detail ?? "", /approved false/);
  });
});
