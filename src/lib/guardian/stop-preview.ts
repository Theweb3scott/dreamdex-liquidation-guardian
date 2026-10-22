/** Unsigned reduce-only stop plan. Nothing here grants, signs, or arms a stop. */

import { HIDEKI_V2_ID, QUOTE_TTL_MS } from "./review.ts";

export const PLACE_ORDER_FOR_SELECTOR = "0x80054449";

export type KnownStop = {
  orderId: string;
  live: boolean;
  intent: "reduceOnly" | "opening" | null;
  isBid: boolean;
  triggerOperator: number;
  quantity: string;
  triggerPrice: string;
};

export type StopPreviewInput = {
  deploymentId: string;
  wallet: string;
  market: string;
  pool: string;
  registry: string | null;
  operatorRegistry: string | null;
  positionSize: bigint;
  mark: bigint;
  liquidation: bigint | null;
  tickSize: bigint;
  lotSize: bigint;
  minQuantity: bigint;
  reducingCapacity: bigint;
  requestedQuantity: bigint | null;
  somiPayment: bigint | null;
  resolvedAuthorized: boolean | null;
  globalApproved: boolean | null;
  poolApproved: boolean | null;
  existingStops: KnownStop[];
  stopsReadable: boolean;
  priceable: boolean;
  healthAgrees: boolean;
  quotedAt: number;
  now: number;
};

export type StopStep = {
  id: "approve" | "create" | "monitor" | "cancel" | "revoke";
  title: string;
  detail: string;
  signingReachable: false;
};

export type StopPreview = {
  ok: boolean;
  reason: string;
  signingReachable: false;
  submissionEnabled: false;
  warnings: string[];
  market: string;
  pool: string;
  direction: "sell" | "buy" | "none";
  isBid: boolean | null;
  triggerOperator: 0 | 1 | null;
  triggerRule: "LTE" | "GTE" | null;
  triggerPrice: string | null;
  quantity: string | null;
  orderType: "MARKET";
  intent: "reduceOnly";
  createFunction: "createPendingOrder";
  somiWei: string | null;
  operator: {
    address: string | null;
    selector: typeof PLACE_ORDER_FOR_SELECTOR;
    selectorName: "placeOrderFor";
    scope: "one pool, one selector";
    grantFunction: "setOperatorApprovalForPool";
    revokeFunction: "setOperatorApprovalForPool" | "setOperatorApprovalGlobal";
    currentlyAuthorized: boolean | null;
    globalApproved: boolean | null;
    poolApproved: boolean | null;
    globalGrantRefused: true;
  };
  steps: StopStep[];
};

const WARNINGS = [
  "This preview does not sign, grant, or arm a stop.",
  "createPendingOrder is reduce-only. A later fire can still consume the prepaid SOMI if the position is already closed.",
  "Quantity zero means the whole position at trigger time. This preview never uses that sentinel.",
];

