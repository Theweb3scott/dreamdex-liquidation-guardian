/** Guardian Shield view model. Display only. No orders, grants, or invented prices. */

import { assessAccount, type AccountSnapshot, type LiquidationQuote, type RiskBand } from "./monitor.ts";
import { PLACE_ORDER_FOR_SELECTOR } from "./stop-preview.ts";

export type ShieldBand = "SAFE" | "WARNING" | "DANGER" | "CRITICAL" | "UNKNOWN";

export type ActivityKind = "verified" | "observed" | "local";

export type ActivityEvent = {
  id: string;
  kind: ActivityKind;
  title: string;
  detail: string;
};

export type ShieldStop = {
  orderId: string;
  live: boolean | null;
  intent: "reduceOnly" | "opening" | null;
  isBid: boolean | null;
  triggerOperator: number | null;
  quantity: string | null;
  triggerPrice: string | null;
  somiPaid: string | null;
};

export type ShieldPermission = {
  readable: boolean;
  registry: string | null;
  operatorRegistry: string | null;
  resolvedAuthorized: boolean | null;
  globalApproved: boolean | null;
  poolApproved: boolean | null;
  somiPayment: string | null;
};

export type ShieldPositionInput = {
  symbol: string;
  pool: string;
  baseDecimals: number;
  priceable: boolean;
  poolPriceable: boolean;
  size: string;
  entry: string | null;
  mark: string | null;
  pnl: string | null;
  asOfBlock: string;
  liquidationPrice: LiquidationQuote;
  lotSize: string | null;
  minQuantity: string | null;
  stopsReadable: boolean;
  stops: ShieldStop[];
  permission: ShieldPermission;
  plan: {
    ok: boolean;
    reason: string;
    quantity: string | null;
    triggerPrice: string | null;
    somiWei: string | null;
  };
};

export type ShieldInput = {
  address: string;
  chainId: number;
  deploymentId: string;
  refreshedAt: string;
  account: AccountSnapshot;
  positions: ShieldPositionInput[];
};

export type ProtectionState = "unknown" | "none" | "active" | "partial" | "conflict" | "unsuitable";

export type ShieldPosition = {
  symbol: string;
  pool: string;
  direction: "long" | "short" | "flat";
  size: string | null;
  entry: string | null;
  mark: string | null;
  pnl: string | null;
  liquidation: string | null;
  liquidationNote: string | null;
  distance: string | null;
  protection: { state: ProtectionState; reason: string };
  coverage: string | null;
  stops: Array<{
    orderId: string;
    direction: "buy" | "sell" | "unknown";
    trigger: string | null;
    quantity: string | null;
    somiPaid: string | null;
    intent: string;
    live: "live" | "not-live" | "unverified";
  }>;
  permission: {
    registry: string | null;
    operatorRegistry: string | null;
    selector: typeof PLACE_ORDER_FOR_SELECTOR;
    scope: "one pool, one selector";
    poolApproved: boolean | null;
    globalApproved: boolean | null;
    required: boolean;
    revokeRecommended: boolean;
    warning: string | null;
  };
  plan: {
    needed: boolean | null;
    reason: string;
    quantity: string | null;
    trigger: string | null;
    minQuantity: string | null;
    lotSize: string | null;
    somiWei: string | null;
  };
};

export type ShieldModel = {
  signingReachable: false;
  submissionEnabled: false;
  address: string;
  chainId: number;
  network: string;
  deploymentId: string;
  refreshedAt: string;
  band: ShieldBand;
  bandReason: string;
  equity: string | null;
  maintenance: string | null;
  healthRatio: string | null;
  warnings: string[];
  positions: ShieldPosition[];
};

const HELP = {
  health: "Margin health is account equity divided by the protocol maintenance requirement. It is cross-margin, not a separate score per position.",
  distance: "Distance is how far the mark is from a positive protocol liquidation price. A reported price of 0 is a floor, not a level.",
  reduceOnly: "A reduce-only stop is createPendingOrder. When it fires, the registry may only shrink the position. An immediate IOC order is not used as a substitute.",
  trigger: "A long is protected by a sell that fires if the mark falls to the trigger. A short is protected by a buy that fires if the mark rises to it.",
  permission: "The stop registry needs placeOrderFor on this pool only. A global grant also covers every other registered pool, including pools added later.",
  somi: "Each pending stop prepays native SOMI for the trigger. An owner cancel refunds it. A fire consumes it even if the reduce-only order is dropped.",
} as const;

