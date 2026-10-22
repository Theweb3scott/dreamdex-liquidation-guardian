import { createServerFn } from "@tanstack/react-start";

const INDEXER = "https://hideki-dev.smk.somnia.host/v1/graphql";

const QUERY = `query PerpMarks {
  Market(
    where: { marketType: { _eq: "PERP" } }
    order_by: { baseSymbol: asc }
    limit: 40
  ) {
    baseSymbol
    poolAddress
    markPrice
    indexPrice
    markPriceUpdatedAt
    initialMarginBps
    openInterest
    baseDecimals
  }
}`;

export type PerpQuote = {
  symbol: string;
  pool: string;
  mark: string;
  index: string;
  markUpdatedAt: number;
  initialMarginBps: number;
  openInterest: string;
  baseDecimals: number;
};

export type PerpQuoteResult =
  | { ok: true; quotes: PerpQuote[]; fetchedAt: number }
  | { ok: false; error: string };

export const listHidekiPerps = createServerFn({ method: "GET" }).handler(
  async (): Promise<PerpQuoteResult> => {
    try {
      const response = await fetch(INDEXER, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: QUERY }),
      });
      if (!response.ok) {
        return { ok: false, error: `Indexer answered ${response.status}.` };
      }
      const body = (await response.json()) as {
        data?: { Market?: Array<Record<string, unknown>> };
        errors?: Array<{ message?: string }>;
      };
      if (body.errors?.length) {
        return { ok: false, error: body.errors[0]?.message ?? "Indexer query failed." };
      }
      const rows = body.data?.Market ?? [];
      const quotes: PerpQuote[] = rows
        .filter((row) => typeof row.baseSymbol === "string" && typeof row.markPrice === "string")
        .map((row) => ({
          symbol: String(row.baseSymbol),
          pool: String(row.poolAddress ?? ""),
          mark: String(row.markPrice),
          index: String(row.indexPrice ?? "0"),
          markUpdatedAt: Number(row.markPriceUpdatedAt ?? 0),
          initialMarginBps: Number(row.initialMarginBps ?? 0),
          openInterest: String(row.openInterest ?? "0"),
          baseDecimals: Number(row.baseDecimals ?? 18),
        }));
      if (quotes.length === 0) return { ok: false, error: "Indexer returned no perp markets." };
      return { ok: true, quotes, fetchedAt: Date.now() };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Indexer unreachable.";
      return { ok: false, error: message };
    }
  },
);
