/** Manual BTC-PERP post-only quote rules. This module cannot sign or broadcast. */

import { HIDEKI_CHAIN_ID, HIDEKI_V2_ID, HIDEKI_V2_NET_VERSION, HIDEKI_V2_RPC_HOST, QUOTE_TTL_MS, assessDeployment, type DeploymentObservation } from "./review.ts";

export const MANUAL_MARKET = "BTC";
export const POST_ONLY = 3;
export const FEE_SCALE = 10_000_000n;
export const MANUAL_AUTOMATIC = false as const;

export type ManualSide = "buy" | "sell";

export type Flight =
  | { phase: "clear" }
  | { phase: "pending"; intentId: string }
  | { phase: "unknown"; intentId: string; hash: string }
  | { phase: "done"; intentId: string; hash: string };

export type ManualFacts = {
  wallet: string;
  symbol: string;
  pool: string;
  isBid: boolean;
  markPrice: bigint;
  tickSize: bigint;
  lotSize: bigint;
  minQuantity: bigint;
  oneBase: bigint;
  baseDecimals: number;
  quoteDecimals: number;
  makerFeeBpsTimes1k: bigint;
  takerFeeBpsTimes1k: bigint;
  initialMarginBps: bigint;
  maintenanceMarginBps: bigint;
  maxQuantity: bigint;
  placeable: boolean;
  limitedBy: string;
  priceable: boolean;
  positionSize: bigint;
  unlockedCollateral: bigint;
  equity: bigint;
  imReq: bigint;
  mmReq: bigint;
  marginStatus: string;
  collateralToken: string;
  block: string;
  quotedAt: number;
  deployment: DeploymentObservation;
  bookKnown: boolean;
  bestBid: bigint | null;
  bestAsk: bigint | null;
};

export type ManualQuote = {
  intentId: string;
  wallet: string;
  symbol: "BTC";
  pool: string;
  isBid: boolean;
  side: ManualSide;
  price: string;
  quantity: string;
  priceDisplay: string;
  quantityDisplay: string;
  notionalDisplay: string;
  makerFeeDisplay: string;
  takerFeeNote: string;
  positionSize: string;
  positionDisplay: string;
  filledExposure: string;
  filledExposureDisplay: string;
  unlockedCollateral: string;
  unlockedCollateralDisplay: string;
  equity: string;
  equityDisplay: string;
  imReq: string;
  imReqDisplay: string;
  mmReq: string;
  mmReqDisplay: string;
  marginStatus: string;
  collateralToken: string;
  maxQuantity: string;
  maxQuantityDisplay: string;
  limitedBy: string;
  initialMarginBps: string;
  maintenanceMarginBps: string;
  makerFeeRate: string;
  takerFeeRate: string;
  bestBidDisplay: string;
  bestAskDisplay: string;
  block: string;
  deploymentId: typeof HIDEKI_V2_ID;
  chainId: typeof HIDEKI_CHAIN_ID;
  netVersion: string;
  quotedAt: number;
  orderType: typeof POST_ONLY;
  warnings: string[];
};

const WARNINGS = [
  "This is one manual post-only order. Liquidation Guardian will not send it automatically.",
  "A post-only order rests. It does not change the position until someone trades against it.",
  "placePerpOrder is not reduce-only. A later fill can increase or reverse exposure.",
  "The price is one tick off the mark and must stay strictly behind the best opposing order.",
  "Chain 50383 is shared with an older Hideki network. The wallet must answer Hideki v2 itself.",
  "An unresolved hash is stored in this browser. Acknowledging it does not allow another send.",
  `This quote expires ${QUOTE_TTL_MS / 1000} seconds after it is read. A stale quote is not signed.`,
];

export function postOnlyPrice(mark: bigint, tick: bigint, isBid: boolean): bigint | null {
  if (mark <= 0n || tick <= 0n) return null;
  if (isBid) {
    const below = alignDown(mark - tick, tick);
    if (below <= 0n || below >= mark) return null;
    return below;
  }
  const above = alignUp(mark + tick, tick);
  if (above <= mark) return null;
  return above;
}

export function postOnlyCrosses(price: bigint, isBid: boolean, bestBid: bigint | null, bestAsk: bigint | null): boolean {
  if (price <= 0n) return true;
  if (isBid) return bestAsk != null && bestAsk > 0n && price >= bestAsk;
  return bestBid != null && bestBid > 0n && price <= bestBid;
}

export function alignedMinimum(minQuantity: bigint, lotSize: bigint): bigint | null {
  if (minQuantity <= 0n || lotSize <= 0n) return null;
  const lots = (minQuantity + lotSize - 1n) / lotSize;
  const quantity = lots * lotSize;
  if (quantity < minQuantity || quantity % lotSize !== 0n) return null;
  return quantity;
}

