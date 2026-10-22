import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HIDEKI_CHAIN_ID,
  allowWalletMethod,
  assessDeployment,
  buildProtectiveQuote,
  decideReview,
  reduceWallet,
  submitReviewedOrder,
  type ReviewQuote,
} from "./review.ts";

const WALLET = "0xd167376D0431131b4C2EC25e3581c6AF734794F3";
const OTHER = "0x00000000000000000000000000000000000000aa";

function quote(overrides: Partial<ReviewQuote> = {}): ReviewQuote {
  const built = buildProtectiveQuote({
    wallet: WALLET,
    chainId: HIDEKI_CHAIN_ID,
    market: "BTC",
    pool: "0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0",
    positionSize: 26000n,
    reducingCapacity: 26000n,
    pendingOppositeQuantity: 0n,
    openOrderIds: [],
    healthAgrees: true,
    priceable: true,
    marketStatus: 0,
    restricted: false,
    block: "29992939",
    markPrice: 100_000n,
    oneBase: 1n,
    takerFeeBpsTimes1k: 10_000n,
    tickSize: 1n,
    lotSize: 1000n,
    minQuantity: 13000n,
    requestedQuantity: 13000n,
    quotedAt: 1_000,
    deploymentId: "hideki-v2",
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("quote");
  return { ...built.quote, ...overrides };
}

function decide(quoted: ReviewQuote, live: ReviewQuote | null, extra: Partial<Parameters<typeof decideReview>[0]> = {}) {
  return decideReview({
    connected: { address: WALLET, chainId: HIDEKI_CHAIN_ID },
    quoted,
    live,
    now: 1_000,
    attempts: [],
    requireLive: true,
    ...extra,
  });
}

describe("execution review", () => {
  it("prepares a sell inside reducing capacity and estimates the taker fee", () => {
    const prepared = quote();
    assert.equal(prepared.direction, "sell");
    assert.equal(prepared.isBid, false);
    assert.equal(prepared.quantity, "13000");
    assert.equal(prepared.priceBound, "99500");
    assert.equal(prepared.takerFee, "1293500");
  });

  it("refuses a wallet mismatch", () => {
    const result = decide(quote(), quote(), { connected: { address: OTHER, chainId: HIDEKI_CHAIN_ID } });
    assert.equal(result.ok, false);
    assert.match(result.reason, /Wallet mismatch/);
    assert.equal(result.submissionEnabled, false);
  });

  it("refuses the wrong chain", () => {
    const result = decide(quote(), quote(), { connected: { address: WALLET, chainId: 1 } });
    assert.equal(result.ok, false);
    assert.match(result.reason, /Wrong chain/);
  });

  it("refuses a stale quote", () => {
    const result = decide(quote(), quote(), { now: 1_000 + 20_001 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /stale/);
  });

  it("refuses a position change", () => {
    const result = decide(quote(), quote({ positionSize: "13000" }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /position changed/i);
  });

  it("refuses a capacity change", () => {
    const result = decide(quote(), quote({ reducingCapacity: "13000" }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /capacity changed/i);
  });

  it("blocks a duplicate submission", () => {
    const prepared = quote();
    const first = decide(prepared, prepared);
    assert.equal(first.ok, true);
    const second = decide(prepared, prepared, { attempts: [{ intentId: first.intentId ?? "", outcome: "blocked" }] });
    assert.equal(second.ok, false);
    assert.match(second.reason, /Duplicate/);
  });

  it("does not retry a failed transaction", () => {
    const prepared = quote();
    const first = decide(prepared, prepared);
    const failed = decide(prepared, prepared, { attempts: [{ intentId: first.intentId ?? "", outcome: "failed" }] });
    assert.equal(failed.ok, false);
    assert.match(failed.reason, /already failed/);
    assert.throws(() => submitReviewedOrder(), /disabled/);
  });

  it("passes a matching live recheck without enabling submission", () => {
    const prepared = quote();
    const result = decide(prepared, { ...prepared });
    assert.equal(result.ok, true);
    assert.equal(result.submissionEnabled, false);
    assert.match(result.warnings.join(" "), /not protocol-enforced reduce-only/);
  });

  it("rejects every method that could send a transaction", () => {
    for (const method of ["eth_sendTransaction", "wallet_sendTransaction", "eth_signTransaction", "personal_sign"]) {
      assert.throws(() => allowWalletMethod(method), /not allowed/);
    }
    allowWalletMethod("eth_chainId");
  });

  it("rejects a chain id match that is not the Hideki v2 deployment", () => {
    const wrong = assessDeployment({
      chainId: HIDEKI_CHAIN_ID,
      netVersion: "50000258",
      rpcHost: "api.hideki.example",
      marginBank: "0x478769E1177C0773c43A593DCCc4Ad15F15F1394",
      expectedMarginBank: "0x478769E1177C0773c43A593DCCc4Ad15F15F1394",
      factory: "0xE631fAEE547baeE07353E290f0562ea67d856560",
      expectedFactory: "0xE631fAEE547baeE07353E290f0562ea67d856560",
      marginBankCodeBytes: 176,
      factoryCodeBytes: 176,
      poolCodeBytes: 322,
      factoryOwnsPool: true,
      poolMarginBank: "0x478769E1177C0773c43A593DCCc4Ad15F15F1394",
    });
    assert.equal(wrong.ok, false);
    const owned = assessDeployment({
      ...{
        chainId: HIDEKI_CHAIN_ID,
        netVersion: "50000259",
        rpcHost: "api.hideki2.infra.testnet.somnia.network",
        marginBank: "0x478769E1177C0773c43A593DCCc4Ad15F15F1394",
        expectedMarginBank: "0x478769E1177C0773c43A593DCCc4Ad15F15F1394",
        factory: "0xE631fAEE547baeE07353E290f0562ea67d856560",
        expectedFactory: "0xE631fAEE547baeE07353E290f0562ea67d856560",
        marginBankCodeBytes: 176,
        factoryCodeBytes: 176,
        poolCodeBytes: 322,
        factoryOwnsPool: false,
        poolMarginBank: "0x478769E1177C0773c43A593DCCc4Ad15F15F1394",
      },
    });
    assert.equal(owned.ok, false);
    if (!owned.ok) assert.match(owned.reason, /not deployed/);
  });

  it("clears a review when the wallet rejects, disconnects, switches account, or changes chain", () => {
    const empty = { address: null, chainId: null, error: null };
    const rejected = reduceWallet(empty, { type: "rejected", message: "User rejected the request." });
    assert.equal(rejected.session.address, null);
    assert.match(rejected.session.error ?? "", /rejected/);
    const connected = reduceWallet(empty, { type: "connected", address: WALLET, chainId: 1 });
    assert.equal(connected.session.chainId, 1);
    assert.equal(connected.clearQuote, true);
    const switched = reduceWallet(connected.session, { type: "chain", chainId: HIDEKI_CHAIN_ID });
    assert.equal(switched.session.chainId, HIDEKI_CHAIN_ID);
    assert.equal(switched.clearQuote, true);
    const changed = reduceWallet(switched.session, { type: "accounts", accounts: [OTHER] });
    assert.equal(changed.clearQuote, true);
    assert.notEqual(changed.session.address?.toLowerCase(), WALLET.toLowerCase());
    const dropped = reduceWallet(changed.session, { type: "disconnect" });
    assert.equal(dropped.session.address, null);
    assert.equal(dropped.clearQuote, true);
  });
});
