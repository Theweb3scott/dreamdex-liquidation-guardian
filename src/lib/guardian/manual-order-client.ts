/** The only module allowed to ask a browser wallet to sign a perp order. */

import { createPublicClient, createWalletClient, custom, getAddress, http, isAddress, type Address, type Hash } from "viem";
import { ORDER_TYPE, SOMNIA_HIDEKI_TESTNET_ADDRESSES, SomniaMarkets } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { openHideki } from "./hideki-read.ts";
import { HIDEKI_V2_ID } from "./review.ts";
import { proveDeployment } from "./review-read.ts";
import {
  MANUAL_LEDGER_KEY,
  MANUAL_MARKET,
  POST_ONLY,
  acknowledgeIntent,
  applyReconcile,
  assessManualOrder,
  attachHash,
  markUnknown,
  parseLedger,
  postOnlyPrice,
  quoteFresh,
  releaseUnsent,
  rememberIntent,
  restingStatus,
  serializeLedger,
  submissionBlock,
  walletIdentityReady,
  walletRejected,
  type ManualLedger,
  type ManualQuote,
  type ManualSide,
  type ReconcileView,
  type RestingOrder,
  type StoredIntent,
  type WalletIdentity,
} from "./manual-order.ts";

const INDEXER_URL = "https://hideki-dev.smk.somnia.host/v1/graphql";

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

export type ManualRead = { ok: true; quote: ManualQuote } | { ok: false; error: string };

export type ManualSubmit = {
  receiptStatus: "success" | "reverted" | "unknown" | "none";
  resting: "resting" | "not-resting" | "unverified";
  hash: string | null;
  orderId: string | null;
  outcome: "rejected" | "failed" | "submitted" | "unknown";
  detail: string;
};

const STORAGE_BROKEN = Symbol("storage-broken");

export function loadManualLedger(): { ok: true; ledger: ManualLedger } | { ok: false; error: string } {
  const raw = readStoredRaw();
  if (raw === STORAGE_BROKEN) return { ok: false, error: "This browser cannot store a pending order. Nothing will be signed." };
  return parseLedger(raw);
}

export function acknowledgeUnknownManual(intentId: string): string | null {
  const loaded = loadManualLedger();
  if (!loaded.ok) return loaded.error;
  const next = acknowledgeIntent(loaded.ledger, intentId);
  if (next.error) return next.error;
  if (!commit(next.ledger)) return "The acknowledgement could not be stored. The order stays locked.";
  return null;
}