export function assessManualOrder(facts: ManualFacts): { ok: true; quote: ManualQuote } | { ok: false; error: string } {
  if (facts.symbol !== MANUAL_MARKET) return { ok: false, error: "Only BTC-PERP can be used for this manual order." };
  if (!/^0x[0-9a-fA-F]{40}$/.test(facts.wallet)) return { ok: false, error: "The wallet address is not a 20-byte account." };
  const deployment = assessDeployment(facts.deployment);
  if (!deployment.ok) return { ok: false, error: deployment.reason };
  if (facts.deployment.chainId !== HIDEKI_CHAIN_ID) return { ok: false, error: "Hideki v2 RPC did not report chain 50383." };
  if (facts.deployment.netVersion !== HIDEKI_V2_NET_VERSION) return { ok: false, error: "Network version is not Hideki v2." };
  if (facts.deployment.rpcHost !== HIDEKI_V2_RPC_HOST) return { ok: false, error: "Quote RPC is not the Hideki v2 endpoint." };
  if (!facts.priceable || facts.markPrice <= 0n) return { ok: false, error: "BTC-PERP has no usable mark. Nothing will be signed." };
  if (facts.oneBase <= 0n) return { ok: false, error: "The market base unit is missing." };
  if (!facts.collateralToken || facts.collateralToken === "0x0000000000000000000000000000000000000000") {
    return { ok: false, error: "The margin bank did not report a collateral token." };
  }
  const price = postOnlyPrice(facts.markPrice, facts.tickSize, facts.isBid);
  if (price == null) return { ok: false, error: "No post-only price can sit off the mark on this tick grid." };
  if (facts.isBid ? price >= facts.markPrice : price <= facts.markPrice) {
    return { ok: false, error: "The post-only price would touch or cross the mark." };
  }
  if (!facts.bookKnown) {
    return { ok: false, error: "The order book could not be read, so a crossing post-only price cannot be ruled out. Nothing will be signed." };
  }
  if (postOnlyCrosses(price, facts.isBid, facts.bestBid, facts.bestAsk)) {
    return {
      ok: false,
      error: facts.isBid
        ? "This post-only buy would cross the best ask. Nothing will be signed."
        : "This post-only sell would cross the best bid. Nothing will be signed.",
    };
  }
  const quantity = alignedMinimum(facts.minQuantity, facts.lotSize);
  if (quantity == null) return { ok: false, error: "BTC-PERP has no valid minimum quantity." };
  if (!facts.placeable || facts.maxQuantity < quantity) {
    return { ok: false, error: `The minimum order is larger than the account can place (${facts.limitedBy}).` };
  }
  const notional = (price * quantity) / facts.oneBase;
  const makerFee = (notional * facts.makerFeeBpsTimes1k) / FEE_SCALE;
  const exposure = facts.positionSize + (facts.isBid ? quantity : -quantity);
  const side: ManualSide = facts.isBid ? "buy" : "sell";
  const intentId = [facts.wallet.toLowerCase(), facts.pool.toLowerCase(), side, price.toString(), quantity.toString()].join(":");
  return {
    ok: true,
    quote: {
      intentId,
      wallet: facts.wallet,
      symbol: "BTC",
      pool: facts.pool,
      isBid: facts.isBid,
      side,
      price: price.toString(),
      quantity: quantity.toString(),
      priceDisplay: formatRaw(price, facts.quoteDecimals),
      quantityDisplay: formatRaw(quantity, facts.baseDecimals),
      notionalDisplay: formatRaw(notional, facts.quoteDecimals),
      makerFeeDisplay: formatRaw(makerFee, facts.quoteDecimals),
      takerFeeNote: "Not charged. A post-only order cannot take.",
      positionSize: facts.positionSize.toString(),
      positionDisplay: formatSigned(facts.positionSize, facts.baseDecimals),
      filledExposure: exposure.toString(),
      filledExposureDisplay: formatSigned(exposure, facts.baseDecimals),
      unlockedCollateral: facts.unlockedCollateral.toString(),
      unlockedCollateralDisplay: formatRaw(facts.unlockedCollateral, facts.quoteDecimals),
      equity: facts.equity.toString(),
      equityDisplay: formatRaw(facts.equity, facts.quoteDecimals),
      imReq: facts.imReq.toString(),
      imReqDisplay: formatRaw(facts.imReq, facts.quoteDecimals),
      mmReq: facts.mmReq.toString(),
      mmReqDisplay: formatRaw(facts.mmReq, facts.quoteDecimals),
      marginStatus: facts.marginStatus,
      collateralToken: facts.collateralToken,
      maxQuantity: facts.maxQuantity.toString(),
      maxQuantityDisplay: formatRaw(facts.maxQuantity, facts.baseDecimals),
      limitedBy: facts.limitedBy,
      initialMarginBps: facts.initialMarginBps.toString(),
      maintenanceMarginBps: facts.maintenanceMarginBps.toString(),
      makerFeeRate: facts.makerFeeBpsTimes1k.toString(),
      takerFeeRate: facts.takerFeeBpsTimes1k.toString(),
      bestBidDisplay: facts.bestBid == null ? "none" : formatRaw(facts.bestBid, facts.quoteDecimals),
      bestAskDisplay: facts.bestAsk == null ? "none" : formatRaw(facts.bestAsk, facts.quoteDecimals),
      block: facts.block,
      deploymentId: HIDEKI_V2_ID,
      chainId: HIDEKI_CHAIN_ID,
      netVersion: facts.deployment.netVersion,
      quotedAt: facts.quotedAt,
      orderType: POST_ONLY,
      warnings: WARNINGS,
    },
  };
}

