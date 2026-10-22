/** Manual execution review. Nothing in this module can sign or broadcast. */

export const HIDEKI_CHAIN_ID = 50383;
export const HIDEKI_V2_ID = "hideki-v2";
export const HIDEKI_V2_NET_VERSION = "50000259";
export const HIDEKI_V2_RPC_HOST = "api.hideki2.infra.testnet.somnia.network";
export const QUOTE_TTL_MS = 20_000;
export const SLIPPAGE_BPS = 50n;
export const FEE_DENOMINATOR = 10_000_000n;

export const SUBMISSION_ENABLED = false as const;

/** Methods the review screen may ask a browser wallet. Sending is not one of them. */
export const WALLET_METHODS = [
  "eth_requestAccounts",
  "eth_accounts",
  "eth_chainId",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
] as const;

export type ReviewQuote = {
  wallet: string;
  chainId: number;
  market: string;
  pool: string;
  positionSize: string;
  reducingCapacity: string;
  pendingOppositeQuantity: string;
  openOrderIds: string[];
  healthAgrees: boolean;
  priceable: boolean;
  marketStatus: number;
  restricted: boolean;
  block: string;
  quantity: string;
  isBid: boolean;
  direction: "sell" | "buy";
  priceBound: string;
  markPrice: string;
  takerFee: string;
  feeRate: string;
  lotSize: string;
  minQuantity: string;
  quotedAt: number;
  deploymentId: string;
};

export type ReviewAttempt = {
  intentId: string;
  outcome: "failed" | "blocked";
};

export type ReviewDecision = {
  ok: boolean;
  reason: string;
  warnings: string[];
  intentId: string | null;
  submissionEnabled: false;
};

const IOC_WARNING =
  "An IOC order is not protocol-enforced reduce-only. If the position shrinks before inclusion, the excess can reverse it.";

const DISABLED_WARNING = "Sending is disabled. This screen cannot submit, sign, or grant an operator permission.";

export function allowWalletMethod(method: string): void {
  if ((WALLET_METHODS as readonly string[]).includes(method)) return;
  throw new Error(`Wallet method ${method} is not allowed. No transaction will be sent.`);
}

export function submitReviewedOrder(): never {
  throw new Error("Transaction submission is disabled until it is separately approved.");
}

export type DeploymentObservation = {
  chainId: number;
  netVersion: string;
  rpcHost: string;
  marginBank: string;
  expectedMarginBank: string;
  factory: string;
  expectedFactory: string;
  marginBankCodeBytes: number;
  factoryCodeBytes: number;
  poolCodeBytes: number;
  factoryOwnsPool: boolean;
  poolMarginBank: string;
};

/** Chain id 50383 is shared. Identity is the v2 RPC plus the SDK contracts answering for this pool. */
export function assessDeployment(input: DeploymentObservation): { ok: true; id: typeof HIDEKI_V2_ID } | { ok: false; reason: string } {
  if (input.rpcHost !== HIDEKI_V2_RPC_HOST) return { ok: false, reason: "Quote RPC is not the Hideki v2 endpoint." };
  if (input.chainId !== HIDEKI_CHAIN_ID) return { ok: false, reason: "Hideki v2 RPC did not report chain 50383." };
  if (input.netVersion !== HIDEKI_V2_NET_VERSION) return { ok: false, reason: "Network version is not Hideki v2." };
  if (!sameAddress(input.marginBank, input.expectedMarginBank) || input.marginBankCodeBytes === 0) {
    return { ok: false, reason: "Margin bank does not match the SDK Hideki deployment." };
  }
  if (!sameAddress(input.factory, input.expectedFactory) || input.factoryCodeBytes === 0) {
    return { ok: false, reason: "Perp factory does not match the SDK Hideki deployment." };
  }
  if (input.poolCodeBytes === 0 || !input.factoryOwnsPool) {
    return { ok: false, reason: "This pool was not deployed by the Hideki v2 factory." };
  }
  if (!sameAddress(input.poolMarginBank, input.expectedMarginBank)) {
    return { ok: false, reason: "The pool points at a different margin bank." };
  }
  return { ok: true, id: HIDEKI_V2_ID };
}

export type WalletSession = { address: string | null; chainId: number | null; error: string | null };

