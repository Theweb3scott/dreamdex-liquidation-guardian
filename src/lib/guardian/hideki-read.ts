import {
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  SomniaMarkets,
  type PerpHealthSnapshot,
  type PerpPositionAnalytics,
} from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { getAddress, isAddress } from "viem";

const INDEXER_URL = "https://hideki-dev.smk.somnia.host/v1/graphql";
const SDK_VERSION = "0.32.1";

export type JsonHealth =
  | { priceable: false }
  | {
      priceable: true;
      markPrice: string;
      effectiveImfBps: string;
      maintenanceMarginBps: string;
      closeOutMarginBps: string;
      oneBase: string;
      projectedCumulativeFunding: string;
    };

export type ProtocolRead = {
  ok: true;
  sdkVersion: string;
  chainId: number;
  signerConnected: false;
  walletAddress: null;
  called: string[];
  system: {
    marginBank: string;
    collateralToken: string;
    perpPoolFactory: string;
    liquidationEngine: string;
    insuranceFund: string;
    maxLeverageLimit: number;
    fullyWired: boolean;
  };
  markets: Array<{
    symbol: string;
    pool: string;
    marginBank: string;
    baseDecimals: number;
    risk: {
      initialMarginBps: string;
      maintenanceMarginBps: string;
      closeOutMarginBps: string;
      takerFeeBpsTimes1k: string;
    };
    health: JsonHealth;
  }>;
  account: null | {
    address: string;
    margin: {
      asOfBlock: string;
      status: string;
      equity: string;
      unlockedCollateralBalance: string;
      lockedCollateral: string;
      withdrawable: string;
      imReq: string;
      mmReq: string;
      cmReq: string;
      activePerpPools: string[];
      equityOverMaintenance: string | null;
    };
    accountHealth: {
      status: string;
      equity: string;
      imReq: string;
      mmReq: string;
      cmReq: string;
      agreesWithMarginAccount: boolean;
    };
    positions: Array<{
      symbol: string;
      pool: string;
      baseDecimals: number;
      priceable: boolean;
      poolPriceable: boolean;
      asOfBlock: string;
      size: string;
      avgEntryPrice?: string;
      markPrice?: string;
      notional?: string;
      unrealizedPnl?: string;
      accruedFunding?: string;
      equityContribution?: string;
      maintenanceMarginBps: string;
      oneBase: string | null;
      projectedFunding: string | null;
      takerFeeBpsTimes1k: string;
      maintenanceMarginRequirement?: string;
      initialMarginRequirement?: string;
      closeOutMarginRequirement?: string;
      position: {
        size: string;
        avgEntryPrice: string;
        entryFundingIndex: string;
      };
      liquidationPrice: { price: string | null } | { error: string };
    }>;
  };
  notes: string[];
};

export type ProtocolResult = ProtocolRead | { ok: false; error: string; called: string[] };

function bi(value: bigint): string {
  return value.toString();
}

