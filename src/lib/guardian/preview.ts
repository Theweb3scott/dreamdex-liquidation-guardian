/** Dry-run protective order preview. No signer and no transaction.

 * Quantity is min(requested, abs(position), maxAllowed), all raw integers.
 */

import type { RiskBand } from "./monitor.ts";

export type PreviewState = "proposed" | "validated" | "simulated" | "rejected";

export type PreviewRequest = {
  account: string;
  market: string;
  pool: string;
  firstSize: string;
  freshSize: string;
  requestedReduction: string;
  maxAllowedReduction: string;
  openOrderIds: string[];
  band: RiskBand;
  ratio: string | null;
  blocksConsistent: boolean;
  healthAgrees: boolean;
  priceable: boolean;
  marginBlock: string;
  busy: boolean;
  rpcError: string | null;
};

export type DryRunPreview = {
  label: "DRY RUN ONLY";
  state: PreviewState;
  steps: PreviewState[];
  account: string;
  market: string;
  pool: string;
  positionDirection: "long" | "short" | "flat";
  currentSize: string;
  protectiveDirection: "sell" | "buy" | "none";
  isBid: boolean | null;
  proposedQuantity: string;
  reductionBps: string | null;
  block: string;
  healthRatio: string | null;
  risk: RiskBand;
  reason: string;
};

export function previewProtectiveOrder(input: PreviewRequest): DryRunPreview {
  const fresh = parseIntString(input.freshSize);
  const first = parseIntString(input.firstSize);
  const base = {
    label: "DRY RUN ONLY" as const,
    account: input.account,
    market: input.market,
    pool: input.pool,
    positionDirection: directionOf(fresh),
    currentSize: input.freshSize,
    protectiveDirection: "none" as const,
    isBid: null,
    proposedQuantity: "0",
    reductionBps: null,
    block: input.marginBlock,
    healthRatio: input.ratio,
    risk: input.band,
  };

  if (input.rpcError) {
    return finish(base, ["rejected"], `RPC failed. ${input.rpcError}`);
  }
  if (input.busy) {
    return finish(base, ["rejected"], "Another preview is being processed.");
  }
  if (fresh === null || first === null) {
    return finish(base, ["proposed", "rejected"], "Position size is not an integer.");
  }
  if (!input.priceable || input.band === "unpriced") {
    return finish(base, ["proposed", "rejected"], "Risk data is stale or the mark is unpriceable.");
  }
  if (!input.healthAgrees || input.band === "inconsistent") {
    return finish(base, ["proposed", "rejected"], "Account health is inconsistent.");
  }
  if (!input.blocksConsistent) {
    return finish(base, ["proposed", "rejected"], "Position and account blocks conflict.");
  }
  if (input.openOrderIds.length > 0) {
    return finish(base, ["proposed", "rejected"], "Open orders on this pool make the exposure uncertain.");
  }
  if (fresh === 0n) {
    return finish(base, ["proposed", "rejected"], "Position is closed. No protective order.");
  }
  if (sign(first) !== sign(fresh)) {
    return finish(base, ["proposed", "rejected"], "Position direction changed between the two reads.");
  }

  const requested = parseIntString(input.requestedReduction);
  const maxAllowed = parseIntString(input.maxAllowedReduction);
  if (requested === null || maxAllowed === null || requested < 0n || maxAllowed < 0n) {
    return finish(base, ["proposed", "rejected"], "Requested or max reduction is not a valid raw quantity.");
  }

  const abs = fresh < 0n ? -fresh : fresh;
  const quantity = min3(requested, abs, maxAllowed);
  const side = fresh > 0n ? "sell" : "buy";
  const sized = {
    ...base,
    positionDirection: directionOf(fresh),
    protectiveDirection: side as "sell" | "buy",
    isBid: fresh < 0n,
    proposedQuantity: quantity.toString(),
    reductionBps: ((quantity * 10_000n) / abs).toString(),
  };
  if (quantity === 0n) {
    return finish(sized, ["proposed", "rejected"], "Protective quantity is zero.");
  }
  const clamped = requested > quantity;
  const reason = clamped
    ? `Dry run only. Quantity clamped to ${quantity.toString()} raw base. Nothing was signed or sent.`
    : `Dry run only. ${side} ${quantity.toString()} raw base. Nothing was signed or sent.`;
  return finish(sized, ["proposed", "validated", "simulated"], reason);
}

export function rawPercent(abs: bigint, percent: bigint): bigint {
  if (percent < 0n || abs < 0n) return 0n;
  return (abs * percent) / 100n;
}

function finish(
  base: Omit<DryRunPreview, "state" | "steps" | "reason">,
  steps: PreviewState[],
  reason: string,
): DryRunPreview {
  return { ...base, state: steps[steps.length - 1] ?? "rejected", steps, reason };
}

function min3(a: bigint, b: bigint, c: bigint): bigint {
  return a < b ? (a < c ? a : c) : b < c ? b : c;
}

function sign(value: bigint): -1 | 0 | 1 {
  if (value > 0n) return 1;
  if (value < 0n) return -1;
  return 0;
}

function directionOf(size: bigint | null): "long" | "short" | "flat" {
  if (size === null || size === 0n) return "flat";
  return size > 0n ? "long" : "short";
}

function parseIntString(value: string): bigint | null {
  if (!/^-?\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}