export function reduceWallet(
  session: WalletSession,
  event:
    | { type: "rejected"; message: string }
    | { type: "connected"; address: string; chainId: number }
    | { type: "disconnect" }
    | { type: "accounts"; accounts: string[] }
    | { type: "chain"; chainId: number },
): { session: WalletSession; clearQuote: boolean } {
  if (event.type === "rejected") {
    return { session: { address: session.address, chainId: session.chainId, error: event.message }, clearQuote: false };
  }
  if (event.type === "disconnect") return { session: { address: null, chainId: null, error: null }, clearQuote: true };
  if (event.type === "accounts") {
    const next = event.accounts[0] ?? null;
    if (!next) return { session: { address: null, chainId: null, error: null }, clearQuote: true };
    if (session.address && sameAddress(session.address, next)) return { session, clearQuote: false };
    return { session: { address: next, chainId: session.chainId, error: null }, clearQuote: true };
  }
  if (event.type === "chain") {
    return { session: { address: session.address, chainId: event.chainId, error: null }, clearQuote: true };
  }
  return { session: { address: event.address, chainId: event.chainId, error: null }, clearQuote: true };
}

export function reviewIntentId(quote: ReviewQuote): string {
  const orders = [...quote.openOrderIds].sort().join(",");
  return [
    quote.wallet.toLowerCase(),
    quote.pool.toLowerCase(),
    quote.positionSize,
    quote.reducingCapacity,
    quote.quantity,
    quote.direction,
    quote.priceBound,
    orders,
  ].join(":");
}

export function buildProtectiveQuote(input: {
  wallet: string;
  chainId: number;
  market: string;
  pool: string;
  positionSize: bigint;
  reducingCapacity: bigint;
  pendingOppositeQuantity: bigint;
  openOrderIds: string[];
  healthAgrees: boolean;
  priceable: boolean;
  marketStatus: number;
  restricted: boolean;
  block: string;
  markPrice: bigint;
  oneBase: bigint;
  takerFeeBpsTimes1k: bigint;
  tickSize: bigint;
  lotSize: bigint;
  minQuantity: bigint;
  requestedQuantity: bigint | null;
  quotedAt: number;
  deploymentId: string;
}): { ok: true; quote: ReviewQuote } | { ok: false; error: string } {
  if (input.deploymentId !== HIDEKI_V2_ID) return { ok: false, error: "Quote is not bound to the Hideki v2 deployment." };
  if (input.chainId !== HIDEKI_CHAIN_ID) return { ok: false, error: "Quote is not for Hideki chain 50383." };
  if (input.positionSize === 0n) return { ok: false, error: "The connected wallet has no position in this market." };
  if (!input.priceable || input.markPrice <= 0n || input.oneBase <= 0n) {
    return { ok: false, error: "The mark is unpriceable. No order is prepared." };
  }
  if (input.marketStatus >= 2) return { ok: false, error: "The market is not open for an order." };
  if (input.pendingOppositeQuantity !== 0n) {
    return { ok: false, error: "Pending opposite orders make the reducing capacity uncertain." };
  }
  const abs = input.positionSize < 0n ? -input.positionSize : input.positionSize;
  const lot = input.lotSize > 0n ? input.lotSize : 1n;
  const requested = input.requestedQuantity == null ? input.minQuantity : input.requestedQuantity;
  if (requested < 0n) return { ok: false, error: "Quantity must be a non-negative integer." };
  let quantity = requested < abs ? requested : abs;
  if (quantity > input.reducingCapacity) quantity = input.reducingCapacity;
  quantity = (quantity / lot) * lot;
  if (quantity <= 0n || quantity < input.minQuantity) {
    return { ok: false, error: "The aligned quantity is below the pool minimum." };
  }
  const isBid = input.positionSize < 0n;
  const priceBound = crossingPrice(input.markPrice, isBid, input.tickSize);
  if (priceBound <= 0n) return { ok: false, error: "The price bound rounded to zero." };
  const notional = (quantity * priceBound) / input.oneBase;
  const takerFee = (notional * input.takerFeeBpsTimes1k) / FEE_DENOMINATOR;
  return {
    ok: true,
    quote: {
      wallet: input.wallet,
      chainId: input.chainId,
      market: input.market,
      pool: input.pool,
      positionSize: input.positionSize.toString(),
      reducingCapacity: input.reducingCapacity.toString(),
      pendingOppositeQuantity: "0",
      openOrderIds: input.openOrderIds,
      healthAgrees: input.healthAgrees,
      priceable: true,
      marketStatus: input.marketStatus,
      restricted: input.restricted,
      block: input.block,
      quantity: quantity.toString(),
      isBid,
      direction: isBid ? "buy" : "sell",
      priceBound: priceBound.toString(),
      markPrice: input.markPrice.toString(),
      takerFee: takerFee.toString(),
      feeRate: input.takerFeeBpsTimes1k.toString(),
      lotSize: lot.toString(),
      minQuantity: input.minQuantity.toString(),
      quotedAt: input.quotedAt,
      deploymentId: HIDEKI_V2_ID,
    },
  };
}