export function shieldHelp(): typeof HELP {
  return HELP;
}

export function displayBand(band: RiskBand): ShieldBand {
  if (band === "clear") return "SAFE";
  if (band === "warning") return "WARNING";
  if (band === "danger") return "DANGER";
  if (band === "critical") return "CRITICAL";
  return "UNKNOWN";
}

export function shieldLayout(width: number): { mobile: boolean; columns: 1 | 2; sections: string[] } {
  return {
    mobile: width < 640,
    columns: width < 640 ? 1 : 2,
    sections: ["account", "warnings", "positions", "portfolio", "what-if", "permissions", "protection", "activity", "help"],
  };
}

export function buildShield(input: ShieldInput): ShieldModel {
  const assessment = assessAccount(input.account);
  const band = displayBand(assessment.band);
  const warnings: string[] = [];
  if (band === "UNKNOWN") warnings.push(assessment.reason);
  const views = new Map(assessment.positions.map((position) => [position.symbol, position]));
  const positions = input.positions
    .filter((position) => position.size !== "0" && position.size !== "")
    .map((position) => projectPosition(position, views.get(position.symbol)));
  if (positions.some((position) => position.permission.globalApproved)) {
    warnings.push("A global operator grant is active. It is broader than this pool.");
  }
  if (positions.some((position) => !position.permission.registry)) {
    warnings.push("A pool has no stop registry. Protection cannot be prepared there.");
  }
  return {
    signingReachable: false,
    submissionEnabled: false,
    address: input.address,
    chainId: input.chainId,
    network: `Hideki v2 · chain ${input.chainId}`,
    deploymentId: input.deploymentId,
    refreshedAt: input.refreshedAt,
    band,
    bandReason: assessment.reason,
    equity: human(assessment.equity, 18),
    maintenance: human(assessment.mmReq, 18),
    healthRatio: assessment.ratio,
    warnings,
    positions,
  };
}

export function classifyProtection(position: ShieldPositionInput): { state: ProtectionState; reason: string; coverage: string | null } {
  if (!position.stopsReadable) {
    return { state: "unknown", reason: "The stop registry could not be read. Protection is not assumed.", coverage: null };
  }
  if (position.stops.some((stop) => stop.live == null)) {
    return { state: "unknown", reason: "A stop's live flag was not read. It is not treated as active or executed.", coverage: null };
  }
  const live = position.stops.filter((stop) => stop.live === true);
  if (live.length === 0) {
    const listed = position.stops.length > 0;
    return {
      state: "none",
      reason: listed
        ? "A stop was listed, but it is not live on the registry. That is not a verified execution or cancellation."
        : "No live pending stop on this pool.",
      coverage: "none",
    };
  }
  if (live.some((stop) => stop.intent == null || stop.isBid == null)) {
    return { state: "unknown", reason: "A live stop has an unknown intent or side.", coverage: null };
  }
  const size = parseInt(position.size);
  const direction = size == null ? "flat" : size > 0n ? "long" : size < 0n ? "short" : "flat";
  const protectiveBid = direction === "short";
  const wrong = live.filter((stop) => stop.isBid !== protectiveBid);
  const right = live.filter((stop) => stop.isBid === protectiveBid);
  if (direction === "flat") {
    return { state: "unsuitable", reason: "A stop is still listed, but the position is flat. Removal was not verified.", coverage: null };
  }
  if (wrong.length > 0 && right.length > 0) {
    return { state: "conflict", reason: "Live stops point both with and against the position.", coverage: null };
  }
  if (wrong.length > 0) {
    return { state: "conflict", reason: "A live stop would trade the same direction as the position, so it is not protection.", coverage: null };
  }
  const reducers = right.filter((stop) => stop.intent === "reduceOnly");
  if (reducers.length === 0) {
    return { state: "none", reason: "The live stop can open exposure. It is not reduce-only protection.", coverage: "none" };
  }
  if (reducers.length > 1) {
    return { state: "conflict", reason: "More than one live reduce-only stop covers this side.", coverage: null };
  }
  const stop = reducers[0];
  if (!stop) return { state: "unknown", reason: "Stop row missing.", coverage: null };
  const mark = position.mark ? parseInt(position.mark) : null;
  const trigger = stop.triggerPrice ? parseInt(stop.triggerPrice) : null;
  if (!mark || mark <= 0n || !trigger || trigger <= 0n || stop.triggerOperator == null) {
    return { state: "unknown", reason: "Mark or trigger is missing, so the stop cannot be judged.", coverage: null };
  }
  const crossed = direction === "long" ? stop.triggerOperator === 1 && trigger >= mark : stop.triggerOperator === 0 && trigger <= mark;
  const wrongOperator = direction === "long" ? stop.triggerOperator !== 1 : stop.triggerOperator !== 0;
  if (wrongOperator || crossed) {
    return { state: "unsuitable", reason: "The trigger is on the wrong side of the mark, or it has already been crossed.", coverage: null };
  }
  const qty = stop.quantity ? parseInt(stop.quantity) : null;
  const abs = size == null ? null : size < 0n ? -size : size;
  if (qty == null || abs == null || abs === 0n) {
    return { state: "unknown", reason: "Quantity could not be compared with the position.", coverage: null };
  }
  if (qty === 0n) return { state: "active", reason: "Reduce-only stop uses the whole position at trigger time.", coverage: "whole position at trigger" };
  if (qty < abs) {
    return { state: "partial", reason: "The fixed stop quantity is smaller than the current position.", coverage: percent(qty, abs) };
  }
  return { state: "active", reason: "A live reduce-only stop covers this position.", coverage: percent(qty, abs) };
}