function ratio(equity: bigint, mmReq: bigint): string | null {
  if (mmReq === 0n) return null;
  const negative = equity < 0n;
  const scaled = ((negative ? -equity : equity) * 1_000_000n) / mmReq;
  const whole = scaled / 1_000_000n;
  const frac = (scaled % 1_000_000n).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

function healthJson(snapshot: PerpHealthSnapshot): JsonHealth {
  if (!snapshot.priceable) return { priceable: false };
  return {
    priceable: true,
    markPrice: bi(snapshot.markPrice),
    effectiveImfBps: bi(snapshot.effectiveImfBps),
    maintenanceMarginBps: bi(snapshot.maintenanceMarginBps),
    closeOutMarginBps: bi(snapshot.closeOutMarginBps),
    oneBase: bi(snapshot.oneBase),
    projectedCumulativeFunding: bi(snapshot.projectedCumulativeFunding),
  };
}

function sameTuple(
  a: { equity: bigint; imReq: bigint; mmReq: bigint; cmReq: bigint; status: string },
  b: { equity: bigint; imReq: bigint; mmReq: bigint; cmReq: bigint; status: string },
): boolean {
  return a.equity === b.equity && a.imReq === b.imReq && a.mmReq === b.mmReq && a.cmReq === b.cmReq && a.status === b.status;
}

export function openHideki(): SomniaMarkets {
  return new SomniaMarkets({
    chain: hidekiTestnet,
    indexerUrl: INDEXER_URL,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
    wsRpcUrl: hidekiTestnet.rpcUrls.default.webSocket[0],
  });
}

async function shutdown(markets: SomniaMarkets): Promise<void> {
  await Promise.race([
    Promise.resolve(markets.close?.()),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]).catch(() => undefined);
}

export async function readHidekiProtocol(rawAccount?: string): Promise<ProtocolResult> {
  const called: string[] = [];
  let account: `0x${string}` | undefined;
  if (rawAccount && rawAccount.trim()) {
    const trimmed = rawAccount.trim();
    if (!isAddress(trimmed)) return { ok: false, error: "Address is not a 20-byte hex account.", called };
    account = getAddress(trimmed);
  }

  const markets = openHideki();
  try {
    called.push("listPerpMarkets");
    const listed = await markets.client.listPerpMarkets();
    const byPool = new Map(listed.map((row) => [getAddress(row.poolAddress), row]));
    const focus = ["BTC", "ETH", "SOL"].flatMap((symbol) => {
      const row = listed.find((item) => item.baseSymbol === symbol);
      return row ? [row] : [];
    });

    called.push("getPerpSystemConfig");
    const marginBank = SOMNIA_HIDEKI_TESTNET_ADDRESSES.marginBank;
    if (!marginBank) throw new Error("SDK address book has no Hideki marginBank.");
    const system = await markets.client.getPerpSystemConfig(marginBank);

    const marketReads = [];
    for (const row of focus) {
      called.push(`getPerpRiskParams:${row.baseSymbol}`);
      called.push(`getPerpHealthSnapshot:${row.baseSymbol}`);
      const [risk, health] = await Promise.all([
        markets.client.getPerpRiskParams(row.poolAddress),
        markets.client.getPerpHealthSnapshot(row.poolAddress),
      ]);
      marketReads.push({
        symbol: row.baseSymbol ?? "UNKNOWN",
        pool: getAddress(row.poolAddress),
        marginBank: getAddress(row.marginBank),
        baseDecimals: row.baseDecimals,
        risk: {
          initialMarginBps: bi(risk.initialMarginBps),
          maintenanceMarginBps: bi(risk.maintenanceMarginBps),
          closeOutMarginBps: bi(risk.closeOutMarginBps),
          takerFeeBpsTimes1k: bi(risk.takerFeeBpsTimes1k),
        },
        health: healthJson(health),
      });
    }

    const notes = [
      "No private key is configured. SomniaMarkets.walletAddress is unset, so this process cannot sign.",
      "getMarginAccount pins its fields to asOfBlock. listPerpPositionAnalytics pins every position row to one block. getLiquidationPrice pins its own three reads internally and does not return that block, so it can differ from the margin snapshot.",
      "A stale mark makes getLiquidationPrice throw. That error is returned as-is. No local estimate is substituted.",
      "Maintenance bps below come from getPerpRiskParams and getPerpHealthSnapshot, not from the indexer row.",
    ];

    if (!account) {
      if (markets.walletAddress) {
        notes.unshift(`Unexpected signer ${markets.walletAddress}. Refusing to treat it as connected.`);
      }
      return {
        ok: true,
        sdkVersion: SDK_VERSION,
        chainId: hidekiTestnet.id,
        signerConnected: false,
        walletAddress: null,
        called,
        system: {
          marginBank: system.marginBank,
          collateralToken: system.collateralToken,
          perpPoolFactory: system.perpPoolFactory,
          liquidationEngine: system.liquidationEngine,
          insuranceFund: system.insuranceFund,
          maxLeverageLimit: system.maxLeverageLimit,
          fullyWired: system.fullyWired,
        },
        markets: marketReads,
        account: null,
        notes,
      };
    }

    const bank = system.marginBank;
    called.push("getMarginAccount");
    called.push("getAccountHealth");
    called.push("listPerpPositionAnalytics");
    const [margin, health, analytics] = await Promise.all([
      markets.client.getMarginAccount(bank, account),
      markets.client.getAccountHealth(bank, account),
      markets.client.listPerpPositionAnalytics({ marginBank: bank, account }),
    ]);

    const positions = [];
    for (const row of analytics) {
      const meta = byPool.get(getAddress(row.pool));
      const symbol = meta?.baseSymbol ?? row.pool;
      called.push(`getPerpPosition:${symbol}`);
      called.push(`getPerpRiskParams:${symbol}`);
      called.push(`getPerpHealthSnapshot:${symbol}`);
      const [position, risk, snapshot] = await Promise.all([
        markets.client.getPerpPosition({
          marginBank: bank,
          account,
          pool: row.pool,
        }),
        markets.client.getPerpRiskParams(row.pool),
        markets.client.getPerpHealthSnapshot(row.pool),
      ]);
      let liquidationPrice: { price: string | null } | { error: string };
      called.push(`getLiquidationPrice:${symbol}`);
      try {
        const price = await markets.client.getLiquidationPrice({
          marginBank: bank,
          account,
          pool: row.pool,
        });
        liquidationPrice = { price: typeof price === "bigint" ? bi(price) : null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        liquidationPrice = { error: message.slice(0, 400) };
      }
      const shared = {
        symbol,
        pool: row.pool,
        baseDecimals: meta?.baseDecimals ?? 18,
        asOfBlock: bi(row.asOfBlock),
        maintenanceMarginBps: bi(risk.maintenanceMarginBps),
        oneBase: snapshot.priceable ? bi(snapshot.oneBase) : null,
        projectedFunding: snapshot.priceable ? bi(snapshot.projectedCumulativeFunding) : null,
        takerFeeBpsTimes1k: bi(risk.takerFeeBpsTimes1k),
        poolPriceable: snapshot.priceable,
        position: {
          size: bi(position.size),
          avgEntryPrice: bi(position.avgEntryPrice),
          entryFundingIndex: bi(position.entryFundingIndex),
        },
        liquidationPrice,
      };
      if (!row.priceable) {
        positions.push({
          ...shared,
          priceable: false as const,
          size: bi(row.size),
        });
        continue;
      }
      positions.push({
        ...shared,
        priceable: true as const,
        size: bi(row.size),
        avgEntryPrice: bi(row.avgEntryPrice),
        markPrice: bi(row.markPrice),
        notional: bi(row.notional),
        unrealizedPnl: bi(row.unrealizedPnl),
        accruedFunding: bi(row.accruedFunding),
        equityContribution: bi(row.equityContribution),
        maintenanceMarginRequirement: bi(row.maintenanceMarginRequirement),
        initialMarginRequirement: bi(row.initialMarginRequirement),
        closeOutMarginRequirement: bi(row.closeOutMarginRequirement),
      });
    }

    const marginTuple = {
      equity: margin.equity,
      imReq: margin.imReq,
      mmReq: margin.mmReq,
      cmReq: margin.cmReq,
      status: String(margin.marginStatus),
    };
    const healthTuple = {
      equity: health.equity,
      imReq: health.imReq,
      mmReq: health.mmReq,
      cmReq: health.cmReq,
      status: String(health.marginStatus),
    };

    return {
      ok: true,
      sdkVersion: SDK_VERSION,
      chainId: hidekiTestnet.id,
      signerConnected: false,
      walletAddress: null,
      called,
      system: {
        marginBank: system.marginBank,
        collateralToken: system.collateralToken,
        perpPoolFactory: system.perpPoolFactory,
        liquidationEngine: system.liquidationEngine,
        insuranceFund: system.insuranceFund,
        maxLeverageLimit: system.maxLeverageLimit,
        fullyWired: system.fullyWired,
      },
      markets: marketReads,
      account: {
        address: account,
        margin: {
          asOfBlock: bi(margin.asOfBlock),
          status: marginTuple.status,
          equity: bi(margin.equity),
          unlockedCollateralBalance: bi(margin.unlockedCollateralBalance),
          lockedCollateral: bi(margin.lockedCollateral),
          withdrawable: bi(margin.withdrawable),
          imReq: bi(margin.imReq),
          mmReq: bi(margin.mmReq),
          cmReq: bi(margin.cmReq),
          activePerpPools: margin.activePerpPools,
          equityOverMaintenance: ratio(margin.equity, margin.mmReq),
        },
        accountHealth: {
          status: healthTuple.status,
          equity: bi(health.equity),
          imReq: bi(health.imReq),
          mmReq: bi(health.mmReq),
          cmReq: bi(health.cmReq),
          agreesWithMarginAccount: sameTuple(marginTuple, healthTuple),
        },
        positions,
      },
      notes,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message.slice(0, 600), called };
  } finally {
    await shutdown(markets);
  }
}

/** One public holder, used only by the verification script. Not called by the desk. */
export async function findSampleHolder(): Promise<
  | { ok: true; symbol: string; pool: string; isLong: boolean; holders: number; asOfBlock: string; account: string }
  | { ok: false; error: string }
> {
  const markets = openHideki();
  try {
    const listed = await markets.client.listPerpMarkets();
    const candidates = ["BTC", "ETH", "SOL"].flatMap((symbol) => {
      const row = listed.find((item) => item.baseSymbol === symbol);
      return row ? [row] : [];
    });
    for (const row of candidates) {
      for (const isLong of [true, false]) {
        const side = await markets.client.getPerpSideHolders(
          { marginBank: row.marginBank, pool: row.poolAddress, isLong },
          { pageSize: 20 },
        );
        const account = side.holders[0];
        if (account) {
          return {
            ok: true,
            symbol: row.baseSymbol ?? "UNKNOWN",
            pool: getAddress(row.poolAddress),
            isLong,
            holders: side.holders.length,
            asOfBlock: bi(side.asOfBlock),
            account: getAddress(account),
          };
        }
      }
    }
    return { ok: false, error: "No holders on BTC, ETH, or SOL." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.slice(0, 400) : String(error) };
  } finally {
    await shutdown(markets);
  }
}
