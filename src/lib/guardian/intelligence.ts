/** What-if and portfolio math. Integer port of the SDK's position formulas. Nothing here is a live read. */

import { DEFAULT_THRESHOLDS } from "./monitor.ts";
import type { ShieldBand } from "./shield.ts";

export type IntelPosition = {
  symbol: string;
  pool: string;
  baseDecimals: number;
  priceable: boolean;
  size: string;
  entry: string | null;
  entryFundingIndex: string | null;
  mark: string | null;
  oneBase: string | null;
  maintenanceMarginBps: string | null;
  projectedFunding: string | null;
  takerFeeBpsTimes1k: string | null;
  lotSize: string | null;
  minQuantity: string | null;
  observedNotional: string | null;
  observedPnl: string | null;
  observedMaintenance: string | null;
  observedFunding: string | null;
};

export type IntelBook = {
  address: string;
  chainId: number;
  deploymentId: string;
  refreshedAt: string;
  equity: string | null;
  mmReq: string | null;
  healthAgrees: boolean;
  blocksConsistent: boolean;
  band: ShieldBand;
  bandReason: string;
  positions: IntelPosition[];
};

export type Scenario = {
  shockBps: number;
  shockPools: string[];
  reducePool: string | null;
  reduceBps: number;
  collateralRaw: string;
};

export type Figure =
  | { kind: "protocol"; raw: string; text: string }
  | { kind: "estimate"; raw: string; text: string }
  | { kind: "unknown"; reason: string };

export type PortfolioScan = {
  address: string;
  chainId: number;
  legs: Array<{
    symbol: string;
    pool: string;
    direction: "long" | "short";
    size: string | null;
    notional: Figure;
    pnl: Figure;
    stale: boolean;
  }>;
  longNotional: Figure;
  shortNotional: Figure;
  grossNotional: Figure;
  grossComplete: boolean;
  largest: { symbol: string; share: string } | null;
  warnings: string[];
  summary: string;
  health: { band: ShieldBand; ratio: string | null; reason: string; source: "protocol" };
};

export type ScenarioResult = {
  address: string;
  chainId: number;
  refreshedAt: string;
  hypothetical: true;
  executed: false;
  rows: Array<{
    symbol: string;
    observedMark: string | null;
    hypotheticalMark: Figure;
    observedSize: string | null;
    hypotheticalSize: string | null;
    observedPnl: Figure;
    hypotheticalPnl: Figure;
    pnlChange: Figure;
  }>;
  observedEquity: Figure;
  estimatedEquity: Figure;
  observedMaintenance: Figure;
  estimatedMaintenance: Figure;
  estimatedHealth: { band: ShieldBand | "UNKNOWN"; ratio: string | null; reason: string };
  notes: string[];
  explanation: string[];
};

const COLLATERAL_DECIMALS = 18;
const REDUCTIONS = new Set([0, 2500, 5000, 7500, 10000]);

export function scanPortfolio(book: IntelBook): PortfolioScan {
  const open = book.positions.filter((position) => signed(position.size) !== 0n);
  const legs = open.map(leg);
  const priced = legs.filter((item) => item.notional.kind === "protocol");
  const stale = legs.some((item) => item.stale || item.notional.kind !== "protocol");
  const long = sum(priced.filter((item) => item.direction === "long").map((item) => BigInt(item.notional.kind === "protocol" ? item.notional.raw : "0")));
  const short = sum(priced.filter((item) => item.direction === "short").map((item) => BigInt(item.notional.kind === "protocol" ? item.notional.raw : "0")));
  const gross = long + short;
  const warnings: string[] = [];
  if (!book.healthAgrees) warnings.push("Margin and account-health reads disagree. The health band is withheld.");
  if (!book.blocksConsistent) warnings.push("Position rows are not on the margin block. Treat the snapshot as inconsistent.");
  if (stale) warnings.push("At least one open position has no usable mark. Gross notional omits it and is not the full account.");
  let largest: PortfolioScan["largest"] = null;
  if (gross > 0n) {
    const top = priced.reduce((best, item) => {
      const raw = BigInt(item.notional.kind === "protocol" ? item.notional.raw : "0");
      return raw > best.raw ? { symbol: item.symbol, raw } : best;
    }, { symbol: priced[0]?.symbol ?? "", raw: 0n });
    const shareBps = (top.raw * 10_000n) / gross;
    largest = { symbol: top.symbol, share: bpsText(shareBps) };
    if (shareBps >= 5_000n) warnings.push(`${top.symbol} is ${bpsText(shareBps)} of priced absolute notional.`);
  }
  const health = {
    band: book.band,
    ratio: ratioText(book.equity, book.mmReq),
    reason: book.bandReason,
    source: "protocol" as const,
  };
  return {
    address: book.address,
    chainId: book.chainId,
    legs,
    longNotional: stale ? unknown("Long notional is incomplete while a mark is missing.") : protocol(long, COLLATERAL_DECIMALS),
    shortNotional: stale ? unknown("Short notional is incomplete while a mark is missing.") : protocol(short, COLLATERAL_DECIMALS),
    grossNotional: stale ? unknown("Gross notional is incomplete while a mark is missing.") : protocol(gross, COLLATERAL_DECIMALS),
    grossComplete: !stale,
    largest,
    warnings,
    summary: summary(book, legs, largest, stale),
    health,
  };
}

