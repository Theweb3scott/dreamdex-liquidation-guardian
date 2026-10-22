import { getAddress, isAddress, createPublicClient, http, parseAbi, type PublicClient } from "viem";
import { SOMNIA_HIDEKI_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { openHideki } from "./hideki-read.ts";
import { HIDEKI_CHAIN_ID, HIDEKI_V2_ID, HIDEKI_V2_NET_VERSION, HIDEKI_V2_RPC_HOST, assessDeployment, buildProtectiveQuote, type ReviewQuote } from "./review.ts";

const poolAbi = parseAbi([
  "function getMarketStatus() view returns (uint8)",
  "function isRestricted() view returns (bool)",
  "function getReducingCapacity(address account) view returns ((int128 positionSize, uint256 pendingBidQuantity, uint256 pendingAskQuantity, uint256 pendingOppositeQuantity, uint256 effectiveReducingCapacity) capacity)",
  "function getPerpPoolParameters() view returns ((uint256 initialMarginBps, uint256 maintenanceMarginBps, uint256 closeOutMarginBps, uint256 maxOpenInterest, uint256 maxPositionSize, uint256 takerFeeBpsTimes1k, int256 makerFeeBpsTimes1k, uint256 insuranceFundShareBps))",
  "function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))",
  "function marginBank() view returns (address)",
  "function isDeployedByFactory(address pool) view returns (bool)",
]);

export type WalletReviewResult =
  | {
      ok: true;
      chainId: number;
      signerConnected: false;
      deploymentId: typeof HIDEKI_V2_ID;
      quotes: ReviewQuote[];
      notes: string[];
    }
  | { ok: false; error: string };

/** Read-only quote for a wallet the browser connected. This process still has no signer. */
export async function readWalletReview(rawAccount: string, requestedRaw: string | null): Promise<WalletReviewResult> {
  const trimmed = rawAccount.trim();
  if (!isAddress(trimmed)) return { ok: false, error: "The connected address is not a 20-byte account." };
  const account = getAddress(trimmed);
  let requested: bigint | null = null;
  if (requestedRaw && requestedRaw.trim() !== "") {
    if (!/^\d+$/.test(requestedRaw.trim())) return { ok: false, error: "Requested quantity must be a raw integer." };
    requested = BigInt(requestedRaw.trim());
  }

  const markets = openHideki();
  const client = createPublicClient({ chain: hidekiTestnet, transport: http(hidekiTestnet.rpcUrls.default.http[0]) });
  try {
    if (markets.walletAddress) return { ok: false, error: "A signer is present on this process. Refusing to review." };
    const rpcUrl = hidekiTestnet.rpcUrls.default.http[0];
    if (!rpcUrl) return { ok: false, error: "The SDK has no Hideki HTTP RPC." };
    const identity = await proveDeployment(client, rpcUrl);
    if (!identity.ok) return identity;
    const listed = await markets.client.listPerpMarkets();
    const marginBank = SOMNIA_HIDEKI_TESTNET_ADDRESSES.marginBank;
    if (!marginBank) return { ok: false, error: "SDK address book has no Hideki margin bank." };
    const system = await markets.client.getPerpSystemConfig(marginBank);
    const bank = system.marginBank;
    const [margin, health, analytics] = await Promise.all([
      markets.client.getMarginAccount(bank, account),
      markets.client.getAccountHealth(bank, account),
      markets.client.listPerpPositionAnalytics({ marginBank: bank, account }),
    ]);
    const agrees =
      margin.equity === health.equity &&
      margin.imReq === health.imReq &&
      margin.mmReq === health.mmReq &&
      margin.cmReq === health.cmReq &&
      String(margin.marginStatus) === String(health.marginStatus);
    const quotes: ReviewQuote[] = [];
    const notes = [
      "This read uses the connected address as a public account. No key was requested.",
      `Deployment ${HIDEKI_V2_ID} checked on ${identity.observation.rpcHost}, network version ${identity.observation.netVersion}. Chain id alone is not the identity.`,
    ];
    for (const row of analytics) {
      if (row.size === 0n) continue;
      const meta = listed.find((item) => getAddress(item.poolAddress) === getAddress(row.pool));
      const pool = getAddress(row.pool);
      const [position, snapshot, orders, status, restricted, capacity, params, book, owns, poolBank, poolCode] = await Promise.all([
        markets.client.getPerpPosition({ marginBank: bank, account, pool }),
        markets.client.getPerpHealthSnapshot(pool),
        markets.client.getOwnOpenOrdersOnchain(pool, account),
        client.readContract({ address: pool, abi: poolAbi, functionName: "getMarketStatus" }),
        client.readContract({ address: pool, abi: poolAbi, functionName: "isRestricted" }),
        client.readContract({ address: pool, abi: poolAbi, functionName: "getReducingCapacity", args: [account] }),
        client.readContract({ address: pool, abi: poolAbi, functionName: "getPerpPoolParameters" }),
        client.readContract({ address: pool, abi: poolAbi, functionName: "getOrderBookParameters" }),
        client.readContract({ address: identity.factory, abi: poolAbi, functionName: "isDeployedByFactory", args: [pool] }),
        client.readContract({ address: pool, abi: poolAbi, functionName: "marginBank" }),
        client.getCode({ address: pool }),
      ]);
      const poolIdentity = assessDeployment({
        ...identity.observation,
        poolCodeBytes: codeBytes(poolCode),
        factoryOwnsPool: owns,
        poolMarginBank: poolBank,
      });
      if (!poolIdentity.ok) {
        notes.push(`${meta?.baseSymbol ?? pool}: ${poolIdentity.reason}`);
        continue;
      }
      const built = buildProtectiveQuote({
        wallet: account,
        chainId: HIDEKI_CHAIN_ID,
        market: meta?.baseSymbol ?? pool,
        pool,
        positionSize: position.size,
        reducingCapacity: capacity.effectiveReducingCapacity,
        pendingOppositeQuantity: capacity.pendingOppositeQuantity,
        openOrderIds: orders.map((id) => id.toString()),
        healthAgrees: agrees,
        priceable: snapshot.priceable && row.priceable,
        marketStatus: Number(status),
        restricted,
        block: margin.asOfBlock.toString(),
        markPrice: snapshot.priceable ? snapshot.markPrice : 0n,
        oneBase: snapshot.priceable ? snapshot.oneBase : 0n,
        takerFeeBpsTimes1k: params.takerFeeBpsTimes1k,
        tickSize: book.tickSize,
        lotSize: book.lotSize,
        minQuantity: book.minQuantity,
        requestedQuantity: requested,
        quotedAt: Date.now(),
        deploymentId: HIDEKI_V2_ID,
      });
      if (!built.ok) {
        notes.push(`${meta?.baseSymbol ?? pool}: ${built.error}`);
        continue;
      }
      quotes.push(built.quote);
    }
    if (quotes.length === 0 && notes.length === 2) notes.push("No open position can be prepared.");
    return { ok: true, chainId: hidekiTestnet.id, signerConnected: false, deploymentId: HIDEKI_V2_ID, quotes, notes };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message.slice(0, 500) };
  } finally {
    await Promise.race([Promise.resolve(markets.close?.()), new Promise((resolve) => setTimeout(resolve, 3_000))]).catch(() => undefined);
  }
}