export function previewProtectiveStop(input: StopPreviewInput): StopPreview {
  const shell = emptyPreview(input);
  const fail = (reason: string): StopPreview => ({ ...shell, ok: false, reason });
  if (input.deploymentId !== HIDEKI_V2_ID) return fail("The quote is not bound to the Hideki v2 deployment.");
  if (input.now - input.quotedAt > QUOTE_TTL_MS) return fail("The stop quote is stale.");
  if (!input.priceable || !input.healthAgrees || input.mark <= 0n) return fail("The mark or account health cannot price a trigger.");
  if (!input.registry) return fail("This pool has no stop registry.");
  if (!input.operatorRegistry) return fail("This pool has no operator-permission registry.");
  if (!input.stopsReadable || input.resolvedAuthorized == null || input.globalApproved == null || input.poolApproved == null) {
    return fail("Existing stops or the operator grant could not be read. No stop is proposed.");
  }
  if (input.somiPayment == null || input.somiPayment <= 0n) return fail("The registry did not report a SOMI payment.");

  const terms = protectiveTerms({
    positionSize: input.positionSize,
    mark: input.mark,
    liquidation: input.liquidation,
    tickSize: input.tickSize,
  });
  if (!terms.ok) return fail(terms.reason);

  const sized = protectiveQuantity({
    positionSize: input.positionSize,
    requested: input.requestedQuantity,
    capacity: input.reducingCapacity,
    lotSize: input.lotSize,
    minQuantity: input.minQuantity,
  });
  if (!sized.ok) return fail(sized.reason);

  const duplicate = input.existingStops.find((stop) => stop.live && sameSide(stop.isBid, terms.isBid));
  if (duplicate && duplicate.intent == null) return fail("A live stop has an unknown intent. Upgrade the SDK before adding another.");
  if (duplicate && duplicate.intent !== "opening") return fail("A live reduce-only stop already covers this side.");

  const revokeFunction = input.globalApproved ? "setOperatorApprovalGlobal" : "setOperatorApprovalForPool";
  const warnings = [...WARNINGS];
  if (input.globalApproved) {
    warnings.push("A global grant is already on. Revoking only the per-pool slot would leave it in force.");
  }
  if (!input.resolvedAuthorized) {
    warnings.push("The registry cannot place until you separately approve it for this pool and this selector.");
  }

  return {
    ...shell,
    ok: true,
    reason: "Stop plan only. Nothing was armed.",
    warnings,
    direction: terms.direction,
    isBid: terms.isBid,
    triggerOperator: terms.triggerOperator,
    triggerRule: terms.triggerOperator === 1 ? "LTE" : "GTE",
    triggerPrice: terms.triggerPrice.toString(),
    quantity: sized.quantity.toString(),
    somiWei: input.somiPayment.toString(),
    operator: {
      ...shell.operator,
      address: input.registry,
      revokeFunction,
      currentlyAuthorized: input.resolvedAuthorized,
      globalApproved: input.globalApproved,
      poolApproved: input.poolApproved,
    },
    steps: steps({
      registry: input.registry,
      operatorRegistry: input.operatorRegistry,
      pool: input.pool,
      authorized: input.resolvedAuthorized,
      globalApproved: input.globalApproved,
      somi: input.somiPayment,
      quantity: sized.quantity,
      trigger: terms.triggerPrice,
      isBid: terms.isBid,
      operatorCode: terms.triggerOperator,
    }),
  };
}

export function protectiveTerms(input: {
  positionSize: bigint;
  mark: bigint;
  liquidation: bigint | null;
  tickSize: bigint;
}):
  | { ok: true; isBid: boolean; direction: "buy" | "sell"; triggerOperator: 0 | 1; triggerPrice: bigint }
  | { ok: false; reason: string } {
  if (input.positionSize === 0n) return { ok: false, reason: "There is no position to protect." };
  if (input.liquidation == null || input.liquidation <= 0n) {
    return { ok: false, reason: "Liquidation price is not a usable level." };
  }
  const long = input.positionSize > 0n;
  const lower = long ? input.liquidation : input.mark;
  const upper = long ? input.mark : input.liquidation;
  if (lower >= upper) return { ok: false, reason: "There is no trigger between the mark and liquidation." };
  const mid = (lower + upper) / 2n;
  const tick = input.tickSize > 0n ? input.tickSize : 1n;
  let price = (mid / tick) * tick;
  if (price <= lower) price += tick;
  if (price >= upper) return { ok: false, reason: "No tick fits between the mark and liquidation." };
  return {
    ok: true,
    isBid: !long,
    direction: long ? "sell" : "buy",
    triggerOperator: long ? 1 : 0,
    triggerPrice: price,
  };
}