export async function prepareManualQuote(rawAccount: string, side: ManualSide): Promise<ManualRead> {
  if (!isAddress(rawAccount)) return { ok: false, error: "The wallet address is not a 20-byte account." };
  const account = getAddress(rawAccount);
  const markets = openHideki();
  try {
    const rpcUrl = hidekiTestnet.rpcUrls.default.http[0];
    const client = createPublicClient({ chain: hidekiTestnet, transport: http(rpcUrl) });
    const identity = await proveDeployment(client, rpcUrl);
    if (!identity.ok) return { ok: false, error: identity.error };
    const listed = await markets.client.listPerpMarkets();
    const market = listed.find((row) => row.baseSymbol === MANUAL_MARKET);
    if (!market) return { ok: false, error: "BTC-PERP is not listed on this Hideki deployment." };
    const pool = getAddress(market.poolAddress);
    const bank = getAddress(market.marginBank);
    const system = await markets.client.getPerpSystemConfig(bank);
    if (getAddress(system.marginBank) !== bank) return { ok: false, error: "The BTC pool bank does not match the live system config." };
    const snapshot = await markets.client.getPerpHealthSnapshot(pool);
    if (!snapshot.priceable) return { ok: false, error: "BTC-PERP is not priceable. Nothing will be signed." };
    const limit = postOnlyPrice(snapshot.markPrice, BigInt(market.tickSize), side === "buy");
    if (limit == null) return { ok: false, error: "No post-only price can sit off the mark on this tick grid." };
    const [risk, margin, position, sized, owns, poolBank, poolCode, tops] = await Promise.all([
      markets.client.getPerpRiskParams(pool),
      markets.client.getMarginAccount(bank, account),
      markets.client.getPerpPosition({ marginBank: bank, account, pool }),
      markets.client.getMaxPerpOrderSize({ pool, marginBank: bank, account, isBid: side === "buy", price: limit }),
      client.readContract({ address: identity.factory, abi: factoryAbi, functionName: "isDeployedByFactory", args: [pool] }),
      client.readContract({ address: pool, abi: bankAbi, functionName: "marginBank" }),
      client.getCode({ address: pool }),
      markets.client.getBookTopsOnchain([{ id: pool.toLowerCase(), poolAddress: pool }]),
    ]);
    if (!sized.priceable) return { ok: false, error: "The account size check has no mark. Nothing will be signed." };
    const top = tops.tops[pool.toLowerCase()];
    const bestBid = parseLevel(top?.bestBid);
    const bestAsk = parseLevel(top?.bestAsk);
    if (!bestBid.ok || !bestAsk.ok) return { ok: false, error: "The order book price could not be read. Nothing will be signed." };
    const built = assessManualOrder({
      wallet: account,
      symbol: MANUAL_MARKET,
      pool,
      isBid: side === "buy",
      markPrice: snapshot.markPrice,
      tickSize: BigInt(market.tickSize),
      lotSize: sized.lotSize > 0n ? sized.lotSize : BigInt(market.lotSize),
      minQuantity: sized.minQuantity > 0n ? sized.minQuantity : BigInt(market.minQuantity),
      oneBase: snapshot.oneBase,
      baseDecimals: market.baseDecimals,
      quoteDecimals: market.quoteDecimals,
      makerFeeBpsTimes1k: risk.makerFeeBpsTimes1k,
      takerFeeBpsTimes1k: risk.takerFeeBpsTimes1k,
      initialMarginBps: risk.initialMarginBps,
      maintenanceMarginBps: risk.maintenanceMarginBps,
      maxQuantity: sized.maxQuantity,
      placeable: sized.placeable,
      limitedBy: sized.limitedBy,
      priceable: true,
      positionSize: position.size,
      unlockedCollateral: margin.unlockedCollateralBalance,
      equity: margin.equity,
      imReq: margin.imReq,
      mmReq: margin.mmReq,
      marginStatus: margin.marginStatus,
      collateralToken: getAddress(system.collateralToken),
      block: margin.asOfBlock.toString(),
      quotedAt: Date.now(),
      bookKnown: true,
      bestBid: bestBid.price,
      bestAsk: bestAsk.price,
      deployment: {
        ...identity.observation,
        poolCodeBytes: codeBytes(poolCode),
        factoryOwnsPool: owns,
        poolMarginBank: getAddress(poolBank),
      },
    });
    if (!built.ok) return built;
    if (built.quote.deploymentId !== HIDEKI_V2_ID || built.quote.orderType !== POST_ONLY) {
      return { ok: false, error: "The quote is not a Hideki v2 post-only order." };
    }
    return built;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message.slice(0, 500) };
  } finally {
    await closeMarkets(markets);
  }
}