export function simulate(book: IntelBook, scenario: Scenario): ScenarioResult {
  const notes = [
    "Hypothetical only. No collateral moved and no position was reduced.",
    "Estimated figures use the protocol's integer formulas. They are not a new protocol read.",
  ];
  if (scenario.reduceBps > 0) notes.push("The smaller size is the hypothetical remainder. It is not a fill.");
  const open = book.positions.filter((position) => signed(position.size) !== 0n);
  const shockSet = new Set(scenario.shockPools.map((pool) => pool.toLowerCase()));
  const rows = open.map((position) => projectRow(position, scenario, shockSet));
  const base = accountBase(book, open);
  let estimatedEquity: Figure = base.ok ? estimate(base.equity, COLLATERAL_DECIMALS) : unknown(base.reason);
  let estimatedMaintenance: Figure = base.ok ? estimate(base.mm, COLLATERAL_DECIMALS) : unknown(base.reason);
  if (base.ok) {
    for (const position of open) {
      const shocked = shockSet.has(position.pool.toLowerCase());
      const reduced = scenario.reducePool?.toLowerCase() === position.pool.toLowerCase() && scenario.reduceBps > 0;
      if (!shocked && !reduced) continue;
      const step = reprice(position, shocked ? scenario.shockBps : 0, reduced ? scenario.reduceBps : 0);
      if (!step.ok) {
        estimatedEquity = unknown(step.reason);
        estimatedMaintenance = unknown(step.reason);
        notes.push(step.reason);
        break;
      }
      base.equity = base.equity + step.equityDelta;
      base.mm = base.mm + step.mmDelta;
      if (step.note) notes.push(step.note);
    }
    if (estimatedEquity.kind !== "unknown") {
      const collateral = parseInt(scenario.collateralRaw);
      if (collateral == null) {
        estimatedEquity = unknown("Collateral amount is not an integer.");
        estimatedMaintenance = unknown("Collateral amount is not an integer.");
      } else if (collateral !== 0n) {
        base.equity += collateral;
        notes.push(
          collateral > 0n
            ? "The deposit is hypothetical and was not credited."
            : "The withdrawal is hypothetical. It was not checked against withdrawable collateral and did not happen.",
        );
        estimatedEquity = estimate(base.equity, COLLATERAL_DECIMALS);
        estimatedMaintenance = estimate(base.mm, COLLATERAL_DECIMALS);
      } else {
        estimatedEquity = estimate(base.equity, COLLATERAL_DECIMALS);
        estimatedMaintenance = estimate(base.mm, COLLATERAL_DECIMALS);
      }
    }
  }
  const estimatedHealth = healthEstimate(estimatedEquity, estimatedMaintenance);
  const explanation = explain(book, rows, estimatedEquity, estimatedMaintenance, estimatedHealth, scenario);
  return {
    address: book.address,
    chainId: book.chainId,
    refreshedAt: book.refreshedAt,
    hypothetical: true,
    executed: false,
    rows,
    observedEquity: book.equity && parseInt(book.equity) != null ? protocol(BigInt(book.equity), COLLATERAL_DECIMALS) : unknown("Account equity was not returned."),
    estimatedEquity,
    observedMaintenance: book.mmReq && parseInt(book.mmReq) != null ? protocol(BigInt(book.mmReq), COLLATERAL_DECIMALS) : unknown("Maintenance requirement was not returned."),
    estimatedMaintenance,
    estimatedHealth,
    notes,
    explanation,
  };
}