export async function proveDeployment(client: PublicClient, rpcUrl: string) {
  const marginBank = SOMNIA_HIDEKI_TESTNET_ADDRESSES.marginBank;
  const factory = SOMNIA_HIDEKI_TESTNET_ADDRESSES.perpPoolFactory;
  if (!marginBank || !factory) return { ok: false as const, error: "SDK address book has no Hideki margin bank or factory." };
  const host = new URL(rpcUrl).host;
  const bank = getAddress(marginBank);
  const factoryAddress = getAddress(factory);
  const [chainId, netVersion, bankCode, factoryCode] = await Promise.all([
    client.getChainId(),
    client.request({ method: "net_version" }),
    client.getCode({ address: bank }),
    client.getCode({ address: factoryAddress }),
  ]);
  if (host !== HIDEKI_V2_RPC_HOST) return { ok: false as const, error: "Quote RPC is not the Hideki v2 endpoint." };
  if (chainId !== HIDEKI_CHAIN_ID) return { ok: false as const, error: "Hideki v2 RPC did not report chain 50383." };
  if (String(netVersion) !== HIDEKI_V2_NET_VERSION) return { ok: false as const, error: "Network version is not Hideki v2." };
  if (codeBytes(bankCode) === 0 || codeBytes(factoryCode) === 0) {
    return { ok: false as const, error: "The SDK Hideki contracts have no code on this RPC." };
  }
  return {
    ok: true as const,
    factory: factoryAddress,
    observation: {
      chainId,
      netVersion: String(netVersion),
      rpcHost: host,
      marginBank: bank,
      expectedMarginBank: bank,
      factory: factoryAddress,
      expectedFactory: factoryAddress,
      marginBankCodeBytes: codeBytes(bankCode),
      factoryCodeBytes: codeBytes(factoryCode),
    },
  };
}

function codeBytes(code: string | undefined): number {
  if (!code || code === "0x") return 0;
  return (code.length - 2) / 2;
}