export async function submitManualPostOnly(provider: Eip1193, previous: ManualQuote, confirmed: true): Promise<ManualSubmit> {
  if (confirmed !== true) return rejected("Confirmation was not explicit.");
  if (previous.orderType !== POST_ONLY || previous.symbol !== MANUAL_MARKET) {
    return rejected("Only a minimum BTC-PERP post-only order can be signed.");
  }
  if (!quoteFresh(previous, Date.now())) return rejected("The quote expired. Read it again before signing.");
  const existing = storedOrNull();
  if (!existing) return rejected("This browser cannot store a pending order. Nothing was signed.");
  const blocked = submissionBlock(existing, previous.intentId);
  if (blocked) return rejected(blocked);
  let hash: Hash | null = null;
  let markets: SomniaMarkets | null = null;
  let persisted = false;
  try {
    const fresh = await prepareManualQuote(previous.wallet, previous.side);
    if (!fresh.ok || fresh.quote.intentId !== previous.intentId) {
      return rejected(fresh.ok ? "The live price or book changed. Nothing was signed." : fresh.error);
    }
    const identity = await readWalletIdentity(provider, previous.wallet, previous.pool);
    const identityError = walletIdentityReady(identity, previous.wallet);
    if (identityError) return rejected(identityError);
    const latest = storedOrNull();
    if (!latest) return rejected("This browser cannot store a pending order. Nothing was signed.");
    const blockedNow = submissionBlock(latest, previous.intentId);
    if (blockedNow) return rejected(blockedNow);
    const remembered = rememberIntent(latest, {
      intentId: previous.intentId,
      wallet: previous.wallet,
      pool: previous.pool,
      side: previous.side,
      price: previous.price,
      quantity: previous.quantity,
    });
    if (!remembered.ok) return rejected(remembered.error);
    if (!commit(remembered.ledger)) return rejected("This browser cannot store a pending order. Nothing was signed.");
    persisted = true;
    markets = openManualMarkets();
    const wallet = createWalletClient({
      account: previous.wallet as Address,
      chain: hidekiTestnet,
      transport: custom(provider),
    });
    const trader = markets.client.createTrader({ walletClient: wallet });
    const placed = await trader.placePerpOrder({
      pool: previous.pool as Address,
      isBid: previous.isBid,
      price: BigInt(previous.price),
      quantity: BigInt(previous.quantity),
      orderType: ORDER_TYPE.POST_ONLY,
    });
    hash = placed.hash;
    const withHash = storedOrNull() ?? remembered.ledger;
    commit(attachHash(withHash, previous.intentId, hash));
    return await finish(markets, previous, hash, placed.orderId?.toString() ?? null);
  } catch (error) {
    const recovered = hash ?? hashFrom(error);
    const latest = storedOrNull();
    if (recovered) {
      if (latest) commit(attachHash(latest, previous.intentId, recovered));
      if (markets) {
        try {
          return await finish(markets, previous, recovered, null);
        } catch {
          const again = storedOrNull();
          if (again) commit(markUnknown(again, previous.intentId, recovered));
        }
      } else if (latest) {
        commit(markUnknown(attachHash(latest, previous.intentId, recovered), previous.intentId, recovered));
      }
      return unknownResult(recovered, "The wallet may have broadcast the transaction, but Hideki v2 did not confirm it. It will not be sent again.");
    }
    if (persisted && latest && walletRejected(codeOf(error), error instanceof Error ? error.message : "")) {
      commit(releaseUnsent(latest, previous.intentId));
      return rejected(error instanceof Error ? error.message : "The wallet rejected the signature.");
    }
    if (persisted && latest) {
      commit(markUnknown(latest, previous.intentId, null));
      return unknownResult(null, "The wallet did not return a transaction hash. This intent stays locked and will not be sent again.");
    }
    return rejected(error instanceof Error ? error.message : "The wallet did not sign.");
  } finally {
    if (markets) await closeMarkets(markets);
  }
}

export async function reconcileStoredManual(): Promise<{ ok: true; ledger: ManualLedger; note: string | null } | { ok: false; error: string }> {
  const loaded = loadManualLedger();
  if (!loaded.ok) return loaded;
  const open = loaded.ledger.intents.filter((row) => row.phase === "pending" || row.phase === "unknown");
  if (open.length === 0) return { ok: true, ledger: loaded.ledger, note: null };
  const markets = openHideki();
  try {
    const rpcUrl = hidekiTestnet.rpcUrls.default.http[0];
    const client = createPublicClient({ chain: hidekiTestnet, transport: http(rpcUrl) });
    const identity = await proveDeployment(client, rpcUrl);
    if (!identity.ok) return { ok: true, ledger: loaded.ledger, note: "Hideki v2 could not be verified. Stored orders stay locked." };
    let ledger = loaded.ledger;
    for (const row of open) {
      const view = await observeIntent(markets, client, row);
      ledger = applyReconcile(ledger, row.intentId, view);
    }
    if (!commit(ledger)) return { ok: false, error: "The reconciled orders could not be stored. They stay locked." };
    return { ok: true, ledger, note: null };
  } catch {
    return { ok: true, ledger: loaded.ledger, note: "Hideki v2 could not be read. Stored orders stay locked." };
  } finally {
    await closeMarkets(markets);
  }
}

