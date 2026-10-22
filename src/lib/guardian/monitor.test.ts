import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assessAccount,
  createReadGate,
  monitorLog,
  parsePublicAddress,
  parseThresholds,
  protectionDecision,
  type AccountSnapshot,
  type PositionSnapshot,
} from "./monitor.ts";

function account(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    equity: "300",
    mmReq: "100",
    healthAgrees: true,
    marginBlock: "10",
    positions: [position()],
    ...overrides,
  };
}

function position(overrides: Partial<PositionSnapshot> = {}): PositionSnapshot {
  return {
    symbol: "BTC",
    size: "100000000",
    baseDecimals: 8,
    priceable: true,
    poolPriceable: true,
    asOfBlock: "10",
    entry: "80000000000000000000000",
    mark: "100000000000000000000000",
    liquidationPrice: { price: "50000000000000000000000" },
    ...overrides,
  };
}

describe("protocol monitor", () => {
  it("rejects a non-address before any read", () => {
    const parsed = parsePublicAddress("not-a-key");
    assert.equal(parsed.ok, false);
  });

  it("accepts a public address", () => {
    const parsed = parsePublicAddress("0xd167376D0431131b4C2EC25e3581c6AF734794F3");
    assert.equal(parsed.ok, true);
  });

  it("classifies a healthy account at or above 2.0×", () => {
    const result = assessAccount(account());
    assert.equal(result.band, "clear");
    assert.equal(result.ratio, "3.000000");
    assert.equal(result.positions[0]?.direction, "long");
    assert.equal(result.positions[0]?.liquidation.kind, "level");
    if (result.positions[0]?.liquidation.kind === "level") {
      assert.equal(result.positions[0].liquidation.distance, "50.00%");
      assert.equal(result.positions[0].liquidation.price, "50000");
    }
  });

  it("warns below 2.0× and not at the line", () => {
    assert.equal(assessAccount(account({ equity: "200", mmReq: "100" })).band, "clear");
    assert.equal(assessAccount(account({ equity: "199", mmReq: "100" })).band, "warning");
  });

  it("marks danger below 1.5×", () => {
    const result = assessAccount(account({ equity: "149", mmReq: "100" }));
    assert.equal(result.band, "danger");
    assert.equal(result.ratio, "1.490000");
  });

  it("marks critical below 1.15×", () => {
    assert.equal(assessAccount(account({ equity: "115", mmReq: "100" })).band, "danger");
    const result = assessAccount(account({ equity: "114", mmReq: "100" }));
    assert.equal(result.band, "critical");
    assert.equal(result.ratio, "1.140000");
  });

  it("withholds health when a mark is stale", () => {
    const result = assessAccount(account({ positions: [position({ priceable: false, mark: null })] }));
    assert.equal(result.band, "unpriced");
    assert.equal(result.ratio, null);
    assert.equal(result.positions[0]?.liquidation.kind, "unpriced");
  });

  it("withholds health when the pool snapshot is unpriceable", () => {
    const result = assessAccount(account({ positions: [position({ poolPriceable: false })] }));
    assert.equal(result.band, "unpriced");
    assert.equal(result.ratio, null);
  });

  it("does not divide by a zero maintenance requirement", () => {
    const result = assessAccount(account({ equity: "100", mmReq: "0", positions: [] }));
    assert.equal(result.band, "incomparable");
    assert.equal(result.ratio, null);
  });

  it("does not treat liquidation price 0 as a level", () => {
    const result = assessAccount(account({ positions: [position({ liquidationPrice: { price: "0" } })] }));
    assert.equal(result.band, "clear");
    assert.equal(result.positions[0]?.liquidation.kind, "floored");
  });

  it("withholds the band when blocks disagree", () => {
    const result = assessAccount(account({ positions: [position({ asOfBlock: "11" })] }));
    assert.equal(result.band, "inconsistent");
    assert.equal(result.ratio, null);
  });

  it("withholds the band when the two health reads disagree", () => {
    const result = assessAccount(account({ healthAgrees: false }));
    assert.equal(result.band, "inconsistent");
    assert.equal(result.ratio, null);
  });

  it("records an API error without changing a prior band", () => {
    const event = monitorLog("clear", { error: "Indexer answered 503." });
    assert.equal(event?.kind, "failed");
    assert.match(event?.message ?? "", /503/);
  });

  it("records a risk change once and stays quiet on the same band", () => {
    const first = assessAccount(account({ equity: "160", mmReq: "100" }));
    const opened = monitorLog(null, first);
    assert.equal(opened?.kind, "changed");
    assert.equal(opened && "band" in opened ? opened.band : null, "warning");
    assert.equal(monitorLog("warning", first), null);
    const critical = assessAccount(account({ equity: "100", mmReq: "100" }));
    const moved = monitorLog("warning", critical);
    assert.equal(moved && "band" in moved ? moved.band : null, "critical");
  });

  it("rejects unordered thresholds", () => {
    const parsed = parseThresholds({ warning: "1", danger: "2", critical: "3" });
    assert.equal(parsed.ok, false);
  });

  it("refuses a second read while one is in flight", () => {
    const gate = createReadGate();
    assert.equal(gate.tryEnter(), true);
    assert.equal(gate.tryEnter(), false);
    gate.leave();
    assert.equal(gate.tryEnter(), true);
  });

  it("withholds a protection decision on stale, inconsistent, and stressed fixtures", () => {
    const stale = protectionDecision(
      assessAccount(account({ positions: [position({ priceable: false, mark: null })] })),
    );
    const mixed = protectionDecision(assessAccount(account({ positions: [position({ asOfBlock: "11" })] })));
    const warning = protectionDecision(assessAccount(account({ equity: "180", mmReq: "100" })));
    const danger = protectionDecision(assessAccount(account({ equity: "140", mmReq: "100" })));
    const critical = protectionDecision(assessAccount(account({ equity: "100", mmReq: "100" })));
    const failed = protectionDecision({ error: "rpc timeout" });
    for (const decision of [stale, mixed, warning, danger, critical, failed]) {
      assert.equal(decision.execute, false);
    }
    assert.match(stale.reason, /unpriceable/);
    assert.match(mixed.reason, /Inconsistent/);
    assert.match(warning.reason, /disarmed/);
    assert.equal(assessAccount(account({ equity: "180", mmReq: "100" })).band, "warning");
    assert.equal(assessAccount(account({ equity: "140", mmReq: "100" })).band, "danger");
    assert.equal(assessAccount(account({ equity: "100", mmReq: "100" })).band, "critical");
    assert.match(failed.reason, /Read failed/);
  });
});