export function scenarioMatches(result: ScenarioResult, book: IntelBook): boolean {
  return result.address === book.address && result.chainId === book.chainId && result.refreshedAt === book.refreshedAt;
}

export function percentToBps(text: string, direction: "up" | "down"): { ok: true; bps: number } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return { ok: false, error: "Enter a percent with at most two decimal places." };
  const [whole, frac = ""] = trimmed.split(".");
  const bps = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isInteger(bps) || bps > 100_000) return { ok: false, error: "Percent is out of range." };
  if (direction === "down" && bps >= 10_000) return { ok: false, error: "A 100% drop would make the mark zero. That is not simulated." };
  return { ok: true, bps: direction === "down" ? -bps : bps };
}

export function parseCollateral(text: string, direction: "deposit" | "withdraw"): { ok: true; raw: string } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, raw: "0" };
  if (!/^\d+(\.\d{1,8})?$/.test(trimmed)) return { ok: false, error: "Enter a collateral amount with at most 8 decimal places." };
  const [whole, frac = ""] = trimmed.split(".");
  const raw = BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, "0"));
  if (direction === "withdraw" && raw > 0n) return { ok: true, raw: (-raw).toString() };
  return { ok: true, raw: raw.toString() };
}

function projectRow(position: IntelPosition, scenario: Scenario, shocks: Set<string>): ScenarioResult["rows"][number] {
  const size = signed(position.size);
  const shocked = shocks.has(position.pool.toLowerCase());
  const reduced = scenario.reducePool?.toLowerCase() === position.pool.toLowerCase() && scenario.reduceBps > 0;
  const observedMark = position.priceable && position.mark && position.mark !== "0" ? formatRaw(BigInt(position.mark), 18) : null;
  const observedSize = formatRaw(size < 0n ? -size : size, position.baseDecimals);
  const observedPnl = position.observedPnl && parseInt(position.observedPnl) != null
    ? protocol(BigInt(position.observedPnl), COLLATERAL_DECIMALS)
    : unknown("Unrealized PnL was not on the protocol row.");
  if (!shocked && !reduced) {
    return {
      symbol: position.symbol,
      observedMark,
      hypotheticalMark: observedMark ? { kind: "protocol", raw: position.mark ?? "0", text: observedMark } : unknown("No mark."),
      observedSize,
      hypotheticalSize: observedSize,
      observedPnl,
      hypotheticalPnl: observedPnl,
      pnlChange: estimate(0n, COLLATERAL_DECIMALS),
    };
  }
  const step = reprice(position, shocked ? scenario.shockBps : 0, reduced ? scenario.reduceBps : 0);
  if (!step.ok) {
    return {
      symbol: position.symbol,
      observedMark,
      hypotheticalMark: unknown(step.reason),
      observedSize,
      hypotheticalSize: null,
      observedPnl,
      hypotheticalPnl: unknown(step.reason),
      pnlChange: unknown(step.reason),
    };
  }
  return {
    symbol: position.symbol,
    observedMark,
    hypotheticalMark: estimate(step.mark, 18),
    observedSize,
    hypotheticalSize: formatRaw(step.remaining < 0n ? -step.remaining : step.remaining, position.baseDecimals),
    observedPnl,
    hypotheticalPnl: estimate(step.pnl, COLLATERAL_DECIMALS),
    pnlChange: estimate(step.pnl - step.pnlBefore, COLLATERAL_DECIMALS),
  };
}

