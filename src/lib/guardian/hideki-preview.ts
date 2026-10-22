import { getAddress, isAddress } from "viem";
import { emptyJournal, propose, restoreJournal, type ExecMode, type Journal, type Proposal } from "./execution.ts";
import { assessAccount } from "./monitor.ts";
import { createReadGate } from "./monitor.ts";
import { rawPercent } from "./preview.ts";
import { openHideki, readHidekiProtocol } from "./hideki-read.ts";

const previewGate = createReadGate();

export type DryRunResult =
  | { ok: true; journal: Journal; proposals: Proposal[] }
  | { ok: false; error: string };

export async function runDryRunPreview(
  rawAccount: string,
  requestedPct: number,
  maxPct: number,
  mode: ExecMode,
  journalRaw: string | null,
  includeWarning: boolean,
): Promise<DryRunResult> {
  if (mode !== "demo" && mode !== "protection") return { ok: false, error: "Mode must be demo or protection." };
  if (!isAddress(rawAccount)) return { ok: false, error: "Enter a public 20-byte address before a preview." };
  if (!Number.isInteger(requestedPct) || !Number.isInteger(maxPct) || requestedPct < 0 || maxPct < 0 || requestedPct > 100 || maxPct > 100) {
    return { ok: false, error: "Requested and max reduction must be whole percents from 0 to 100." };
  }
  let journal: Journal;
  try {
    journal = journalRaw ? restoreJournal(journalRaw) : emptyJournal();
  } catch {
    return { ok: false, error: "The execution journal could not be read." };
  }
  if (!previewGate.tryEnter()) {
    return {
      ok: true,
      journal,
      proposals: [
        {
          label: mode === "demo" ? "DEMONSTRATION ONLY" : "PROTECTION PREVIEW — NOT SENT",
          state: "failed",
          reason: "Another preview is being processed.",
          account: rawAccount,
          market: "—",
          pool: "—",
          positionDirection: "flat",
          currentSize: "0",
          protectiveDirection: "none",
          isBid: null,
          proposedQuantity: "0",
          reductionBps: null,
          block: "0",
          healthRatio: null,
          risk: "incomparable",
          intentId: null,
          signingReachable: false,
        },
      ],
    };
  }

  try {
    const read = await readHidekiProtocol(rawAccount);
    if (!read.ok || !read.account) {
      const message = read.ok ? "No account in the protocol read." : read.error;
      return { ok: false, error: message };
    }
    const account = getAddress(rawAccount);
    const positions = read.account.positions;
    if (positions.length === 0) {
      const flat = assessAccount({
        equity: read.account.margin.equity,
        mmReq: read.account.margin.mmReq,
        healthAgrees: read.account.accountHealth.agreesWithMarginAccount,
        marginBlock: read.account.margin.asOfBlock,
        positions: [],
      });
      const closed = propose(journal, {
        mode,
        account,
        market: "—",
        pool: "—",
        band: flat.band,
        ratio: flat.ratio,
        priceable: flat.band !== "unpriced",
        healthAgrees: read.account.accountHealth.agreesWithMarginAccount,
        blocksConsistent: true,
        includeWarning,
        firstSize: "0",
        freshSize: "0",
        requestedReduction: "0",
        maxAllowedReduction: "0",
        openOrderIds: [],
        marginBlock: read.account.margin.asOfBlock,
        rpcError: null,
        timedOut: false,
      });
      return { ok: true, journal: closed.journal, proposals: [closed.proposal] };
    }

    const view = assessAccount({
      equity: read.account.margin.equity,
      mmReq: read.account.margin.mmReq,
      healthAgrees: read.account.accountHealth.agreesWithMarginAccount,
      marginBlock: read.account.margin.asOfBlock,
      positions: positions.map((position) => ({
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
    });

    const markets = openHideki();
    try {
      const proposals: Proposal[] = [];
      for (const position of positions) {
        let freshSize = position.position.size;
        let openOrderIds: string[] = [];
        let rpcError: string | null = null;
        try {
          const fresh = await markets.client.getPerpPosition({
            marginBank: getAddress(read.system.marginBank),
            account,
            pool: getAddress(position.pool),
          });
          freshSize = fresh.size.toString();
          const ids = await markets.client.getOwnOpenOrdersOnchain(getAddress(position.pool), account);
          openOrderIds = ids.map((id) => id.toString());
        } catch (error) {
          rpcError = error instanceof Error ? error.message.slice(0, 300) : "RPC failed.";
        }
        const abs = absBigint(freshSize);
        const next = propose(journal, {
          mode,
          account,
          market: position.symbol,
          pool: position.pool,
          band: view.band,
          ratio: view.ratio,
          priceable: position.priceable && position.poolPriceable && view.band !== "unpriced",
          healthAgrees: read.account.accountHealth.agreesWithMarginAccount,
          blocksConsistent: position.asOfBlock === read.account.margin.asOfBlock,
          includeWarning,
          firstSize: position.position.size,
          freshSize,
          requestedReduction: rawPercent(abs, BigInt(requestedPct)).toString(),
          maxAllowedReduction: rawPercent(abs, BigInt(maxPct)).toString(),
          openOrderIds,
          marginBlock: read.account.margin.asOfBlock,
          rpcError,
          timedOut: false,
        });
        journal = next.journal;
        proposals.push(next.proposal);
      }
      return { ok: true, journal, proposals };
    } finally {
      await Promise.race([
        Promise.resolve(markets.close?.()),
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]).catch(() => undefined);
    }
  } finally {
    previewGate.leave();
  }
}

function absBigint(raw: string): bigint {
  if (!/^-?\d+$/.test(raw)) return 0n;
  const value = BigInt(raw);
  return value < 0n ? -value : value;
}
