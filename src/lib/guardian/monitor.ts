/** Protocol risk monitor. Pure: no SDK, no orders.

 * Authoritative health is equity / maintenance from one margin snapshot.
 * A ratio is produced only when both integers exist and maintenance is > 0.
 * Unpriceable marks, disagreeing health reads, and mixed blocks suppress the band.
 * A liquidation price of 0 is the SDK floor, not a level to measure distance from.
 */

export type RiskBand = "clear" | "warning" | "danger" | "critical" | "unpriced" | "incomparable" | "inconsistent";

export type Thresholds = {
  warningBelow: number;
  dangerBelow: number;
  criticalBelow: number;
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  warningBelow: 2,
  dangerBelow: 1.5,
  criticalBelow: 1.15,
};

export type LiquidationQuote = { price: string | null } | { error: string };

export type PositionSnapshot = {
  symbol: string;
  size: string;
  baseDecimals: number;
  priceable: boolean;
  poolPriceable: boolean;
  asOfBlock: string;
  entry: string | null;
  mark: string | null;
  liquidationPrice: LiquidationQuote;
};

export type AccountSnapshot = {
  equity: string;
  mmReq: string;
  healthAgrees: boolean;
  marginBlock: string;
  positions: PositionSnapshot[];
};

export type LiquidationView =
  | { kind: "level"; price: string; distance: string }
  | { kind: "floored" }
  | { kind: "flat" }
  | { kind: "unpriced" }
  | { kind: "unavailable"; reason: string };

export type PositionView = {
  symbol: string;
  direction: "long" | "short" | "flat";
  size: string;
  entry: string | null;
  mark: string | null;
  liquidation: LiquidationView;
};

export type Assessment = {
  band: RiskBand;
  ratio: string | null;
  reason: string;
  equity: string;
  mmReq: string;
  positions: PositionView[];
};

const SCALE = 1_000_000n;

export function parsePublicAddress(value: string): { ok: true; address: string } | { ok: false; error: string } {
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return { ok: false, error: "Enter a public 20-byte address before reading the account." };
  }
  return { ok: true, address: trimmed };
}

export function parseThresholds(input: {
  warning: string;
  danger: string;
  critical: string;
}): { ok: true; thresholds: Thresholds } | { ok: false; error: string } {
  const warningBelow = Number(input.warning);
  const dangerBelow = Number(input.danger);
  const criticalBelow = Number(input.critical);
  if (![warningBelow, dangerBelow, criticalBelow].every((n) => Number.isFinite(n) && n > 0)) {
    return { ok: false, error: "Thresholds must be positive numbers." };
  }
  if (!(criticalBelow < dangerBelow && dangerBelow < warningBelow)) {
    return { ok: false, error: "Thresholds must rise: critical, then danger, then warning." };
  }
  return { ok: true, thresholds: { warningBelow, dangerBelow, criticalBelow } };
}

export function assessAccount(account: AccountSnapshot, thresholds: Thresholds = DEFAULT_THRESHOLDS): Assessment {
  const positions = account.positions.map(viewPosition);
  const base = { equity: account.equity, mmReq: account.mmReq, positions };

  if (!account.healthAgrees) {
    return {
      ...base,
      band: "inconsistent",
      ratio: null,
      reason: "getMarginAccount and getAccountHealth disagree. No band is assigned.",
    };
  }
  const mixedBlock = account.positions.some((position) => position.asOfBlock !== account.marginBlock);
  if (mixedBlock) {
    return {
      ...base,
      band: "inconsistent",
      ratio: null,
      reason: "Position rows are not on the margin account block. No band is assigned.",
    };
  }
  const unpriced = account.positions.some(
    (position) => position.size !== "0" && (!position.priceable || !position.poolPriceable),
  );
  if (unpriced) {
    return {
      ...base,
      band: "unpriced",
      ratio: null,
      reason: "A mark is unpriceable or stale. Health is withheld.",
    };
  }

  const equity = parseIntString(account.equity);
  const mmReq = parseIntString(account.mmReq);
  if (equity === null || mmReq === null) {
    return { ...base, band: "incomparable", ratio: null, reason: "Equity or maintenance is not an integer." };
  }
  if (mmReq === 0n) {
    return {
      ...base,
      band: "incomparable",
      ratio: null,
      reason: "Maintenance requirement is zero. Equity over maintenance is undefined.",
    };
  }
  if (!thresholdsValid(thresholds)) {
    return { ...base, band: "incomparable", ratio: null, reason: "Thresholds are not ordered." };
  }

  const ratio = formatRatio(equity, mmReq);
  const band = classify(equity, mmReq, thresholds);
  return {
    ...base,
    band,
    ratio,
    reason: bandReason(band, ratio),
  };
}

export type MonitorLog =
  | { kind: "failed"; message: string }
  | { kind: "changed"; band: RiskBand; message: string };