export function decideReview(input: {
  connected: { address: string; chainId: number } | null;
  quoted: ReviewQuote | null;
  live: ReviewQuote | null;
  now: number;
  attempts: ReviewAttempt[];
  requireLive: boolean;
}): ReviewDecision {
  const warnings = [IOC_WARNING, DISABLED_WARNING];
  const fail = (reason: string, intentId: string | null = null): ReviewDecision => ({
    ok: false,
    reason,
    warnings,
    intentId,
    submissionEnabled: false,
  });

  if (!input.connected) return fail("Connect the wallet that owns the position.");
  if (input.connected.chainId !== HIDEKI_CHAIN_ID) return fail("Wrong chain. Hideki testnet is chain 50383.");
  if (!input.quoted) return fail("Load the connected wallet before review.");
  if (input.quoted.chainId !== HIDEKI_CHAIN_ID) return fail("The quote is not for chain 50383.");
  if (input.quoted.deploymentId !== HIDEKI_V2_ID) return fail("This quote is not from the Hideki v2 deployment.");
  if (!sameAddress(input.connected.address, input.quoted.wallet)) {
    return fail("Wallet mismatch. Execution review is only for the connected wallet.");
  }
  if (input.now - input.quoted.quotedAt > QUOTE_TTL_MS) return fail("The quote is stale. Load the position again.");
  if (input.requireLive && !input.live) return fail("The live recheck has not returned.");

  const intentId = reviewIntentId(input.quoted);
  const prior = input.attempts.find((attempt) => attempt.intentId === intentId);
  if (prior?.outcome === "failed") return fail("This order already failed. It will not be retried.", intentId);
  if (prior) return fail("Duplicate review. This order was already checked and not sent.", intentId);

  if (input.live) {
    if (input.live.chainId !== HIDEKI_CHAIN_ID) return fail("The live read is not on chain 50383.", intentId);
    if (input.live.deploymentId !== input.quoted.deploymentId) return fail("The deployment identity changed.", intentId);
    if (!sameAddress(input.live.wallet, input.quoted.wallet)) return fail("The account changed before confirmation.", intentId);
    if (input.live.pool.toLowerCase() !== input.quoted.pool.toLowerCase() || input.live.market !== input.quoted.market) {
      return fail("The market changed before confirmation.", intentId);
    }
    if (input.live.positionSize !== input.quoted.positionSize) return fail("The position changed before confirmation.", intentId);
    if (input.live.reducingCapacity !== input.quoted.reducingCapacity) {
      return fail("Reducing capacity changed before confirmation.", intentId);
    }
    if (!sameIds(input.live.openOrderIds, input.quoted.openOrderIds)) {
      return fail("Open orders changed before confirmation.", intentId);
    }
    if (input.live.marketStatus !== input.quoted.marketStatus || input.live.restricted !== input.quoted.restricted) {
      return fail("Market status changed before confirmation.", intentId);
    }
    if (!input.live.healthAgrees || !input.live.priceable || !input.quoted.healthAgrees || !input.quoted.priceable) {
      return fail("Account health is no longer consistent.", intentId);
    }
    if (input.live.quantity !== input.quoted.quantity || input.live.priceBound !== input.quoted.priceBound) {
      return fail("The order terms changed before confirmation.", intentId);
    }
  }

  if (input.quoted.pendingOppositeQuantity !== "0") return fail("Pending opposite orders block this review.", intentId);
  let quantity: bigint;
  let capacity: bigint;
  let minimum: bigint;
  try {
    quantity = BigInt(input.quoted.quantity);
    capacity = BigInt(input.quoted.reducingCapacity);
    minimum = BigInt(input.quoted.minQuantity);
  } catch {
    return fail("The quote quantities are not integers.", intentId);
  }
  if (quantity <= 0n || quantity > capacity || quantity < minimum) {
    return fail("Reducing capacity does not cover the order.", intentId);
  }

  return {
    ok: true,
    reason: "Checks passed. Nothing was sent.",
    warnings,
    intentId,
    submissionEnabled: false,
  };
}

function crossingPrice(mark: bigint, isBid: boolean, tick: bigint): bigint {
  const slipped = isBid ? (mark * (10_000n + SLIPPAGE_BPS)) / 10_000n : (mark * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  if (tick <= 0n) return slipped;
  if (isBid) return ((slipped + tick - 1n) / tick) * tick;
  return (slipped / tick) * tick;
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameIds(left: string[], right: string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