function reprice(
  position: IntelPosition,
  shockBps: number,
  reduceBps: number,
): { ok: true; mark: bigint; remaining: bigint; pnl: bigint; pnlBefore: bigint; equityDelta: bigint; mmDelta: bigint; note: string | null } | { ok: false; reason: string } {
  if (!position.priceable) return { ok: false, reason: `${position.symbol} has a stale or missing mark. The scenario is UNKNOWN.` };
  if (!Number.isInteger(shockBps) || shockBps <= -10_000 || shockBps > 100_000) {
    return { ok: false, reason: "The shock percent is not a supported integer." };
  }
  if (!REDUCTIONS.has(reduceBps)) return { ok: false, reason: "Reduction must be 0, 25, 50, 75, or 100 percent." };
  const mark = parseInt(position.mark);
  const entry = parseInt(position.entry);
  const oneBase = parseInt(position.oneBase);
  const mmBps = parseInt(position.maintenanceMarginBps);
  const size = signed(position.size);
  if (mark == null || mark <= 0n || entry == null || oneBase == null || oneBase <= 0n || mmBps == null || mmBps <= 0n) {
    return { ok: false, reason: `${position.symbol} is missing a mark, entry, base unit, or maintenance rate. Maintenance is UNKNOWN.` };
  }
  if (oneBase !== 10n ** BigInt(position.baseDecimals)) {
    return { ok: false, reason: `${position.symbol} base decimals do not match oneBase. Scaling was refused.` };
  }
  const before = metrics(size, entry, mark, oneBase, mmBps);
  if (!matches(position.observedPnl, before.pnl) || !matches(position.observedNotional, before.notional) || !matches(position.observedMaintenance, before.mm)) {
    return { ok: false, reason: `${position.symbol} does not match the protocol formula on the current mark. The scenario is UNKNOWN.` };
  }
  const nextMark = (mark * BigInt(10_000 + shockBps)) / 10_000n;
  if (nextMark <= 0n) return { ok: false, reason: "The shocked mark is not positive." };
  const abs = size < 0n ? -size : size;
  const lot = parseInt(position.lotSize);
  let closed = 0n;
  let note: string | null = null;
  if (reduceBps > 0) {
    if (lot == null || lot <= 0n) return { ok: false, reason: `${position.symbol} has no lot size, so a reduction cannot be aligned.` };
    const feeBps = parseInt(position.takerFeeBpsTimes1k);
    if (feeBps == null || feeBps < 0n) return { ok: false, reason: `${position.symbol} has no taker fee, so a reduction's equity is UNKNOWN.` };
    const requested = (abs * BigInt(reduceBps)) / 10_000n;
    closed = (requested / lot) * lot;
    if (closed === 0n) note = `${position.symbol} reduction is below one lot, so size is unchanged.`;
    const min = parseInt(position.minQuantity);
    if (closed > 0n && min != null && closed < min) note = `${position.symbol} quantity is below the pool minimum. The protocol would reject it. The figure is arithmetic only.`;
    const sign = size > 0n ? 1n : -1n;
    const remaining = size - sign * closed;
    const shockedFull = metrics(size, entry, nextMark, oneBase, mmBps);
    const realized = closed === 0n ? 0n : divFloor((nextMark - entry) * sign * closed, oneBase);
    const after = metrics(remaining, entry, nextMark, oneBase, mmBps);
    const fillNotional = (closed * nextMark) / oneBase;
    const fee = (fillNotional * feeBps) / 10_000_000n;
    const equityDelta = shockedFull.pnl - before.pnl - shockedFull.pnl + after.pnl + realized - fee;
    const mmDelta = after.mm - before.mm;
    return { ok: true, mark: nextMark, remaining, pnl: after.pnl, pnlBefore: before.pnl, equityDelta, mmDelta, note };
  }
  const after = metrics(size, entry, nextMark, oneBase, mmBps);
  return {
    ok: true,
    mark: nextMark,
    remaining: size,
    pnl: after.pnl,
    pnlBefore: before.pnl,
    equityDelta: after.pnl - before.pnl,
    mmDelta: after.mm - before.mm,
    note,
  };
}