export function diffShield(previous: ShieldModel | null, next: ShieldModel): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  if (!previous) {
    events.push(event("observed", "refresh", `Read ${next.address} on ${next.network}.`));
  } else if (previous.band !== next.band) {
    events.push(event("observed", "band", `Risk band changed from ${previous.band} to ${next.band}. ${next.bandReason}`));
  }
  const before = stopsOf(previous);
  const after = stopsOf(next);
  for (const id of before) {
    if (!after.has(id)) {
      events.push(event("observed", `missing-${id}`, `Stop ${id} is no longer listed. This was not verified as a cancellation or an execution.`));
    }
  }
  for (const id of after) {
    if (!before.has(id)) events.push(event("observed", `seen-${id}`, `Pending stop ${id} is listed.`));
  }
  const prevPerm = permissionKey(previous);
  const nextPerm = permissionKey(next);
  if (previous && prevPerm !== nextPerm) {
    events.push(event("observed", "permission", "Operator permission status changed since the last read."));
  }
  if (previous) {
    for (const position of next.positions) {
      const prior = previous.positions.find((item) => item.pool === position.pool);
      if (prior && prior.direction !== "flat" && prior.direction !== position.direction) {
        events.push(event("observed", `flip-${position.pool}`, `${position.symbol} changed from ${prior.direction} to ${position.direction}. Existing protection was not verified.`));
      }
    }
  }
  return events;
}

export function localPreviewEvent(model: ShieldModel): ActivityEvent {
  return event("local", "preview", `Prepared a local protection preview for ${model.address}. Nothing was signed or submitted.`);
}

