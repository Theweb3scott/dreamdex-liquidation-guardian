import { createPublicClient, getAddress, http, isAddress, parseAbi } from "viem";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { openHideki, type ProtocolRead } from "./hideki-read.ts";
import { HIDEKI_V2_ID } from "./review.ts";
import { proveDeployment } from "./review-read.ts";
import { buildShield, type ShieldInput, type ShieldModel, type ShieldStop } from "./shield.ts";
import { type IntelBook } from "./intelligence.ts";
import { PLACE_ORDER_FOR_SELECTOR, previewProtectiveStop } from "./stop-preview.ts";

const abi = parseAbi([
  "function getStopOrderRegistry(address perpPool) view returns (address)",
  "function getOperatorPermissionsRegistry() view returns (address)",
  "function somiPaymentPerOrder() view returns (uint256)",
  "function isOperatorAuthorized(address owner, address operator, bytes4 selector) view returns (bool)",
  "function isGloballyApproved(address owner, address operator, bytes4 selector) view returns (bool)",
  "function isApprovedForPool(address pool, address owner, address operator, bytes4 selector) view returns (bool)",
  "function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))",
  "function getReducingCapacity(address account) view returns ((int128 positionSize, uint256 pendingBidQuantity, uint256 pendingAskQuantity, uint256 pendingOppositeQuantity, uint256 effectiveReducingCapacity) capacity)",
]);

const ZERO = "0x0000000000000000000000000000000000000000";

export type ShieldResult =
  | { ok: true; signerConnected: false; model: ShieldModel; intel: IntelBook }
  | { ok: false; error: string };

/** Read-only Shield snapshot. Does not grant, create, cancel, or sign. */
export async function readGuardianShield(rawAccount: string): Promise<ShieldResult> {
  if (!isAddress(rawAccount.trim())) return { ok: false, error: "Enter a public 20-byte address." };
  const account = getAddress(rawAccount.trim());
  const markets = openHideki();
  const rpcUrl = hidekiTestnet.rpcUrls.default.http[0];
  if (!rpcUrl) return { ok: false, error: "The SDK has no Hideki HTTP RPC." };
  const client = createPublicClient({ chain: hidekiTestnet, transport: http(rpcUrl) });
  try {
    if (markets.walletAddress) return { ok: false, error: "A signer is present on this process. Refusing to read." };
    const identity = await proveDeployment(client, rpcUrl);
    if (!identity.ok) return identity;
    const { readHidekiProtocol } = await import("./hideki-read.ts");
    const protocol = await readHidekiProtocol(account);
    if (!protocol.ok) return { ok: false, error: protocol.error };
    if (!protocol.account) return { ok: false, error: "The protocol returned no account." };
    const positions = await Promise.all(
      protocol.account.positions
        .filter((position) => position.position.size !== "0")
        .map((position) => enrich(markets, client, identity.factory, account, protocol, position)),
    );
    const refreshedAt = new Date().toISOString();
    const input: ShieldInput = {
      address: account,
      chainId: protocol.chainId,
      deploymentId: HIDEKI_V2_ID,
      refreshedAt,
      account: {
        equity: protocol.account.margin.equity,
        mmReq: protocol.account.margin.mmReq,
        healthAgrees: protocol.account.accountHealth.agreesWithMarginAccount,
        marginBlock: protocol.account.margin.asOfBlock,
        positions: protocol.account.positions.map((position) => ({
          symbol: position.symbol,
          size: position.position.size,
          baseDecimals: position.baseDecimals,
          priceable: position.priceable,
          poolPriceable: position.poolPriceable,
          asOfBlock: position.asOfBlock,
          entry: position.avgEntryPrice ?? position.position.avgEntryPrice,
          mark: position.markPrice ?? null,
          liquidationPrice: position.liquidationPrice,
        })),
      },
      positions,
    };
    const model = buildShield(input);
    return { ok: true, signerConnected: false, model, intel: toIntel(protocol, model.band, model.bandReason, refreshedAt, positions) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message.slice(0, 500) };
  } finally {
    await Promise.race([Promise.resolve(markets.close?.()), new Promise((resolve) => setTimeout(resolve, 3_000))]).catch(() => undefined);
  }
}