function accountBase(book: IntelBook, open: IntelPosition[]): { ok: true; equity: bigint; mm: bigint } | { ok: false; reason: string } {
  if (!book.healthAgrees || !book.blocksConsistent) {
    return { ok: false, reason: "The account snapshot is inconsistent. Estimated equity and health are UNKNOWN." };
  }
  const equity = parseInt(book.equity);
  const mm = parseInt(book.mmReq);
  if (equity == null || mm == null) return { ok: false, reason: "Account equity or maintenance was not returned." };
  if (open.some((position) => !position.priceable)) {
    return { ok: false, reason: "A position is unpriceable. Estimated account health is UNKNOWN." };
  }
  let recomputed = 0n;
  for (const position of open) {
    const mark = parseInt(position.mark);
    const oneBase = parseInt(position.oneBase);
    const mmBps = parseInt(position.maintenanceMarginBps);
    const entry = parseInt(position.entry);
    if (mark == null || mark <= 0n || oneBase == null || mmBps == null || mmBps <= 0n || entry == null) {
      return { ok: false, reason: "A position is missing the inputs maintenance needs. Estimated health is UNKNOWN." };
    }
    if (oneBase !== 10n ** BigInt(position.baseDecimals)) {
      return { ok: false, reason: "Base decimals and oneBase disagree. Estimated health is UNKNOWN." };
    }
    const current = metrics(signed(position.size), entry, mark, oneBase, mmBps);
    if (!matches(position.observedMaintenance, current.mm)) {
      return { ok: false, reason: "Recomputed maintenance does not match the protocol row. Estimated health is UNKNOWN." };
    }
    recomputed += current.mm;
  }
  if (recomputed !== mm) return { ok: false, reason: "Position maintenance does not add up to the account requirement. Estimated health is UNKNOWN." };
  return { ok: true, equity, mm };
}

function healthEstimate(equity: Figure, mm: Figure): ScenarioResult["estimatedHealth"] {
  if (equity.kind === "unknown") return { band: "UNKNOWN", ratio: null, reason: equity.reason };
  if (mm.kind === "unknown") return { band: "UNKNOWN", ratio: null, reason: mm.reason };
  const maintenance = BigInt(mm.raw);
  if (maintenance <= 0n) return { band: "UNKNOWN", ratio: null, reason: "Estimated maintenance is zero, so health is undefined." };
  const ratio = ratioText(equity.raw, mm.raw);
  const band = classify(BigInt(equity.raw), maintenance);
  return { band, ratio, reason: `Estimated ${band} from the hypothetical equity and maintenance. This is not the live protocol band.` };
}

function explain(
  book: IntelBook,
  rows: ScenarioResult["rows"],
  equity: Figure,
  mm: Figure,
  health: ScenarioResult["estimatedHealth"],
  scenario: Scenario,
): string[] {
  const lines = [
    book.band === "UNKNOWN"
      ? `The live account is UNKNOWN. ${book.bandReason}`
      : `The live account is ${book.band} because ${book.bandReason} That classification is a protocol read, not this scenario.`,
  ];
  const moved = rows.filter((row) => row.pnlChange.kind === "estimate" && row.pnlChange.raw !== "0");
  if (scenario.shockPools.length > 0) {
    lines.push(
      moved.length
        ? `The selected shock changes estimated unrealized PnL on ${moved.map((row) => row.symbol).join(", ")}. Funding is held constant, so that price PnL is also the equity change before any reduction or fee.`
        : "No shocked position produced an estimated PnL change.",
    );
  }
  if (equity.kind === "estimate" && mm.kind === "estimate") {
    lines.push(`Estimated equity would be ${equity.text} and estimated maintenance ${mm.text}. Health would read ${health.band}${health.ratio ? ` at ${health.ratio}×` : ""}. Neither number was read back from the protocol.`);
  } else {
    lines.push(`Estimated account health is UNKNOWN. ${health.reason}`);
  }
  return lines;
}

function leg(position: IntelPosition): PortfolioScan["legs"][number] {
  const size = signed(position.size);
  const direction = size < 0n ? "short" : "long";
  const shown = formatRaw(size < 0n ? -size : size, position.baseDecimals);
  if (!position.priceable || !position.mark || position.mark === "0") {
    return { symbol: position.symbol, pool: position.pool, direction, size: shown, notional: unknown("No usable mark."), pnl: unknown("No usable mark."), stale: true };
  }
  const observed = parseInt(position.observedNotional);
  const pnl = parseInt(position.observedPnl);
  return {
    symbol: position.symbol,
    pool: position.pool,
    direction,
    size: shown,
    notional: observed == null ? unknown("The protocol row did not include notional.") : protocol(observed, COLLATERAL_DECIMALS),
    pnl: pnl == null ? unknown("The protocol row did not include unrealized PnL.") : protocol(pnl, COLLATERAL_DECIMALS),
    stale: false,
  };
}

