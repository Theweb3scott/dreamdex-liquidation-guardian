/** Single-market health and liquidation math.

 * Liquidation identity is the one published by @somnia-chain/markets-sdk
 * `perpLiquidationPrice` (equity and maintenance both move with the mark):
 *
 *   long   p = mark − (equity − mmReq) × 10000 / (|size| × (10000 − mmBps))
 *   short  p = mark + (equity − mmReq) × 10000 / (|size| × (10000 + mmBps))
 *
 * Inputs are human units (USDso, base contracts, quote per whole base).
 * This is an estimate for one market. Cross-margin positions elsewhere are
 * not included. The indexer does not publish maintenance bps.
 */

export type Side = "long" | "short";

export type MarginBand = "Healthy" | "MarginCall" | "BelowMaintenance";

export type GuardAction =
  | { kind: "hold"; reason: string }
  | { kind: "reduce"; fraction: number; reason: string }
  | { kind: "blocked"; reason: string };

export function quoteToNumber(raw: string, decimals = 18): number {
  if (!raw) return 0;
  const neg = raw.startsWith("-");
  const digits = (neg ? raw.slice(1) : raw).replace(/[^0-9]/g, "");
  if (!digits) return 0;
  const value = BigInt(digits);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = (value % scale).toString().padStart(decimals, "0").slice(0, 8);
  const n = Number(`${whole}.${frac}`);
  return neg ? -n : n;
}

export function healthRatio(equity: number, mmReq: number): number {
  if (!(mmReq > 0) || !Number.isFinite(equity)) return Number.POSITIVE_INFINITY;
  return equity / mmReq;
}

export function requirement(sizeAbs: number, mark: number, bps: number): number {
  if (!(sizeAbs > 0) || !(mark > 0) || !(bps > 0)) return 0;
  return sizeAbs * mark * (bps / 10_000);
}

export function unrealizedPnl(side: Side, size: number, entry: number, mark: number): number {
  if (!(size > 0) || !(entry > 0) || !(mark > 0)) return 0;
  const signed = side === "long" ? 1 : -1;
  return (mark - entry) * size * signed;
}

/** Estimated mark that trips maintenance for this market alone. Null if flat or undefined. */
export function liquidationPrice(input: {
  equity: number;
  mmReq: number;
  side: Side;
  size: number;
  mark: number;
  mmBps: number;
}): number | null {
  const { equity, mmReq, side, size, mark, mmBps } = input;
  if (!(size > 0) || !(mark > 0) || !Number.isFinite(equity) || !Number.isFinite(mmReq)) return null;
  if (mmBps <= 0 || mmBps >= 10_000) return null;
  const cushion = equity - mmReq;
  if (side === "long") {
    const denom = size * (10_000 - mmBps);
    const price = mark - (cushion * 10_000) / denom;
    return price > 0 ? price : 0;
  }
  const denom = size * (10_000 + mmBps);
  const price = mark + (cushion * 10_000) / denom;
  return price > 0 ? price : 0;
}

export function distanceToLiquidation(side: Side, mark: number, liq: number | null): number | null {
  if (liq == null || !(mark > 0)) return null;
  return side === "long" ? (mark - liq) / mark : (liq - mark) / mark;
}

export function marginBand(equity: number, imReq: number, mmReq: number): MarginBand {
  if (mmReq > 0 && equity < mmReq) return "BelowMaintenance";
  if (imReq > 0 && equity < imReq) return "MarginCall";
  return "Healthy";
}

export function decideProtection(input: {
  ratio: number;
  stale: boolean;
  reduceBelow: number;
  flattenBelow: number;
  reducePct: number;
  maxReducePct: number;
  duplicate: boolean;
}): GuardAction {
  const { ratio, stale, reduceBelow, flattenBelow, reducePct, maxReducePct, duplicate } = input;
  if (!(reduceBelow > flattenBelow)) {
    return {
      kind: "blocked",
      reason: "Flatten threshold must sit below the reduce threshold.",
    };
  }
  if (stale) {
    return { kind: "blocked", reason: "Mark is stale. No protective size is proposed." };
  }
  if (duplicate) {
    return { kind: "blocked", reason: "Duplicate suppressed. This size was already proposed." };
  }
  if (!Number.isFinite(ratio)) {
    return { kind: "hold", reason: "No maintenance requirement. Nothing to guard." };
  }
  const cap = clampPct(maxReducePct);
  if (ratio < flattenBelow) {
    const fraction = Math.min(1, cap);
    return {
      kind: "reduce",
      fraction,
      reason:
        fraction < 1
          ? `Health ${ratio.toFixed(2)}x is under flatten. Close is capped at ${(fraction * 100).toFixed(0)}% this cycle.`
          : `Health ${ratio.toFixed(2)}x is under flatten. Full close proposed.`,
    };
  }
  if (ratio < reduceBelow) {
    const fraction = Math.min(clampPct(reducePct), cap);
    if (!(fraction > 0)) {
      return { kind: "blocked", reason: "Reduce size is zero after the maximum-reduction cap." };
    }
    return {
      kind: "reduce",
      fraction,
      reason: `Health ${ratio.toFixed(2)}x is under ${reduceBelow.toFixed(2)}x. Reduce ${(fraction * 100).toFixed(0)}%.`,
    };
  }
  return { kind: "hold", reason: `Health ${ratio.toFixed(2)}x is above ${reduceBelow.toFixed(2)}x maintenance.` };
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function formatPx(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown age";
  if (seconds < 90) return `${Math.floor(seconds)}s old`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m old`;
  return `${Math.floor(seconds / 3600)}h old`;
}