function toIntel(
  protocol: ProtocolRead,
  band: ShieldModel["band"],
  bandReason: string,
  refreshedAt: string,
  cards: ShieldInput["positions"],
): IntelBook {
  const account = protocol.account;
  if (!account) throw new Error("Account missing.");
  const open = account.positions.filter((position) => position.position.size !== "0");
  return {
    address: account.address,
    chainId: protocol.chainId,
    deploymentId: HIDEKI_V2_ID,
    refreshedAt,
    equity: account.margin.equity,
    mmReq: account.margin.mmReq,
    healthAgrees: account.accountHealth.agreesWithMarginAccount,
    blocksConsistent: open.every((position) => position.asOfBlock === account.margin.asOfBlock),
    band,
    bandReason,
    positions: open.map((position) => {
      const card = cards.find((item) => item.pool.toLowerCase() === position.pool.toLowerCase());
      return {
        symbol: position.symbol,
        pool: getAddress(position.pool),
        baseDecimals: position.baseDecimals,
        priceable: position.priceable && position.poolPriceable,
        size: position.position.size,
        entry: position.position.avgEntryPrice,
        entryFundingIndex: position.position.entryFundingIndex,
        mark: position.priceable ? (position.markPrice ?? null) : null,
        oneBase: position.oneBase,
        maintenanceMarginBps: position.maintenanceMarginBps,
        projectedFunding: position.projectedFunding,
        takerFeeBpsTimes1k: position.takerFeeBpsTimes1k,
        lotSize: card?.lotSize ?? null,
        minQuantity: card?.minQuantity ?? null,
        observedNotional: position.notional ?? null,
        observedPnl: position.unrealizedPnl ?? null,
        observedMaintenance: position.maintenanceMarginRequirement ?? null,
        observedFunding: position.accruedFunding ?? null,
      };
    }),
  };
}

async function enrich(
  markets: ReturnType<typeof openHideki>,
  client: ReturnType<typeof createPublicClient>,
  factory: `0x${string}`,
  account: `0x${string}`,
  protocol: ProtocolRead,
  position: NonNullable<ProtocolRead["account"]>["positions"][number],
): Promise<ShieldInput["positions"][number]> {
  const pool = getAddress(position.pool);
  let registry: `0x${string}` | null = null;
  let operatorRegistry: `0x${string}` | null = null;
  let book = { tickSize: 0n, minQuantity: 0n, lotSize: 0n };
  let capacity = 0n;
  try {
    const [registryRaw, operatorRaw, bookRaw, capacityRaw] = await Promise.all([
      client.readContract({ address: factory, abi, functionName: "getStopOrderRegistry", args: [pool] }),
      client.readContract({ address: pool, abi, functionName: "getOperatorPermissionsRegistry" }),
      client.readContract({ address: pool, abi, functionName: "getOrderBookParameters" }),
      client.readContract({ address: pool, abi, functionName: "getReducingCapacity", args: [account] }),
    ]);
    registry = registryRaw.toLowerCase() === ZERO ? null : getAddress(registryRaw);
    operatorRegistry = operatorRaw.toLowerCase() === ZERO ? null : getAddress(operatorRaw);
    book = bookRaw;
    capacity = capacityRaw.effectiveReducingCapacity;
  } catch {
    registry = null;
  }
  let somi: bigint | null = null;
  let resolved: boolean | null = null;
  let globalApproved: boolean | null = null;
  let poolApproved: boolean | null = null;
  let permissionReadable = false;
  if (registry && operatorRegistry) {
    try {
      [somi, resolved, globalApproved, poolApproved] = await Promise.all([
        client.readContract({ address: registry, abi, functionName: "somiPaymentPerOrder" }),
        client.readContract({ address: pool, abi, functionName: "isOperatorAuthorized", args: [account, registry, PLACE_ORDER_FOR_SELECTOR] }),
        client.readContract({ address: operatorRegistry, abi, functionName: "isGloballyApproved", args: [account, registry, PLACE_ORDER_FOR_SELECTOR] }),
        client.readContract({ address: operatorRegistry, abi, functionName: "isApprovedForPool", args: [pool, account, registry, PLACE_ORDER_FOR_SELECTOR] }),
      ]);
      permissionReadable = true;
    } catch {
      permissionReadable = false;
    }
  }
  const stops = await readStops(markets, account, pool, registry);
  const size = BigInt(position.position.size);
  const mark = position.priceable && position.markPrice ? BigInt(position.markPrice) : 0n;
  const liquidation = "price" in position.liquidationPrice && position.liquidationPrice.price && position.liquidationPrice.price !== "0"
    ? BigInt(position.liquidationPrice.price)
    : null;
  const plan = previewProtectiveStop({
    deploymentId: HIDEKI_V2_ID,
    wallet: account,
    market: position.symbol,
    pool,
    registry,
    operatorRegistry,
    positionSize: size,
    mark,
    liquidation,
    tickSize: book.tickSize,
    lotSize: book.lotSize,
    minQuantity: book.minQuantity,
    reducingCapacity: capacity,
    requestedQuantity: null,
    somiPayment: somi,
    resolvedAuthorized: resolved,
    globalApproved,
    poolApproved,
    existingStops: stops.stops
      .filter((stop) => stop.live === true && stop.isBid != null && stop.triggerOperator != null && stop.quantity && stop.triggerPrice)
      .map((stop) => ({
        orderId: stop.orderId,
        live: true,
        intent: stop.intent,
        isBid: stop.isBid as boolean,
        triggerOperator: stop.triggerOperator as number,
        quantity: stop.quantity as string,
        triggerPrice: stop.triggerPrice as string,
      })),
    stopsReadable: stops.readable,
    priceable: position.priceable && position.poolPriceable,
    healthAgrees: protocol.account?.accountHealth.agreesWithMarginAccount === true,
    quotedAt: Date.now(),
    now: Date.now(),
  });
  return {
    symbol: position.symbol,
    pool,
    baseDecimals: position.baseDecimals,
    priceable: position.priceable,
    poolPriceable: position.poolPriceable,
    size: position.position.size,
    entry: position.avgEntryPrice ?? position.position.avgEntryPrice,
    mark: position.markPrice ?? null,
    pnl: position.unrealizedPnl ?? null,
    asOfBlock: position.asOfBlock,
    liquidationPrice: position.liquidationPrice,
    lotSize: book.lotSize > 0n ? book.lotSize.toString() : null,
    minQuantity: book.minQuantity > 0n ? book.minQuantity.toString() : null,
    stopsReadable: stops.readable,
    stops: stops.stops,
    permission: {
      readable: permissionReadable,
      registry,
      operatorRegistry,
      resolvedAuthorized: resolved,
      globalApproved,
      poolApproved,
      somiPayment: somi?.toString() ?? null,
    },
    plan: {
      ok: plan.ok,
      reason: plan.reason,
      quantity: plan.quantity,
      triggerPrice: plan.triggerPrice,
      somiWei: plan.somiWei,
    },
  };
}