async function finish(markets: SomniaMarkets, quote: ManualQuote, hash: Hash, orderId: string | null): Promise<ManualSubmit> {
  const status = await readReceipt(hash);
  const orders = await readResting(markets, quote.pool, quote.wallet);
  const receipt = status == null ? "missing" : status;
  const loaded = storedOrNull();
  if (!loaded) {
    return {
      receiptStatus: status == null ? "unknown" : status === "success" ? "success" : "reverted",
      resting: restingStatus(orders ? orders.map((order) => order.orderId) : null, orderId),
      hash,
      orderId,
      outcome: status == null ? "unknown" : status === "success" ? "submitted" : "failed",
      detail: "The transaction hash could not be stored after broadcast. Do not send it again.",
    };
  }
  const stamped = attachHash(loaded, quote.intentId, hash);
  const named = orderId
    ? {
        version: 1 as const,
        intents: stamped.intents.map((row) => (row.intentId === quote.intentId && row.orderId == null ? { ...row, orderId } : row)),
      }
    : stamped;
  const next = applyReconcile(named, quote.intentId, { receipt, orders });
  commit(next);
  const row = next.intents.find((item) => item.intentId === quote.intentId);
  return submissionFrom(row, receipt, orders, hash, orderId);
}

function rejected(detail: string): ManualSubmit {
  return { receiptStatus: "none", resting: "unverified", hash: null, orderId: null, outcome: "rejected", detail: detail.slice(0, 500) };
}

function unknownResult(hash: string | null, detail: string): ManualSubmit {
  return { receiptStatus: "unknown", resting: "unverified", hash, orderId: null, outcome: "unknown", detail };
}

function submissionFrom(
  row: StoredIntent | undefined,
  receipt: "success" | "reverted" | "missing",
  orders: RestingOrder[] | null,
  hash: string,
  orderId: string | null,
): ManualSubmit {
  const resting = restingStatus(orders ? orders.map((order) => order.orderId) : null, row?.orderId ?? orderId);
  if (row?.phase === "reverted" || receipt === "reverted") {
    return { receiptStatus: "reverted", resting: "unverified", hash, orderId, outcome: "failed", detail: "The transaction reverted on Hideki v2." };
  }
  if (row?.phase === "done") {
    return {
      receiptStatus: receipt === "success" ? "success" : "unknown",
      resting,
      hash,
      orderId: row.orderId ?? orderId,
      outcome: "submitted",
      detail:
        receipt === "success"
          ? "The Hideki v2 receipt succeeded. Resting status is separate from the receipt. This intent stays locked."
          : "A matching order is resting on Hideki v2. The receipt was not found. This intent stays locked.",
    };
  }
  return {
    receiptStatus: "unknown",
    resting: "unverified",
    hash,
    orderId,
    outcome: "unknown",
    detail: "No Hideki v2 receipt was found. This intent stays locked and will not be sent again.",
  };
}

function readStoredRaw(): string | null | typeof STORAGE_BROKEN {
  try {
    if (typeof localStorage === "undefined") return STORAGE_BROKEN;
    return localStorage.getItem(MANUAL_LEDGER_KEY);
  } catch {
    return STORAGE_BROKEN;
  }
}

function commit(ledger: ManualLedger): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    const raw = serializeLedger(ledger);
    localStorage.setItem(MANUAL_LEDGER_KEY, raw);
    return localStorage.getItem(MANUAL_LEDGER_KEY) === raw;
  } catch {
    return false;
  }
}

function storedOrNull(): ManualLedger | null {
  const raw = readStoredRaw();
  if (raw === STORAGE_BROKEN) return null;
  const parsed = parseLedger(raw);
  return parsed.ok ? parsed.ledger : null;
}

