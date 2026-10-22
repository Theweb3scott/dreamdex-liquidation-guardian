import { createPublicClient, getAddress, http, isAddress, parseAbi } from "viem";
import { SOMNIA_HIDEKI_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { openHideki } from "./hideki-read.ts";
import { PLACE_ORDER_FOR_SELECTOR, previewProtectiveStop, type KnownStop, type StopPreview } from "./stop-preview.ts";

const abi = parseAbi([
  "function getStopOrderRegistry(address perpPool) view returns (address)",
  "function getOperatorPermissionsRegistry() view returns (address)",
  "function somiPaymentPerOrder() view returns (uint256)",
  "function isOperatorAuthorized(address owner, address operator, bytes4 selector) view returns (bool)",
  "function isGloballyApproved(address owner, address operator, bytes4 selector) view returns (bool)",
  "function isApprovedForPool(address pool, address owner, address operator, bytes4 selector) view returns (bool)",
  "function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))",
]);

const ZERO = "0x0000000000000000000000000000000000000000";

export type StopPreviewResult =
  | { ok: true; signerConnected: false; preview: StopPreview }
  | { ok: false; error: string };

/** Read-only stop plan. Does not grant, create, cancel, or revoke. */
export async function readStopPreview(rawAccount: string, requestedRaw: string | null): Promise<StopPreviewResult> {
  if (!isAddress(rawAccount.trim())) return { ok: false, error: "The connected address is not a 20-byte account." };
  const account = getAddress(rawAccount.trim());
  let requested: bigint | null = null;
  if (requestedRaw && requestedRaw.trim() !== "") {
    if (!/^\d+$/.test(requestedRaw.trim())) return { ok: false, error: "Requested quantity must be a raw integer." };
    requested = BigInt(requestedRaw.trim());
  }
  const markets = openHideki();
  const client = createPublicClient({ chain: hidekiTestnet, transport: http(hidekiTestnet.rpcUrls.default.http[0]) });
  try {
    if (markets.walletAddress) return { ok: false, error: "A signer is present on this process. Refusing to plan a stop." };
    const { readWalletReview } = await import("./review-read.ts");
    const review = await readWalletReview(account, requestedRaw);
    if (!review.ok) return review;
    const quote = review.quotes[0];
    if (!quote) return { ok: false, error: review.notes.at(-1) ?? "No position can be protected." };
    const marginBank = SOMNIA_HIDEKI_TESTNET_ADDRESSES.marginBank;
    const factoryAddress = SOMNIA_HIDEKI_TESTNET_ADDRESSES.perpPoolFactory;
    if (!marginBank || !factoryAddress) return { ok: false, error: "SDK address book has no Hideki margin bank or factory." };
    const factory = getAddress(factoryAddress);
    const pool = getAddress(quote.pool);
    const now = Date.now();
    const [registryRaw, operatorRaw, book, liquidation] = await Promise.all([
      client.readContract({ address: factory, abi, functionName: "getStopOrderRegistry", args: [pool] }),
      client.readContract({ address: pool, abi, functionName: "getOperatorPermissionsRegistry" }),
      client.readContract({ address: pool, abi, functionName: "getOrderBookParameters" }),
      markets.client.getLiquidationPrice({ marginBank: getAddress(marginBank), account, pool }).catch(() => null),
    ]);
    const registry = registryRaw.toLowerCase() === ZERO ? null : getAddress(registryRaw);
    const operatorRegistry = operatorRaw.toLowerCase() === ZERO ? null : getAddress(operatorRaw);
    let somi: bigint | null = null;
    let resolved: boolean | null = null;
    let globalApproved: boolean | null = null;
    let poolApproved: boolean | null = null;
    if (registry && operatorRegistry) {
      [somi, resolved, globalApproved, poolApproved] = await Promise.all([
        client.readContract({ address: registry, abi, functionName: "somiPaymentPerOrder" }),
        client.readContract({
          address: pool,
          abi,
          functionName: "isOperatorAuthorized",
          args: [account, registry, PLACE_ORDER_FOR_SELECTOR],
        }),
        client.readContract({
          address: operatorRegistry,
          abi,
          functionName: "isGloballyApproved",
          args: [account, registry, PLACE_ORDER_FOR_SELECTOR],
        }),
        client.readContract({
          address: operatorRegistry,
          abi,
          functionName: "isApprovedForPool",
          args: [pool, account, registry, PLACE_ORDER_FOR_SELECTOR],
        }),
      ]);
    }
    const stops = await readStops(markets, account, pool);
    const preview = previewProtectiveStop({
      deploymentId: review.deploymentId,
      wallet: account,
      market: quote.market,
      pool,
      registry,
      operatorRegistry,
      positionSize: BigInt(quote.positionSize),
      mark: BigInt(quote.markPrice),
      liquidation: typeof liquidation === "bigint" && liquidation > 0n ? liquidation : null,
      tickSize: book.tickSize,
      lotSize: book.lotSize,
      minQuantity: book.minQuantity,
      reducingCapacity: BigInt(quote.reducingCapacity),
      requestedQuantity: requested,
      somiPayment: somi,
      resolvedAuthorized: resolved,
      globalApproved,
      poolApproved,
      existingStops: stops.stops,
      stopsReadable: stops.readable,
      priceable: quote.priceable,
      healthAgrees: quote.healthAgrees,
      quotedAt: now,
      now,
    });
    return { ok: true, signerConnected: false, preview };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message.slice(0, 500) };
  } finally {
    await Promise.race([Promise.resolve(markets.close?.()), new Promise((resolve) => setTimeout(resolve, 3_000))]).catch(() => undefined);
  }
}

async function readStops(
  markets: ReturnType<typeof openHideki>,
  account: `0x${string}`,
  pool: `0x${string}`,
): Promise<{ readable: boolean; stops: KnownStop[] }> {
  try {
    const rows = await markets.client.listPerpStopOrders({ account, pool, status: ["PENDING"] });
    const stops: KnownStop[] = [];
    for (const row of rows) {
      const live = await markets.client.getPerpStopOrder({ registry: getAddress(row.registry), orderId: row.orderIdRaw });
      if (!live) continue;
      const intent = live.intent === "reduceOnly" || live.intent === "opening" ? live.intent : null;
      stops.push({
        orderId: row.orderIdRaw,
        live: true,
        intent,
        isBid: live.isBid,
        triggerOperator: live.triggerOperator,
        quantity: live.quantity.toString(),
        triggerPrice: live.triggerPrice.toString(),
      });
    }
    return { readable: true, stops };
  } catch {
    return { readable: false, stops: [] };
  }
}