function projectPosition(position: ShieldPositionInput, view: { liquidation: { kind: string; price?: string; distance?: string; reason?: string } } | undefined): ShieldPosition {
  const size = parseInt(position.size);
  const direction = size == null ? "flat" : size > 0n ? "long" : size < 0n ? "short" : "flat";
  const judged = classifyProtection(position);
  const liquidation = liquidationFields(position, view?.liquidation);
  const permissionWarning = !position.permission.readable
    ? "Operator permission could not be read."
    : position.permission.globalApproved
      ? "Global approval is on. Revoking only this pool would leave it in force."
      : null;
  const needed = !position.plan.ok || judged.state === "unknown" ? null : judged.state !== "active";
  return {
    symbol: position.symbol,
    pool: position.pool,
    direction,
    size: human(position.size, position.baseDecimals),
    entry: position.entry && position.entry !== "0" ? human(position.entry, 18) : null,
    mark: position.priceable && position.mark ? human(position.mark, 18) : null,
    pnl: position.priceable && position.pnl != null ? human(position.pnl, 18) : null,
    liquidation: liquidation.price,
    liquidationNote: liquidation.note,
    distance: liquidation.distance,
    protection: { state: judged.state, reason: judged.reason },
    coverage: judged.coverage,
    stops: position.stops.map((stop) => ({
      orderId: stop.orderId,
      direction: stop.isBid == null ? "unknown" : stop.isBid ? "buy" : "sell",
      trigger: stop.triggerPrice ? human(stop.triggerPrice, 18) : null,
      quantity: stop.quantity,
      somiPaid: stop.somiPaid,
      intent: stop.intent ?? "unknown",
      live: stop.live == null ? "unverified" : stop.live ? "live" : "not-live",
    })),
    permission: {
      registry: position.permission.registry,
      operatorRegistry: position.permission.operatorRegistry,
      selector: PLACE_ORDER_FOR_SELECTOR,
      scope: "one pool, one selector",
      poolApproved: position.permission.readable ? position.permission.poolApproved : null,
      globalApproved: position.permission.readable ? position.permission.globalApproved : null,
      required: position.permission.readable ? position.permission.resolvedAuthorized === false : true,
      revokeRecommended: position.permission.globalApproved === true,
      warning: permissionWarning,
    },
    plan: {
      needed,
      reason: position.plan.reason,
      quantity: position.plan.quantity,
      trigger: position.plan.triggerPrice,
      minQuantity: position.minQuantity,
      lotSize: position.lotSize,
      somiWei: position.plan.somiWei ?? position.permission.somiPayment,
    },
  };
}

function liquidationFields(
  position: ShieldPositionInput,
  view: { kind: string; price?: string; distance?: string; reason?: string } | undefined,
): { price: string | null; note: string | null; distance: string | null } {
  if (!position.priceable || !position.poolPriceable) {
    return { price: null, note: "Mark is unpriceable or stale. No liquidation distance is shown.", distance: null };
  }
  if ("error" in position.liquidationPrice) {
    return { price: null, note: position.liquidationPrice.error, distance: null };
  }
  if (position.liquidationPrice.price === "0") {
    return { price: null, note: "Protocol liquidation price is 0. That is a floor, not a price.", distance: null };
  }
  if (view?.kind === "level" && view.price && view.distance) {
    return { price: view.price, note: null, distance: view.distance };
  }
  return { price: null, note: "Protocol liquidation price was not a usable level.", distance: null };
}

function stopsOf(model: ShieldModel | null): Set<string> {
  return new Set((model?.positions ?? []).flatMap((position) => position.stops.map((stop) => stop.orderId)));
}

function permissionKey(model: ShieldModel | null): string {
  return (model?.positions ?? [])
    .map((position) => `${position.pool}:${position.permission.poolApproved}:${position.permission.globalApproved}`)
    .join("|");
}

function event(kind: ActivityKind, id: string, detail: string): ActivityEvent {
  return { id, kind, title: kind, detail };
}

function percent(part: bigint, whole: bigint): string {
  const scaled = (part * 10_000n) / whole;
  const wholePct = scaled / 100n;
  const frac = (scaled % 100n).toString().padStart(2, "0");
  return `${wholePct}.${frac}% of current size`;
}

function human(raw: string, decimals: number): string | null {
  const value = parseInt(raw);
  if (value == null) return null;
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const fracFull = (abs % scale).toString().padStart(decimals, "0").slice(0, Math.min(decimals, 8));
  const frac = fracFull.replace(/0+$/, "");
  const body = frac.length > 0 ? `${whole.toString()}.${frac}` : whole.toString();
  return `${negative ? "-" : ""}${body}`;
}

function parseInt(raw: string | null): bigint | null {
  if (raw == null || !/^-?\d+$/.test(raw)) return null;
  return BigInt(raw);
}
