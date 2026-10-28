import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { HIDEKI_CHAIN_ID, HIDEKI_V2_NET_VERSION, HIDEKI_V2_RPC_HOST, QUOTE_TTL_MS, SUBMISSION_ENABLED } from "./review.ts";
import {
  MANUAL_AUTOMATIC,
  POST_ONLY,
  acknowledgeIntent,
  alignedMinimum,
  applyReconcile,
  assessManualOrder,
  attachHash,
  classifyReceipt,
  emptyLedger,
  explainRpcFailure,
  orderBookState,
  parseLedger,
  postOnlyCrosses,
  postOnlyPrice,
  quoteFresh,
  reviewPreconditions,
  reduceFlight,
  releaseUnsent,
  rememberIntent,
  restingStatus,
  serializeLedger,
  submissionBlock,
  walletIdentityReady,
  walletReady,
  type Flight,
  type ManualFacts,
  type StoredIntent,
} from "./manual-order.ts";

const WALLET = "0xd167376D0431131b4C2EC25e3581c6AF734794F3";
const POOL = "0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0";
const BANK = "0x478769E1177C0773c43A593DCCc4Ad15F15F1394";
const FACTORY = "0xE631fAEE547baeE07353E290f0562ea67d856560";
const COLLATERAL = "0xed7993A74dAe1e6656B704A424DcD8711aAf4F72";

function facts(overrides: Partial<ManualFacts> = {}): ManualFacts {
  return {
    wallet: WALLET,
    symbol: "BTC",
    pool: POOL,
    isBid: true,
    markPrice: 100_000n * 10n ** 18n,
    tickSize: 10n ** 17n,
    lotSize: 1_000n,
    minQuantity: 13_000n,
    oneBase: 10n ** 8n,
    baseDecimals: 8,
    quoteDecimals: 18,
    makerFeeBpsTimes1k: 0n,
    takerFeeBpsTimes1k: 15_000n,
    initialMarginBps: 500n,
    maintenanceMarginBps: 250n,
    maxQuantity: 1_000_000n,
    placeable: true,
    limitedBy: "initialMargin",
    priceable: true,
    positionSize: 0n,
    unlockedCollateral: 1_000n * 10n ** 18n,
    equity: 1_000n * 10n ** 18n,
    imReq: 0n,
    mmReq: 0n,
    marginStatus: "Healthy",
    collateralToken: COLLATERAL,
    block: "300",
    quotedAt: 1_000,
    bookKnown: true,
    bestBid: null,
    bestAsk: null,
    deployment: {
      chainId: HIDEKI_CHAIN_ID,
      netVersion: HIDEKI_V2_NET_VERSION,
      rpcHost: HIDEKI_V2_RPC_HOST,
      marginBank: BANK,
      expectedMarginBank: BANK,
      factory: FACTORY,
      expectedFactory: FACTORY,
      marginBankCodeBytes: 176,
      factoryCodeBytes: 176,
      poolCodeBytes: 176,
      factoryOwnsPool: true,
      poolMarginBank: BANK,
    },
    ...overrides,
  };
}