async function readStops(
  markets: ReturnType<typeof openHideki>,
  account: `0x${string}`,
  pool: `0x${string}`,
  registry: `0x${string}` | null,
): Promise<{ readable: boolean; stops: ShieldStop[] }> {
  if (!registry) return { readable: false, stops: [] };
  try {
    const rows = await markets.client.listPerpStopOrders({ account, pool, status: ["PENDING"] });
    const stops: ShieldStop[] = [];
    for (const row of rows) {
      let chain: Awaited<ReturnType<typeof markets.client.getPerpStopOrder>> | null = null;
      try {
        chain = await markets.client.getPerpStopOrder({ registry: getAddress(row.registry), orderId: row.orderIdRaw });
      } catch {
        stops.push({
          orderId: row.orderIdRaw,
          live: null,
          intent: null,
          isBid: null,
          triggerOperator: null,
          quantity: row.quantity,
          triggerPrice: row.triggerPrice,
          somiPaid: null,
        });
        continue;
      }
      if (!chain) {
        stops.push({
          orderId: row.orderIdRaw,
          live: false,
          intent: row.intent === "reduceOnly" || row.intent === "opening" ? row.intent : null,
          isBid: row.isBid,
          triggerOperator: row.triggerOperator,
          quantity: row.quantity,
          triggerPrice: row.triggerPrice,
          somiPaid: null,
        });
        continue;
      }
      stops.push({
        orderId: row.orderIdRaw,
        live: true,
        intent: chain.intent === "reduceOnly" || chain.intent === "opening" ? chain.intent : null,
        isBid: chain.isBid,
        triggerOperator: chain.triggerOperator,
        quantity: chain.quantity.toString(),
        triggerPrice: chain.triggerPrice.toString(),
        somiPaid: chain.somiPaid.toString(),
      });
    }
    return { readable: true, stops };
  } catch {
    return { readable: false, stops: [] };
  }
}