export function quoteFresh(quote: ManualQuote, now: number): boolean {
  return now >= quote.quotedAt && now - quote.quotedAt <= QUOTE_TTL_MS;
}

/** The browser wallet must still be the quoted account on chain 50383. This does not sign. */
export function walletReady(chainId: bigint | null, account: string | null, quoteWallet: string): string | null {
  if (chainId !== BigInt(HIDEKI_CHAIN_ID)) return "The wallet is not on chain 50383. Nothing was signed.";
  if (!account || !/^0x[0-9a-fA-F]{40}$/.test(account)) return "The wallet did not return the quoted account. Nothing was signed.";
  if (account.toLowerCase() !== quoteWallet.toLowerCase()) return "The wallet account does not match the quote. Nothing was signed.";
  return null;
}

export function reduceFlight(state: Flight, event: { type: "start"; intentId: string } | { type: "reject" } | { type: "fail" } | { type: "success"; hash: string } | { type: "unknown"; hash: string } | { type: "acknowledge" }): { state: Flight; error: string | null } {
  if (event.type === "start") {
    if (state.phase === "pending") return { state, error: "A manual order is already waiting for the wallet." };
    if (state.phase === "unknown") return { state, error: "The last transaction outcome is unknown. It will not be sent again." };
    if (state.phase === "done" && state.intentId === event.intentId) {
      return { state, error: "This exact order was already submitted." };
    }
    return { state: { phase: "pending", intentId: event.intentId }, error: null };
  }
  if (state.phase !== "pending" && event.type !== "acknowledge") {
    return { state, error: "There is no manual order in flight." };
  }
  if (event.type === "reject" || event.type === "fail") return { state: { phase: "clear" }, error: null };
  if (event.type === "success") {
    if (state.phase !== "pending") return { state, error: "There is no manual order in flight." };
    if (!event.hash) return { state: { phase: "unknown", intentId: state.intentId, hash: "" }, error: null };
    return { state: { phase: "done", intentId: state.intentId, hash: event.hash }, error: null };
  }
  if (event.type === "unknown") {
    if (state.phase !== "pending") return { state, error: "There is no manual order in flight." };
    return { state: { phase: "unknown", intentId: state.intentId, hash: event.hash }, error: null };
  }
  if (state.phase !== "unknown") return { state, error: "Nothing unknown is waiting to be acknowledged." };
  return { state, error: null };
}

export function classifyReceipt(hash: string | null, status: "success" | "reverted" | null): "rejected" | "failed" | "submitted" | "unknown" {
  if (!hash) return "rejected";
  if (status === "success") return "submitted";
  if (status === "reverted") return "failed";
  return "unknown";
}

export function restingStatus(orderIds: readonly string[] | null, orderId: string | null): "resting" | "not-resting" | "unverified" {
  if (orderIds == null || orderId == null) return "unverified";
  return orderIds.includes(orderId) ? "resting" : "not-resting";
}

export function formatRaw(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(Math.max(0, decimals));
  const whole = abs / scale;
  const fraction = (abs % scale).toString().padStart(Math.max(0, decimals), "0").replace(/0+$/, "");
  const text = fraction ? `${whole}.${fraction}` : whole.toString();
  return negative ? `-${text}` : text;
}

function formatSigned(value: bigint, decimals: number): string {
  if (value === 0n) return "flat";
  const side = value > 0n ? "long" : "short";
  return `${side} ${formatRaw(value < 0n ? -value : value, decimals)}`;
}

