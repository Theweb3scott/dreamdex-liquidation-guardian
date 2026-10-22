import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { perpPositionAnalytics } from "@somnia-chain/markets-sdk";
import { parseCollateral, percentToBps, scanPortfolio, scenarioMatches, simulate, type IntelBook, type IntelPosition } from "./intelligence.ts";

const ONE = 10n ** 8n;
const MARK = 100_000n * 10n ** 18n;
const ENTRY = 80_000n * 10n ** 18n;

function priced(overrides: Partial<IntelPosition> = {}): IntelPosition {
  const size = overrides.size ?? "26000";
  const mark = overrides.mark ?? MARK.toString();
  const entry = overrides.entry ?? ENTRY.toString();
  const oneBase = overrides.oneBase ?? ONE.toString();
  const mmBps = overrides.maintenanceMarginBps ?? "250";
  const metrics = perpPositionAnalytics({
    size: BigInt(size),
    avgEntryPrice: BigInt(entry),
    entryFundingIndex: 0n,
    markPrice: BigInt(mark),
    projectedCumulativeFunding: 0n,
    oneBase: BigInt(oneBase),
    effectiveImfBps: 500n,
    maintenanceMarginBps: BigInt(mmBps),
    closeOutMarginBps: 100n,
  });
  return {
    symbol: "BTC",
    pool: "0x1111111111111111111111111111111111111111",
    baseDecimals: 8,
    priceable: true,
    size,
    entry,
    entryFundingIndex: "0",
    mark,
    oneBase,
    maintenanceMarginBps: mmBps,
    projectedFunding: "0",
    takerFeeBpsTimes1k: "5000",
    lotSize: "1000",
    minQuantity: "1000",
    observedNotional: metrics.notional.toString(),
    observedPnl: metrics.unrealizedPnl.toString(),
    observedMaintenance: metrics.maintenanceMarginRequirement.toString(),
    observedFunding: metrics.accruedFunding.toString(),
    ...overrides,
  };
}

function book(positions: IntelPosition[], overrides: Partial<IntelBook> = {}): IntelBook {
  const mm = positions.reduce((total, position) => total + BigInt(position.observedMaintenance ?? "0"), 0n);
  return {
    address: "0xd167376D0431131b4C2EC25e3581c6AF734794F3",
    chainId: 50383,
    deploymentId: "hideki-v2",
    refreshedAt: "2026-10-22T18:00:00.000Z",
    equity: (100n * 10n ** 18n).toString(),
    mmReq: mm.toString(),
    healthAgrees: true,
    blocksConsistent: true,
    band: "SAFE",
    bandReason: "Health is above the warning line.",
    positions,
    ...overrides,
  };
}

const idle = { shockBps: 0, shockPools: [] as string[], reducePool: null, reduceBps: 0, collateralRaw: "0" };

describe("portfolio scanner", () => {
  it("keeps opposing notionals gross and does not price a missing mark as zero", () => {
    const long = priced();
    const short = priced({
      symbol: "ETH",
      pool: "0x2222222222222222222222222222222222222222",
      size: "-26000",
    });
    const stale = priced({
      symbol: "SOL",
      pool: "0x3333333333333333333333333333333333333333",
      priceable: false,
      mark: null,
      observedNotional: null,
      observedPnl: null,
      observedMaintenance: null,
    });
    const scan = scanPortfolio(book([long, short, stale], { mmReq: (BigInt(long.observedMaintenance ?? "0") + BigInt(short.observedMaintenance ?? "0")).toString() }));
    assert.equal(scan.grossComplete, false);
    assert.equal(scan.grossNotional.kind, "unknown");
    assert.equal(scan.legs.find((leg) => leg.symbol === "ETH")?.direction, "short");
    assert.notEqual(scan.legs.find((leg) => leg.symbol === "BTC")?.notional.kind, "unknown");
    const pricedOnly = scanPortfolio(book([long, short]));
    assert.equal(pricedOnly.grossComplete, true);
    if (pricedOnly.longNotional.kind !== "protocol" || pricedOnly.shortNotional.kind !== "protocol" || pricedOnly.grossNotional.kind !== "protocol") {
      assert.fail("priced book should be protocol figures");
    }
    assert.equal(BigInt(pricedOnly.grossNotional.raw), BigInt(pricedOnly.longNotional.raw) + BigInt(pricedOnly.shortNotional.raw));
    assert.notEqual(pricedOnly.grossNotional.raw, "0");
    assert.match(pricedOnly.summary, /not netted/);
  });
});