export function protectiveQuantity(input: {
  positionSize: bigint;
  requested: bigint | null;
  capacity: bigint;
  lotSize: bigint;
  minQuantity: bigint;
}): { ok: true; quantity: bigint } | { ok: false; reason: string } {
  if (input.requested === 0n) return { ok: false, reason: "Quantity zero is the whole-position sentinel and is refused." };
  const abs = input.positionSize < 0n ? -input.positionSize : input.positionSize;
  const lot = input.lotSize > 0n ? input.lotSize : 1n;
  const requested = input.requested == null ? input.minQuantity : input.requested;
  if (requested < 0n) return { ok: false, reason: "Quantity must be a non-negative integer." };
  let quantity = requested < abs ? requested : abs;
  if (quantity > input.capacity) quantity = input.capacity;
  quantity = (quantity / lot) * lot;
  if (quantity < input.minQuantity || quantity <= 0n) return { ok: false, reason: "The aligned quantity is below the pool minimum." };
  return { ok: true, quantity };
}

function sameSide(isBid: boolean, protectiveIsBid: boolean): boolean {
  return isBid === protectiveIsBid;
}

function emptyPreview(input: StopPreviewInput): StopPreview {
  return {
    ok: false,
    reason: "",
    signingReachable: false,
    submissionEnabled: false,
    warnings: WARNINGS,
    market: input.market,
    pool: input.pool,
    direction: "none",
    isBid: null,
    triggerOperator: null,
    triggerRule: null,
    triggerPrice: null,
    quantity: null,
    orderType: "MARKET",
    intent: "reduceOnly",
    createFunction: "createPendingOrder",
    somiWei: input.somiPayment?.toString() ?? null,
    operator: {
      address: input.registry,
      selector: PLACE_ORDER_FOR_SELECTOR,
      selectorName: "placeOrderFor",
      scope: "one pool, one selector",
      grantFunction: "setOperatorApprovalForPool",
      revokeFunction: input.globalApproved ? "setOperatorApprovalGlobal" : "setOperatorApprovalForPool",
      currentlyAuthorized: input.resolvedAuthorized,
      globalApproved: input.globalApproved,
      poolApproved: input.poolApproved,
      globalGrantRefused: true,
    },
    steps: [],
  };
}

function steps(input: {
  registry: string;
  operatorRegistry: string;
  pool: string;
  authorized: boolean;
  globalApproved: boolean;
  somi: bigint;
  quantity: bigint;
  trigger: bigint;
  isBid: boolean;
  operatorCode: 0 | 1;
}): StopStep[] {
  const approve: StopStep = {
    id: "approve",
    title: input.authorized ? "Approval already resolved" : "Approve, as its own transaction",
    detail: input.authorized
      ? "The pool already resolves placeOrderFor for this registry. This preview does not change that."
      : `setOperatorApprovalForPool on ${input.operatorRegistry}: pool ${input.pool}, operator ${input.registry}, selector ${PLACE_ORDER_FOR_SELECTOR}, approved true. Not signed.`,
    signingReachable: false,
  };
  const create: StopStep = {
    id: "create",
    title: "Create the reduce-only stop, as its own transaction",
    detail: `createPendingOrder on ${input.registry}. ${input.isBid ? "Buy" : "Sell"} ${input.quantity.toString()} if mark ${input.operatorCode === 1 ? "falls to or below" : "rises to or above"} ${input.trigger.toString()}. Market order, no limit. Prepaid SOMI ${input.somi.toString()} wei. Not signed.`,
    signingReachable: false,
  };
  return [
    approve,
    create,
    {
      id: "monitor",
      title: "Monitor the live flag",
      detail: "Read getPendingOrder. A stored id can look plausible after it dies, so only the live flag counts. Not a transaction.",
      signingReachable: false,
    },
    {
      id: "cancel",
      title: "Cancel, as its own transaction",
      detail: "cancelPendingOrder refunds the SOMI to the owner when the transfer succeeds. A fire consumes it even if the reduce-only order is dropped. Not signed.",
      signingReachable: false,
    },
    {
      id: "revoke",
      title: "Revoke, as its own transaction",
      detail: input.globalApproved
        ? "A global slot is set. Clearing it requires setOperatorApprovalGlobal with approved false for this registry and selector. A per-pool revoke would not remove it. Not signed."
        : "setOperatorApprovalForPool with approved false, same pool, registry, and selector. Not signed.",
      signingReachable: false,
    },
  ];
}