function alignDown(value: bigint, tick: bigint): bigint {
  if (value <= 0n) return 0n;
  return (value / tick) * tick;
}

function alignUp(value: bigint, tick: bigint): bigint {
  return ((value + tick - 1n) / tick) * tick;
}

export const MANUAL_LEDGER_KEY = "lg.manual-order.v1";

export type StoredIntent = {
  intentId: string;
  wallet: string;
  pool: string;
  side: ManualSide;
  price: string;
  quantity: string;
  hash: string | null;
  orderId: string | null;
  phase: "pending" | "unknown" | "done" | "reverted";
  acknowledged: boolean;
};

export type ManualLedger = { version: 1; intents: StoredIntent[] };

export type RestingOrder = {
  orderId: string;
  isBid: boolean;
  price: string;
  quantity: string;
};

export type ReconcileView = {
  receipt: "success" | "reverted" | "missing" | "unread";
  orders: RestingOrder[] | null;
};

export type WalletIdentity = {
  chainId: bigint | null;
  account: string | null;
  netVersion: string | null;
  poolCodeBytes: number | null;
};

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export function emptyLedger(): ManualLedger {
  return { version: 1, intents: [] };
}

export function parseLedger(raw: string | null): { ok: true; ledger: ManualLedger } | { ok: false; error: string } {
  if (raw == null || raw.trim() === "") return { ok: true, ledger: emptyLedger() };
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || !Array.isArray((value as { intents?: unknown }).intents)) {
      return { ok: false, error: "Stored manual orders could not be read. Nothing will be signed." };
    }
    const intents: StoredIntent[] = [];
    for (const item of (value as { intents: unknown[] }).intents) {
      const row = storedIntent(item);
      if (!row) return { ok: false, error: "Stored manual orders could not be read. Nothing will be signed." };
      intents.push(row);
    }
    return { ok: true, ledger: { version: 1, intents: trimLedger(intents) } };
  } catch {
    return { ok: false, error: "Stored manual orders could not be read. Nothing will be signed." };
  }
}

export function serializeLedger(ledger: ManualLedger): string {
  return JSON.stringify({ version: 1, intents: ledger.intents });
}

/** A pending or unknown hash blocks every new signature. The same intent also stays blocked after success or acknowledgement. */
export function submissionBlock(ledger: ManualLedger, intentId: string): string | null {
  const hashed = ledger.intents.find((row) => row.hash != null && (row.phase === "pending" || row.phase === "unknown"));
  if (hashed) {
    return hashed.intentId === intentId
      ? "This order's transaction is still unresolved. It will not be sent again."
      : "A manual order hash is still unresolved. No other order will be signed until Hideki v2 shows its receipt.";
  }
  const same = ledger.intents.find((row) => row.intentId === intentId);
  if (!same) return null;
  if (same.phase === "done") return "This exact order was already submitted.";
  if (same.phase === "unknown" || same.phase === "pending") return "This order intent is already stored. It will not be sent again.";
  return null;
}

export function rememberIntent(
  ledger: ManualLedger,
  intent: Pick<StoredIntent, "intentId" | "wallet" | "pool" | "side" | "price" | "quantity">,
): { ok: true; ledger: ManualLedger } | { ok: false; error: string } {
  const error = submissionBlock(ledger, intent.intentId);
  if (error) return { ok: false, error };
  const next: StoredIntent = { ...intent, hash: null, orderId: null, phase: "pending", acknowledged: false };
  const rest = ledger.intents.filter((row) => row.intentId !== intent.intentId);
  return { ok: true, ledger: { version: 1, intents: trimLedger([next, ...rest]) } };
}

export function attachHash(ledger: ManualLedger, intentId: string, hash: string): ManualLedger {
  if (!TX_HASH.test(hash)) return ledger;
  return mapIntent(ledger, intentId, (row) => ({ ...row, hash }));
}

export function markUnknown(ledger: ManualLedger, intentId: string, hash: string | null): ManualLedger {
  return mapIntent(ledger, intentId, (row) => ({
    ...row,
    hash: hash && TX_HASH.test(hash) ? hash : row.hash,
    phase: "unknown",
  }));
}

/** Records that the user has seen an unknown hash. The phase stays unknown. */
export function acknowledgeIntent(ledger: ManualLedger, intentId: string): { ledger: ManualLedger; error: string | null } {
  const row = ledger.intents.find((item) => item.intentId === intentId);
  if (!row || row.phase !== "unknown") return { ledger, error: "Nothing unknown is waiting to be acknowledged." };
  return { ledger: mapIntent(ledger, intentId, (item) => ({ ...item, acknowledged: true, phase: "unknown" })), error: null };
}

