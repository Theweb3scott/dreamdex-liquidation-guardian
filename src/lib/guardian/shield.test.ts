import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildShield, classifyProtection, diffShield, shieldHelp, shieldLayout, type ShieldInput, type ShieldPositionInput } from "./shield.ts";

const POOL_A = "0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0";
const POOL_B = "0x2222222222222222222222222222222222222222";
const REGISTRY = "0x52E2ccebAeC9332672C247e9A90AA3d61FB615ef";

function position(overrides: Partial<ShieldPositionInput> = {}): ShieldPositionInput {
  return {
    symbol: "BTC",
    pool: POOL_A,
    baseDecimals: 8,
    priceable: true,
    poolPriceable: true,
    size: "26000",
    entry: "80000000000000000000000",
    mark: "100000000000000000000000",
    pnl: "500000000000000000000",
    asOfBlock: "10",
    liquidationPrice: { price: "70000000000000000000000" },
    lotSize: "1000",
    minQuantity: "13000",
    stopsReadable: true,
    stops: [],
    permission: {
      readable: true,
      registry: REGISTRY,
      operatorRegistry: "0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a",
      resolvedAuthorized: false,
      globalApproved: false,
      poolApproved: false,
      somiPayment: "150000000000000000",
    },
    plan: { ok: true, reason: "Stop plan only. Nothing was armed.", quantity: "13000", triggerPrice: "85000000000000000000000", somiWei: "150000000000000000" },
    ...overrides,
  };
}

function input(positions: ShieldPositionInput[]): ShieldInput {
  return {
    address: "0xd167376D0431131b4C2EC25e3581c6AF734794F3",
    chainId: 50383,
    deploymentId: "hideki-v2",
    refreshedAt: "2026-10-22T18:00:00.000Z",
    account: {
      equity: "4000000000000000000000",
      mmReq: "1000000000000000000000",
      healthAgrees: true,
      marginBlock: "10",
      positions: positions.map((item) => ({
        symbol: item.symbol,
        size: item.size,
        baseDecimals: item.baseDecimals,
        priceable: item.priceable,
        poolPriceable: item.poolPriceable,
        asOfBlock: item.asOfBlock,
        entry: item.entry,
        mark: item.mark,
        liquidationPrice: item.liquidationPrice,
      })),
    },
    positions,
  };
}

describe("guardian shield", () => {
  it("shows two open positions without inventing a missing liquidation price", () => {
    const model = buildShield(input([
      position(),
      position({
        symbol: "ETH",
        pool: POOL_B,
        size: "-15000",
        liquidationPrice: { price: "0" },
        plan: { ok: false, reason: "Liquidation price is not a usable level.", quantity: null, triggerPrice: null, somiWei: "150000000000000000" },
      }),
    ]));
    assert.equal(model.positions.length, 2);
    assert.equal(model.band, "SAFE");
    assert.equal(model.positions[0]?.direction, "long");
    assert.equal(model.positions[1]?.direction, "short");
    assert.equal(model.positions[1]?.liquidation, null);
    assert.match(model.positions[1]?.liquidationNote ?? "", /floor/);
    assert.equal(model.positions[1]?.distance, null);
    assert.equal(model.signingReachable, false);
    assert.equal(model.positions[0]?.pnl, "500");
    assert.equal(model.positions[0]?.size, "0.00026");
    assert.equal(model.positions[0]?.plan.needed, true);
    assert.equal(model.positions[1]?.plan.needed, null);
  });

  it("flags duplicate and conflicting stops, and an unreadable registry", () => {
    const duplicate = classifyProtection(position({
      stops: [
        { orderId: "1", live: true, intent: "reduceOnly", isBid: false, triggerOperator: 1, quantity: "13000", triggerPrice: "90000000000000000000000", somiPaid: "1" },
        { orderId: "2", live: true, intent: "reduceOnly", isBid: false, triggerOperator: 1, quantity: "13000", triggerPrice: "88000000000000000000000", somiPaid: "1" },
      ],
    }));
    assert.equal(duplicate.state, "conflict");
    const conflict = classifyProtection(position({
      stops: [
        { orderId: "3", live: true, intent: "reduceOnly", isBid: true, triggerOperator: 0, quantity: "13000", triggerPrice: "110000000000000000000000", somiPaid: "1" },
      ],
    }));
    assert.equal(conflict.state, "conflict");
    const stale = classifyProtection(position({ stopsReadable: false }));
    assert.equal(stale.state, "unknown");
    const unverified = classifyProtection(position({
      stops: [{ orderId: "4", live: null, intent: null, isBid: null, triggerOperator: null, quantity: null, triggerPrice: null, somiPaid: null }],
    }));
    assert.equal(unverified.state, "unknown");
  });

  it("does not call a disappeared stop an execution, and separates global from pool approval", () => {
    const first = buildShield(input([position({
      stops: [{ orderId: "9", live: true, intent: "reduceOnly", isBid: false, triggerOperator: 1, quantity: "26000", triggerPrice: "90000000000000000000000", somiPaid: "150000000000000000" }],
    })]));
    const second = buildShield(input([position()]));
    const events = diffShield(first, second);
    assert.equal(events.some((item) => item.kind === "verified"), false);
    assert.match(events.map((item) => item.detail).join(" "), /not verified/);
    const global = buildShield(input([position({
      permission: {
        readable: true,
        registry: REGISTRY,
        operatorRegistry: "0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a",
        resolvedAuthorized: true,
        globalApproved: true,
        poolApproved: false,
        somiPayment: "150000000000000000",
      },
    })]));
    assert.equal(global.positions[0]?.permission.revokeRecommended, true);
    assert.equal(global.positions[0]?.permission.poolApproved, false);
    assert.match(global.warnings.join(" "), /global/i);
  });

  it("marks a stop unsuitable after the position flips, and keeps a phone layout stacked", () => {
    const long = buildShield(input([position()]));
    const short = buildShield(input([position({ size: "-26000" })]));
    const flipped = diffShield(long, short);
    assert.match(flipped.map((item) => item.detail).join(" "), /changed from long to short/);
    const phone = shieldLayout(390);
    assert.equal(phone.mobile, true);
    assert.equal(phone.columns, 1);
    assert.deepEqual(phone.sections, ["account", "warnings", "positions", "portfolio", "what-if", "permissions", "protection", "activity", "help"]);
    const help = shieldHelp();
    assert.match(help.reduceOnly, /createPendingOrder/);
    assert.match(help.reduceOnly, /IOC/);
    assert.match(help.somi, /SOMI/);
  });
});