describe("what-if simulator", () => {
  it("matches the SDK on a long drop, a short rise, and a large integer", () => {
    const long = priced();
    const down = simulate(book([long]), { ...idle, shockBps: -500, shockPools: [long.pool] });
    const shocked = (MARK * 9_500n) / 10_000n;
    const after = perpPositionAnalytics({
      size: 26000n,
      avgEntryPrice: ENTRY,
      entryFundingIndex: 0n,
      markPrice: shocked,
      projectedCumulativeFunding: 0n,
      oneBase: ONE,
      effectiveImfBps: 500n,
      maintenanceMarginBps: 250n,
      closeOutMarginBps: 100n,
    });
    const row = down.rows[0];
    assert.equal(row?.pnlChange.kind, "estimate");
    if (row?.pnlChange.kind === "estimate") assert.equal(row.pnlChange.raw, (after.unrealizedPnl - BigInt(long.observedPnl ?? "0")).toString());
    assert.equal(down.estimatedHealth.band === "UNKNOWN", false);
    assert.equal(down.executed, false);

    const short = priced({ size: "-26000", symbol: "ETH", pool: "0x2222222222222222222222222222222222222222" });
    const up = simulate(book([short]), { ...idle, shockBps: 1_000, shockPools: [short.pool] });
    assert.equal(up.rows[0]?.hypotheticalPnl.kind, "estimate");
    if (up.rows[0]?.pnlChange.kind === "estimate") assert.ok(BigInt(up.rows[0].pnlChange.raw) < 0n);

    const hugeMark = 10n ** 30n;
    const huge = priced({ mark: hugeMark.toString(), size: (10n ** 24n).toString() });
    const hugeBook = book([huge]);
    const hugeResult = simulate(hugeBook, { ...idle, shockBps: 100, shockPools: [huge.pool] });
    assert.equal(hugeResult.rows[0]?.pnlChange.kind, "estimate");

    const eth = priced({ symbol: "ETH", pool: "0x2222222222222222222222222222222222222222", size: "-26000" });
    const both = simulate(book([long, eth]), { ...idle, shockBps: -300, shockPools: [long.pool, eth.pool] });
    assert.equal(both.rows.length, 2);
    assert.equal(both.rows.every((row) => row.hypotheticalMark.kind === "estimate"), true);
  });

  it("reduces with integer lots, adds collateral, and refuses bad inputs", () => {
    const long = priced();
    const reduced = simulate(book([long]), { ...idle, reducePool: long.pool, reduceBps: 5000 });
    assert.equal(reduced.rows[0]?.hypotheticalSize, "0.00013");
    assert.equal(reduced.estimatedEquity.kind, "estimate");
    assert.match(reduced.notes.join(" "), /was reduced/);

    const deposited = simulate(book([long]), { ...idle, collateralRaw: (10n ** 18n).toString() });
    if (deposited.observedEquity.kind === "protocol" && deposited.estimatedEquity.kind === "estimate") {
      assert.equal(BigInt(deposited.estimatedEquity.raw) - BigInt(deposited.observedEquity.raw), 10n ** 18n);
    } else {
      assert.fail("collateral should move estimated equity only");
    }

    const stale = simulate(book([priced({ priceable: false, mark: null, observedNotional: null, observedPnl: null, observedMaintenance: null })]), {
      ...idle,
      shockBps: -100,
      shockPools: [long.pool],
    });
    assert.equal(stale.estimatedHealth.band, "UNKNOWN");

    const unscaled = priced({ oneBase: (10n ** 18n).toString(), observedNotional: "1", observedPnl: "1", observedMaintenance: "1" });
    const scaled = simulate(book([unscaled], { mmReq: "1" }), { ...idle, shockBps: -100, shockPools: [unscaled.pool] });
    assert.equal(scaled.estimatedHealth.band, "UNKNOWN");
    assert.match(scaled.estimatedHealth.reason, /oneBase|decimals|maintenance|UNKNOWN|match/i);

    const zero = simulate(book([priced({ mark: "0", observedNotional: null, observedPnl: null, observedMaintenance: null })]), idle);
    assert.equal(zero.estimatedHealth.band, "UNKNOWN");
  });

  it("drops a result when the account or network changes", () => {
    const first = book([priced()]);
    const result = simulate(first, idle);
    assert.equal(scenarioMatches(result, first), true);
    assert.equal(scenarioMatches(result, book([priced()], { address: "0x2222222222222222222222222222222222222222" })), false);
    assert.equal(scenarioMatches(result, book([priced()], { chainId: 1 })), false);
    assert.equal(percentToBps("5", "down").ok, true);
    assert.equal(parseCollateral("1.5", "withdraw").ok, true);
  });
});