/** One in-flight read. A second caller is refused until leave(). */
export function createReadGate(): { tryEnter: () => boolean; leave: () => void } {
  let held = false;
  return {
    tryEnter() {
      if (held) return false;
      held = true;
      return true;
    },
    leave() {
      held = false;
    },
  };
}

/** Execution stays off. Stale, failed, and inconsistent reads are explicit refusals. */
export function protectionDecision(input: Assessment | { error: string }): { execute: false; reason: string } {
  if ("error" in input) return { execute: false, reason: "Read failed. No protection order." };
  if (input.band === "unpriced") {
    return { execute: false, reason: "Stale or unpriceable mark. Protection decision withheld." };
  }
  if (input.band === "inconsistent") {
    return { execute: false, reason: "Inconsistent snapshot. Protection decision withheld." };
  }
  if (input.band === "incomparable") {
    return { execute: false, reason: "Maintenance is not comparable. Protection decision withheld." };
  }
  return { execute: false, reason: `Band ${input.band}. Execution is disarmed. No order.` };
}
export function monitorLog(previous: RiskBand | null, next: Assessment | { error: string }): MonitorLog | null {
  if ("error" in next) return { kind: "failed", message: `Read failed: ${next.error}` };
  if (previous === next.band) return null;
  const from = previous ?? "none";
  return { kind: "changed", band: next.band, message: `${from} → ${next.band}. ${next.reason}` };
}

function viewPosition(position: PositionSnapshot): PositionView {
  const size = parseIntString(position.size);
  const direction = size === null ? "flat" : size > 0n ? "long" : size < 0n ? "short" : "flat";
  return {
    symbol: position.symbol,
    direction,
    size: human(position.size, position.baseDecimals),
    entry: position.entry ? human(position.entry, 18) : null,
    mark: position.mark ? human(position.mark, 18) : null,
    liquidation: liquidationView(direction, position),
  };
}

function liquidationView(direction: PositionView["direction"], position: PositionSnapshot): LiquidationView {
  if (!position.priceable || !position.poolPriceable) return { kind: "unpriced" };
  if ("error" in position.liquidationPrice) {
    return { kind: "unavailable", reason: position.liquidationPrice.error };
  }
  const price = position.liquidationPrice.price;
  if (price === null || direction === "flat") return { kind: "flat" };
  if (price === "0") return { kind: "floored" };
  const mark = position.mark ? parseIntString(position.mark) : null;
  const liq = parseIntString(price);
  if (!mark || !liq || mark <= 0n || liq <= 0n) return { kind: "unavailable", reason: "Mark or liquidation price is not positive." };
  const distance = priceDistance(direction, mark, liq);
  return { kind: "level", price: human(price, 18), distance };
}

function priceDistance(direction: "long" | "short" | "flat", mark: bigint, liq: bigint): string {
  const delta = direction === "short" ? liq - mark : mark - liq;
  const scaled = (delta * 10_000n) / mark;
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${frac}%`;
}

function classify(equity: bigint, mmReq: bigint, thresholds: Thresholds): RiskBand {
  const warning = scale(thresholds.warningBelow);
  const danger = scale(thresholds.dangerBelow);
  const critical = scale(thresholds.criticalBelow);
  if (below(equity, mmReq, critical)) return "critical";
  if (below(equity, mmReq, danger)) return "danger";
  if (below(equity, mmReq, warning)) return "warning";
  return "clear";
}

function below(equity: bigint, mmReq: bigint, threshold: bigint): boolean {
  return equity * SCALE < mmReq * threshold;
}

function scale(value: number): bigint {
  return BigInt(Math.round(value * Number(SCALE)));
}

function thresholdsValid(thresholds: Thresholds): boolean {
  return (
    thresholds.criticalBelow > 0 &&
    thresholds.criticalBelow < thresholds.dangerBelow &&
    thresholds.dangerBelow < thresholds.warningBelow
  );
}

function formatRatio(equity: bigint, mmReq: bigint): string {
  const negative = equity < 0n;
  const scaled = ((negative ? -equity : equity) * SCALE) / mmReq;
  const whole = scaled / SCALE;
  const frac = (scaled % SCALE).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

function parseIntString(value: string): bigint | null {
  if (!/^-?\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function human(raw: string, decimals: number): string {
  const value = parseIntString(raw);
  if (value === null) return raw;
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  const body = frac ? `${whole}.${frac}` : `${whole}`;
  return negative ? `-${body}` : body;
}

function bandReason(band: RiskBand, ratio: string): string {
  if (band === "clear") return `Health ${ratio}× is at or above the warning line.`;
  if (band === "warning") return `Health ${ratio}× is below the warning line.`;
  if (band === "danger") return `Health ${ratio}× is below the danger line.`;
  if (band === "critical") return `Health ${ratio}× is below the critical line.`;
  return `Health ${ratio}×.`;
}