describe("manual post-only order", () => {
  it("keeps Guardian submission and automatic execution off", () => {
    assert.equal(SUBMISSION_ENABLED, false);
    assert.equal(MANUAL_AUTOMATIC, false);
    assert.equal(POST_ONLY, 3);
  });

  it("prices a buy below the mark and a sell above it", () => {
    assert.equal(postOnlyPrice(1_000n, 10n, true), 990n);
    assert.equal(postOnlyPrice(1_000n, 10n, false), 1_010n);
    assert.equal(postOnlyPrice(1_005n, 10n, true), 990n);
    assert.equal(postOnlyPrice(1_005n, 10n, false), 1_020n);
    assert.equal(postOnlyPrice(10n, 10n, true), null);
    assert.equal(postOnlyPrice(0n, 10n, false), null);
  });

  it("uses the minimum lot-aligned quantity and refuses a smaller account", () => {
    assert.equal(alignedMinimum(13_000n, 1_000n), 13_000n);
    assert.equal(alignedMinimum(13_001n, 1_000n), 14_000n);
    const buy = assessManualOrder(facts());
    assert.equal(buy.ok, true);
    if (!buy.ok) return;
    assert.equal(buy.quote.symbol, "BTC");
    assert.equal(buy.quote.orderType, POST_ONLY);
    assert.equal(buy.quote.quantity, "13000");
    assert.equal(buy.quote.side, "buy");
    assert.equal(buy.quote.unlockedCollateralDisplay, "1000");
    assert.equal(buy.quote.equityDisplay, "1000");
    assert.ok(BigInt(buy.quote.price) < facts().markPrice);
    const short = assessManualOrder(facts({ isBid: false, positionSize: -26_000n }));
    assert.equal(short.ok, true);
    if (!short.ok) return;
    assert.equal(short.quote.side, "sell");
    assert.equal(short.quote.filledExposure, "-39000");
    const blocked = assessManualOrder(facts({ maxQuantity: 12_000n, placeable: false, limitedBy: "collateral" }));
    assert.equal(blocked.ok, false);
  });

  it("refuses the wrong market, chain, deployment, and an unpriceable mark", () => {
    assert.equal(assessManualOrder(facts({ symbol: "ETH" })).ok, false);
    assert.equal(assessManualOrder(facts({ deployment: { ...facts().deployment, chainId: 50312 } })).ok, false);
    assert.equal(assessManualOrder(facts({ deployment: { ...facts().deployment, netVersion: "50000258" } })).ok, false);
    assert.equal(assessManualOrder(facts({ deployment: { ...facts().deployment, factoryOwnsPool: false } })).ok, false);
    assert.equal(assessManualOrder(facts({ priceable: false, markPrice: 0n })).ok, false);
    assert.equal(assessManualOrder(facts({ collateralToken: "0x0000000000000000000000000000000000000000" })).ok, false);
  });

  it("blocks a duplicate, a pending send, and an unknown outcome", () => {
    let state: Flight = { phase: "clear" };
    const first = reduceFlight(state, { type: "start", intentId: "a" });
    assert.equal(first.error, null);
    state = first.state;
    assert.match(reduceFlight(state, { type: "start", intentId: "b" }).error ?? "", /already waiting/);
    state = reduceFlight(state, { type: "unknown", hash: "0xabc" }).state;
    assert.match(reduceFlight(state, { type: "start", intentId: "b" }).error ?? "", /unknown/);
    assert.equal(reduceFlight(state, { type: "acknowledge" }).error, null);
    state = reduceFlight(state, { type: "acknowledge" }).state;
    assert.equal(state.phase, "unknown");
    assert.match(reduceFlight(state, { type: "start", intentId: "a" }).error ?? "", /unknown/);
    let done: Flight = { phase: "clear" };
    done = reduceFlight(done, { type: "start", intentId: "a" }).state;
    done = reduceFlight(done, { type: "success", hash: "0xdef" }).state;
    assert.match(reduceFlight(done, { type: "start", intentId: "a" }).error ?? "", /already submitted/);
    assert.equal(reduceFlight(done, { type: "start", intentId: "c" }).error, null);
  });

  it("keeps the receipt, the hash, and the resting order separate", () => {
    assert.equal(classifyReceipt(null, null), "rejected");
    assert.equal(classifyReceipt("0x1", null), "unknown");
    assert.equal(classifyReceipt("0x1", "reverted"), "failed");
    assert.equal(classifyReceipt("0x1", "success"), "submitted");
    assert.equal(restingStatus(["7"], "7"), "resting");
    assert.equal(restingStatus(["7"], "8"), "not-resting");
    assert.equal(restingStatus(null, "8"), "unverified");
    assert.equal(restingStatus(["7"], null), "unverified");
  });

  it("refuses a wallet that is not the quoted account on chain 50383", () => {
    assert.equal(walletReady(50383n, WALLET, WALLET), null);
    assert.equal(walletReady(50383n, WALLET.toLowerCase(), WALLET), null);
    assert.match(walletReady(50312n, WALLET, WALLET) ?? "", /50383/);
    assert.match(walletReady(null, WALLET, WALLET) ?? "", /50383/);
    assert.match(walletReady(50383n, "0x0000000000000000000000000000000000000001", WALLET) ?? "", /does not match/);
    assert.match(walletReady(50383n, null, WALLET) ?? "", /did not return/);
  });

  it("expires a quote and does not let the signing module accept a key field", async () => {
    const built = assessManualOrder(facts());
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.equal(quoteFresh(built.quote, 1_000), true);
    assert.equal(quoteFresh(built.quote, 1_000 + 20_001), false);
    const source = await readFile(new URL("./manual-order-client.ts", import.meta.url), "utf8");
    assert.match(source, /createTrader\s*\(/);
    assert.match(source, /placePerpOrder\s*\(/);
    assert.match(source, /ORDER_TYPE\.POST_ONLY/);
    assert.doesNotMatch(source, /privateKey\s*:/);
    assert.doesNotMatch(source, /placeOrderFor\s*\(/);
    assert.doesNotMatch(source, /orderType:\s*2/);
    assert.match(source, /localStorage/);
    assert.match(source, /net_version/);
  });

  it("refuses a post-only price that would cross the book", () => {
    const mark = facts().markPrice;
    const tick = facts().tickSize;
    const buy = postOnlyPrice(mark, tick, true);
    const sell = postOnlyPrice(mark, tick, false);
    if (buy == null || sell == null) {
      assert.fail("post-only prices");
      return;
    }
    assert.equal(postOnlyCrosses(buy, true, buy - tick, buy), true);
    assert.equal(postOnlyCrosses(buy, true, buy - tick, buy + tick), false);
    assert.equal(postOnlyCrosses(sell, false, sell, sell + tick), true);
    assert.equal(assessManualOrder(facts({ bestAsk: buy })).ok, false);
    assert.equal(assessManualOrder(facts({ isBid: false, bestBid: sell })).ok, false);
    assert.equal(assessManualOrder(facts({ bestBid: buy - tick, bestAsk: buy + tick })).ok, true);
    assert.equal(assessManualOrder(facts({ bookKnown: false })).ok, false);
    const same = assessManualOrder(facts({ block: "1" }));
    const later = assessManualOrder(facts({ block: "999" }));
    assert.equal(same.ok && later.ok, true);
    if (!same.ok || !later.ok) return;
    assert.equal(same.quote.intentId, later.quote.intentId);
  });

  it("recovers a stored intent across refresh and keeps an unknown receipt locked", () => {
    const built = assessManualOrder(facts());
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const intent = {
      intentId: built.quote.intentId,
      wallet: built.quote.wallet,
      pool: built.quote.pool,
      side: built.quote.side,
      price: built.quote.price,
      quantity: built.quote.quantity,
    };
    const hash = `0x${"ab".repeat(32)}`;
    const stored = rememberIntent(emptyLedger(), intent);
    assert.equal(stored.ok, true);
    if (!stored.ok) return;
    const pending = attachHash(stored.ledger, intent.intentId, hash);
    const restored = parseLedger(serializeLedger(pending));
    assert.equal(restored.ok, true);
    if (!restored.ok) return;
    assert.equal(restored.ledger.intents[0]?.hash, hash);
    assert.equal(restored.ledger.intents[0]?.phase, "pending");
    assert.match(submissionBlock(restored.ledger, intent.intentId) ?? "", /unresolved/);
    assert.match(submissionBlock(restored.ledger, "other-intent") ?? "", /unresolved/);
    const missing = applyReconcile(restored.ledger, intent.intentId, { receipt: "missing", orders: [] });
    assert.equal(missing.intents[0]?.phase, "unknown");
    const seen = acknowledgeIntent(missing, intent.intentId);
    assert.equal(seen.error, null);
    assert.equal(seen.ledger.intents[0]?.acknowledged, true);
    assert.equal(seen.ledger.intents[0]?.phase, "unknown");
    assert.ok(submissionBlock(seen.ledger, intent.intentId));
    const duplicated = rememberIntent(seen.ledger, intent);
    assert.equal(duplicated.ok, false);
    const reverted = applyReconcile(missing, intent.intentId, { receipt: "reverted", orders: [] });
    assert.equal(reverted.intents[0]?.phase, "reverted");
    assert.equal(submissionBlock(reverted, intent.intentId), null);
    const matched = applyReconcile(stored.ledger, intent.intentId, {
      receipt: "missing",
      orders: [{ orderId: "9", isBid: true, price: intent.price, quantity: intent.quantity }],
    });
    assert.equal(matched.intents[0]?.phase, "done");
    assert.equal(matched.intents[0]?.orderId, "9");
    assert.equal(parseLedger("{").ok, false);
    assert.equal(parseLedger(null).ok, true);
    const hashed = attachHash(stored.ledger, intent.intentId, hash);
    assert.equal(releaseUnsent(hashed, intent.intentId).intents.length, 1);
    assert.equal(releaseUnsent(stored.ledger, intent.intentId).intents.length, 0);
    const unreadable: StoredIntent = { ...stored.ledger.intents[0], hash: null, phase: "pending" };
    assert.equal(applyReconcile({ version: 1, intents: [unreadable] }, intent.intentId, { receipt: "unread", orders: null }).intents[0]?.phase, "pending");
  });

  it("refuses a wallet that cannot prove Hideki v2", () => {
    const ready = { chainId: 50383n, account: WALLET, netVersion: "50000259", poolCodeBytes: 200 };
    assert.equal(walletIdentityReady(ready, WALLET), null);
    assert.match(walletIdentityReady({ ...ready, chainId: 50312n }, WALLET) ?? "", /50383/);
    assert.match(walletIdentityReady({ ...ready, netVersion: null }, WALLET) ?? "", /cannot prove/);
    assert.match(walletIdentityReady({ ...ready, netVersion: "50000258" }, WALLET) ?? "", /50000258/);
    assert.match(walletIdentityReady({ ...ready, poolCodeBytes: 0 }, WALLET) ?? "", /no code/);
    assert.match(walletIdentityReady({ ...ready, poolCodeBytes: null }, WALLET) ?? "", /could not read/);
    assert.match(walletIdentityReady({ ...ready, account: "0x0000000000000000000000000000000000000001" }, WALLET) ?? "", /does not match/);
  });

  it("refuses the wrong network, a disconnected wallet, and an unsupported market", () => {
    assert.match(reviewPreconditions({ account: null, chainId: 50383, symbol: "BTC" }) ?? "", /Connect a wallet/);
    assert.match(reviewPreconditions({ account: WALLET, chainId: 1, symbol: "BTC" }) ?? "", /Wrong network/);
    assert.match(reviewPreconditions({ account: WALLET, chainId: null, symbol: "BTC" }) ?? "", /unknown/);
    assert.match(reviewPreconditions({ account: WALLET, chainId: 50383, symbol: "ETH" }) ?? "", /cannot be ordered/);
    assert.equal(reviewPreconditions({ account: WALLET, chainId: 50383, symbol: "BTC" }), null);
  });

  it("refuses missing market metadata without inventing a size", () => {
    const missingTick = assessManualOrder(facts({ tickSize: 0n }));
    assert.equal(missingTick.ok, false);
    if (missingTick.ok) return;
    assert.match(missingTick.error, /tick/);
    assert.equal(missingTick.observed.limitPrice, "missing");
    const missingSize = assessManualOrder(facts({ minQuantity: 0n }));
    assert.equal(missingSize.ok, false);
    if (missingSize.ok) return;
    assert.match(missingSize.error, /minimum/);
    assert.equal(missingSize.observed.minimumSize, "missing");
  });

  it("rejects a missing or stale order book and still prices a fresh non-crossing book", () => {
    assert.equal(orderBookState(false, 1_000, 1_000), "missing");
    assert.equal(orderBookState(true, 1_000, 1_000 + QUOTE_TTL_MS + 1), "stale");
    assert.equal(orderBookState(true, 1_000, 1_000 + QUOTE_TTL_MS), "fresh");
    const missing = assessManualOrder(facts({ bookKnown: false, bestBid: null, bestAsk: null }));
    assert.equal(missing.ok, false);
    if (missing.ok) return;
    assert.match(missing.error, /order book/);
    assert.equal(missing.observed.bestBid, "missing");
    const mark = facts().markPrice;
    const tick = facts().tickSize;
    const sell = postOnlyPrice(mark, tick, false);
    if (sell == null) {
      assert.fail("sell price");
      return;
    }
    const crossed = assessManualOrder(facts({ isBid: false, bestBid: sell, bestAsk: sell + tick }));
    assert.equal(crossed.ok, false);
    if (crossed.ok) return;
    assert.match(crossed.error, /post-only sell/);
    assert.match(crossed.error, /Nothing will be signed/);
    assert.notEqual(crossed.observed.requiredMargin, "missing");
    const valid = assessManualOrder(facts({ isBid: false, bestBid: sell - tick, bestAsk: sell + tick }));
    assert.equal(valid.ok, true);
    if (!valid.ok) return;
    assert.ok(BigInt(valid.quote.price) > sell - tick);
    assert.equal(postOnlyCrosses(BigInt(valid.quote.price), false, sell - tick, sell + tick), false);
  });

  it("expires a quote and names a failed RPC without signing", () => {
    const built = assessManualOrder(facts());
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.equal(quoteFresh(built.quote, built.quote.quotedAt + QUOTE_TTL_MS), true);
    assert.equal(quoteFresh(built.quote, built.quote.quotedAt + QUOTE_TTL_MS + 1), false);
    assert.match(explainRpcFailure("fetch failed"), /Hideki v2 RPC failed/);
    assert.match(explainRpcFailure("socket hang up"), /Nothing will be signed/);
    assert.doesNotMatch(explainRpcFailure("BTC-PERP is not listed"), /RPC failed/);
  });
});