/** Drops a pending intent only when no hash was ever stored. A hash is never released here. */
export function releaseUnsent(ledger: ManualLedger, intentId: string): ManualLedger {
  return {
    version: 1,
    intents: ledger.intents.filter((row) => !(row.intentId === intentId && row.phase === "pending" && row.hash == null)),
  };
}

export function applyReconcile(ledger: ManualLedger, intentId: string, view: ReconcileView): ManualLedger {
  return mapIntent(ledger, intentId, (row) => reconcileIntent(row, view));
}

export function reconcileIntent(row: StoredIntent, view: ReconcileView): StoredIntent {
  if (row.phase === "done" || row.phase === "reverted") return row;
  if (view.receipt === "reverted") return { ...row, phase: "reverted" };
  const matched = view.orders ? matchResting(row, view.orders) : null;
  if (view.receipt === "success" || matched) {
    return { ...row, phase: "done", orderId: matched?.orderId ?? row.orderId };
  }
  if (view.receipt === "unread") return row;
  if (row.hash || view.orders) return { ...row, phase: "unknown" };
  return row;
}

export function walletIdentityReady(identity: WalletIdentity, quoteWallet: string): string | null {
  const account = walletReady(identity.chainId, identity.account, quoteWallet);
  if (account) return account;
  if (identity.netVersion == null) {
    return "The wallet cannot prove Hideki v2. Chain 50383 is shared with an older Hideki network, and this provider did not answer net_version. Nothing was signed. Set the wallet RPC for this chain to https://api.hideki2.infra.testnet.somnia.network and try again.";
  }
  if (identity.netVersion.trim() !== HIDEKI_V2_NET_VERSION) {
    return `The wallet RPC reported network ${identity.netVersion.trim()}, not Hideki v2 ${HIDEKI_V2_NET_VERSION}. Nothing was signed.`;
  }
  if (identity.poolCodeBytes == null) {
    return "The wallet could not read the BTC-PERP pool, so its RPC was not proved. Nothing was signed.";
  }
  if (identity.poolCodeBytes === 0) {
    return "The wallet RPC has no code at the BTC-PERP pool. Nothing was signed.";
  }
  return null;
}

export function walletRejected(code: unknown, message: string): boolean {
  return code === 4001 || code === "ACTION_REJECTED" || /user rejected|user denied|rejected the request/i.test(message);
}

function matchResting(row: StoredIntent, orders: readonly RestingOrder[]): RestingOrder | null {
  const bid = row.side === "buy";
  return orders.find((order) => order.isBid === bid && order.price === row.price && order.quantity === row.quantity) ?? null;
}

function mapIntent(ledger: ManualLedger, intentId: string, update: (row: StoredIntent) => StoredIntent): ManualLedger {
  return { version: 1, intents: ledger.intents.map((row) => (row.intentId === intentId ? update(row) : row)) };
}

function trimLedger(intents: StoredIntent[]): StoredIntent[] {
  const locked = intents.filter((row) => row.phase !== "reverted");
  const reverted = intents.filter((row) => row.phase === "reverted");
  return [...locked, ...reverted].slice(0, 32);
}

function storedIntent(value: unknown): StoredIntent | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<StoredIntent>;
  if (typeof row.intentId !== "string" || row.intentId.length < 8 || row.intentId.length > 300) return null;
  if (typeof row.wallet !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(row.wallet)) return null;
  if (typeof row.pool !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(row.pool)) return null;
  if (row.side !== "buy" && row.side !== "sell") return null;
  if (typeof row.price !== "string" || !/^\d+$/.test(row.price)) return null;
  if (typeof row.quantity !== "string" || !/^\d+$/.test(row.quantity)) return null;
  if (row.phase !== "pending" && row.phase !== "unknown" && row.phase !== "done" && row.phase !== "reverted") return null;
  let hash: string | null = null;
  let phase = row.phase;
  if (typeof row.hash === "string" && TX_HASH.test(row.hash)) hash = row.hash;
  else if (row.hash != null) phase = phase === "done" || phase === "reverted" ? phase : "unknown";
  const orderId = typeof row.orderId === "string" && /^\d+$/.test(row.orderId) ? row.orderId : null;
  return {
    intentId: row.intentId,
    wallet: row.wallet,
    pool: row.pool,
    side: row.side,
    price: row.price,
    quantity: row.quantity,
    hash,
    orderId,
    phase,
    acknowledged: row.acknowledged === true,
  };
}