async function observeIntent(
  markets: SomniaMarkets,
  client: ReturnType<typeof createPublicClient>,
  row: StoredIntent,
): Promise<ReconcileView> {
  let receipt: ReconcileView["receipt"] = "missing";
  if (row.hash) {
    const found = await client.getTransactionReceipt({ hash: row.hash as Hash }).catch(() => null);
    receipt = found == null ? "missing" : found.status === "success" ? "success" : "reverted";
  }
  return { receipt, orders: await readResting(markets, row.pool, row.wallet) };
}

async function readResting(markets: SomniaMarkets, pool: string, wallet: string): Promise<RestingOrder[] | null> {
  try {
    const open = await markets.client.getOpenOrdersOnchain([getAddress(pool)], getAddress(wallet));
    return open.orders.map((order) => ({
      orderId: order.orderId.toString(),
      isBid: order.isBid,
      price: order.price.toString(),
      quantity: order.fullQuantity.toString(),
    }));
  } catch {
    return null;
  }
}

function parseLevel(value: string | null | undefined): { ok: true; price: bigint | null } | { ok: false } {
  if (value == null) return { ok: true, price: null };
  if (!/^\d+$/.test(value)) return { ok: false };
  try {
    const price = BigInt(value);
    return { ok: true, price: price > 0n ? price : null };
  } catch {
    return { ok: false };
  }
}

function codeOf(error: unknown): unknown {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return error.code;
}

const RECEIPT_WAIT_MS = 8_000;

async function readWalletIdentity(provider: Eip1193, quoteWallet: string, pool: string): Promise<WalletIdentity> {
  const chainId = await provider.request({ method: "eth_chainId" });
  const accounts = await provider.request({ method: "eth_accounts" });
  const account = Array.isArray(accounts) ? accounts.find((item): item is string => typeof item === "string") : null;
  let chain: bigint | null = null;
  if (typeof chainId === "string" || typeof chainId === "number") {
    try {
      chain = BigInt(chainId);
    } catch {
      chain = null;
    }
  }
  let netVersion: string | null = null;
  try {
    const net = await provider.request({ method: "net_version" });
    if (typeof net === "string" || typeof net === "number") netVersion = String(net).trim();
  } catch {
    netVersion = null;
  }
  let poolCodeBytes: number | null = null;
  try {
    const code = await provider.request({ method: "eth_getCode", params: [getAddress(pool), "latest"] });
    poolCodeBytes = typeof code === "string" ? codeBytes(code) : null;
  } catch {
    poolCodeBytes = null;
  }
  return { chainId: chain, account: account ?? null, netVersion, poolCodeBytes };
}

async function readReceipt(hash: Hash): Promise<"success" | "reverted" | null> {
  const client = createPublicClient({ chain: hidekiTestnet, transport: http(hidekiTestnet.rpcUrls.default.http[0]) });
  const deadline = Date.now() + RECEIPT_WAIT_MS;
  do {
    const receipt = await client.getTransactionReceipt({ hash }).catch(() => null);
    if (receipt) return receipt.status === "success" ? "success" : "reverted";
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 400));
  } while (Date.now() <= deadline);
  return null;
}

function openManualMarkets(): SomniaMarkets {
  return new SomniaMarkets({
    chain: hidekiTestnet,
    indexerUrl: INDEXER_URL,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
    wsRpcUrl: hidekiTestnet.rpcUrls.default.webSocket[0],
  });
}

async function closeMarkets(markets: SomniaMarkets): Promise<void> {
  await Promise.race([
    Promise.resolve(markets.close?.()),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]).catch(() => undefined);
}

function codeBytes(code: string | undefined): number {
  if (!code || code === "0x") return 0;
  return (code.length - 2) / 2;
}

function hashFrom(error: unknown): Hash | null {
  if (!error || typeof error !== "object" || !("hash" in error)) return null;
  const value = error.hash;
  return typeof value === "string" && value.startsWith("0x") ? (value as Hash) : null;
}

const factoryAbi = [
  {
    type: "function",
    name: "isDeployedByFactory",
    stateMutability: "view",
    inputs: [{ name: "pool", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const bankAbi = [
  {
    type: "function",
    name: "marginBank",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;