function summary(book: IntelBook, legs: PortfolioScan["legs"], largest: PortfolioScan["largest"], stale: boolean): string {
  if (legs.length === 0) return "No open position was returned, so there is no futures exposure to scan.";
  const priced = legs.filter((item) => item.notional.kind === "protocol").sort((a, b) => {
    const left = BigInt(a.notional.kind === "protocol" ? a.notional.raw : "0");
    const right = BigInt(b.notional.kind === "protocol" ? b.notional.raw : "0");
    return left > right ? -1 : 1;
  });
  const lead = priced[0] ? `${priced[0].symbol} is the largest priced position.` : "No position has a priced notional.";
  const health = book.band === "UNKNOWN" ? "Account health is UNKNOWN." : `Account health is ${book.band}.`;
  return `${health} ${lead} ${largest ? `${largest.symbol} is ${largest.share} of priced absolute notional.` : ""} ${stale ? "Missing marks are listed and were not treated as zero." : "Opposing longs and shorts are not netted."}`.replace(/\s+/g, " ").trim();
}

function metrics(size: bigint, entry: bigint, mark: bigint, oneBase: bigint, mmBps: bigint): { notional: bigint; pnl: bigint; mm: bigint } {
  const abs = size < 0n ? -size : size;
  const notional = (abs * mark) / oneBase;
  const pnl = size === 0n ? 0n : ((mark - entry) * size) / oneBase;
  return { notional, pnl, mm: divCeil(notional * mmBps, 10_000n) };
}

function matches(observed: string | null, computed: bigint): boolean {
  if (observed == null) return false;
  const value = parseInt(observed);
  return value === computed;
}

function classify(equity: bigint, mm: bigint): ShieldBand {
  const critical = scale(DEFAULT_THRESHOLDS.criticalBelow);
  const danger = scale(DEFAULT_THRESHOLDS.dangerBelow);
  const warning = scale(DEFAULT_THRESHOLDS.warningBelow);
  if (equity * 1_000_000n < mm * critical) return "CRITICAL";
  if (equity * 1_000_000n < mm * danger) return "DANGER";
  if (equity * 1_000_000n < mm * warning) return "WARNING";
  return "SAFE";
}

function scale(value: number): bigint {
  return BigInt(Math.round(value * 1_000_000));
}

function ratioText(equity: string | null, mm: string | null): string | null {
  const left = parseInt(equity);
  const right = parseInt(mm);
  if (left == null || right == null || right <= 0n) return null;
  const negative = left < 0n;
  const scaled = ((negative ? -left : left) * 1_000_000n) / right;
  const whole = scaled / 1_000_000n;
  const frac = (scaled % 1_000_000n).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${frac}`;
}

function bpsText(bps: bigint): string {
  const whole = bps / 100n;
  const frac = (bps % 100n).toString().padStart(2, "0");
  return `${whole.toString()}.${frac}%`;
}

function protocol(raw: bigint, decimals: number): Figure {
  return { kind: "protocol", raw: raw.toString(), text: formatRaw(raw, decimals) ?? "0" };
}

function estimate(raw: bigint, decimals: number): Figure {
  return { kind: "estimate", raw: raw.toString(), text: formatRaw(raw, decimals) ?? "0" };
}

function unknown(reason: string): Figure {
  return { kind: "unknown", reason };
}

function sum(values: bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

function signed(raw: string): bigint {
  return parseInt(raw) ?? 0n;
}

function parseInt(raw: string | null): bigint | null {
  if (raw == null || !/^-?\d+$/.test(raw)) return null;
  return BigInt(raw);
}

function formatRaw(raw: bigint, decimals: number): string | null {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, "0").slice(0, Math.min(decimals, 8)).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${frac.length > 0 ? `.${frac}` : ""}`;
}

function divCeil(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

function divFloor(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}
