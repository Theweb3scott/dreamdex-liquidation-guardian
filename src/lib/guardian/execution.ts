/** Unsigned execution journal.

 * Signing states are reached only when `confirm` is given an authorized adapter.
 * This application does not construct that adapter.
 */

import type { RiskBand } from "./monitor.ts";

export type ExecState =
  | "proposed"
  | "validated"
  | "awaiting_confirmation"
  | "submitted"
  | "receipt_pending"
  | "verified"
  | "failed"
  | "outcome_unknown";

export type ExecMode = "demo" | "protection";

export type ExecRecord = {
  intentId: string;
  state: ExecState;
  reason: string;
  hash: string | null;
  quantity: string;
  filled: string | null;
  sizeBefore: string;
  sizeAfter: string | null;
  mode: ExecMode;
};

export type Journal = {
  version: 1;
  disarmed: boolean;
  lockIntentId: string | null;
  records: ExecRecord[];
};

export type ExecutionAdapter = {
  authorized: true;
  submit: (intentId: string) => Promise<{ hash: string } | { unknown: true; hash: string | null } | { error: string }>;
};

export type ProposeInput = {
  mode: ExecMode;
  account: string;
  market: string;
  pool: string;
  band: RiskBand;
  ratio: string | null;
  priceable: boolean;
  healthAgrees: boolean;
  blocksConsistent: boolean;
  includeWarning: boolean;
  firstSize: string;
  freshSize: string;
  requestedReduction: string;
  maxAllowedReduction: string;
  openOrderIds: string[];
  marginBlock: string;
  rpcError: string | null;
  timedOut: boolean;
};

export type Proposal = {
  label: "DEMONSTRATION ONLY" | "PROTECTION PREVIEW — NOT SENT";
  state: ExecState;
  reason: string;
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
  intentId: string | null;
  signingReachable: false;
};

const SIGNING: ReadonlySet<ExecState> = new Set(["submitted", "receipt_pending", "verified", "outcome_unknown"]);

export function emptyJournal(): Journal {
  return { version: 1, disarmed: false, lockIntentId: null, records: [] };
}

export function serializeJournal(journal: Journal): string {
  return JSON.stringify(journal);
}

export function restoreJournal(raw: string): Journal {
  const parsed = JSON.parse(raw) as Journal;
  if (parsed.version !== 1 || !Array.isArray(parsed.records) || typeof parsed.disarmed !== "boolean") {
    throw new Error("Unreadable execution journal.");
  }
  return parsed;
}

export function disarm(journal: Journal): Journal {
  const records = journal.records.map((record) => {
    if (record.intentId !== journal.lockIntentId) return record;
    if (record.state === "awaiting_confirmation") {
      return { ...record, state: "failed" as const, reason: "Disarmed before send. Nothing was broadcast." };
    }
    if (record.state === "receipt_pending" || record.state === "outcome_unknown" || record.state === "submitted") {
      return {
        ...record,
        reason: `${record.reason} Disarmed. The unresolved transaction was not cancelled.`,
      };
    }
    return record;
  });
  const locked = records.find((record) => record.intentId === journal.lockIntentId);
  const keepLock = locked ? SIGNING.has(locked.state) : false;
  return {
    ...journal,
    disarmed: true,
    lockIntentId: keepLock ? journal.lockIntentId : null,
    records,
  };
}

export function propose(journal: Journal, input: ProposeInput): { journal: Journal; proposal: Proposal } {
  const label = input.mode === "demo" ? "DEMONSTRATION ONLY" : "PROTECTION PREVIEW — NOT SENT";
  const shell = blank(input, label);

  if (journal.disarmed) {
    return refuse(journal, shell, "Disarmed. No new preview.");
  }
  const locked = journal.records.find((record) => record.intentId === journal.lockIntentId);
  if (locked && (locked.state === "awaiting_confirmation" || SIGNING.has(locked.state))) {
    return refuse(journal, shell, "Pending work blocks a new order. Reconcile or disarm the open preview first.");
  }
  if (input.timedOut) {
    return refuse(journal, shell, "RPC timed out. Nothing was sent.");
  }
  if (input.rpcError) {
    return refuse(journal, shell, `RPC failed. ${input.rpcError}`);
  }
  if (!input.priceable || input.band === "unpriced") {
    return refuse(journal, shell, "Stale or unpriceable data. No proposal.");
  }
  if (!input.healthAgrees || !input.blocksConsistent || input.band === "inconsistent" || input.band === "incomparable") {
    return refuse(journal, shell, "Inconsistent snapshot. No proposal.");
  }
  if (input.mode === "protection") {
    if (input.band === "clear") return refuse(journal, shell, "Healthy account is not eligible for protection.");
    if (input.band === "warning" && !input.includeWarning) {
      return refuse(journal, shell, "Warning is not a protection trigger unless that option is explicitly on.");
    }
    if (input.band !== "danger" && input.band !== "critical" && !(input.band === "warning" && input.includeWarning)) {
      return refuse(journal, shell, "Protection is only proposed at danger or critical.");
    }
  }
  if (input.openOrderIds.length > 0) {
    return refuse(journal, shell, "Pending orders make the exposure uncertain.");
  }

  const first = parseInt(input.firstSize);
  const fresh = parseInt(input.freshSize);
  const requested = parseInt(input.requestedReduction);
  const maxAllowed = parseInt(input.maxAllowedReduction);
  if (first === null || fresh === null || requested === null || maxAllowed === null) {
    return refuse(journal, shell, "Position or reduction is not an integer.");
  }
  if (fresh === 0n) return refuse(journal, { ...shell, positionDirection: "flat" }, "Position is closed.");
  if (sign(first) !== sign(fresh)) {
    return refuse(journal, shell, "Position direction changed before execution.");
  }
  if (requested < 0n || maxAllowed < 0n) return refuse(journal, shell, "Reduction limits must be non-negative.");

  const abs = fresh < 0n ? -fresh : fresh;
  const quantity = requested < abs ? (requested < maxAllowed ? requested : maxAllowed) : abs < maxAllowed ? abs : maxAllowed;
  if (quantity === 0n) return refuse(journal, shell, "Protective quantity is zero.");

  const side = fresh > 0n ? "sell" : "buy";
  const intentId = `${input.account.toLowerCase()}:${input.pool.toLowerCase()}:${fresh.toString()}:${quantity.toString()}:${side}`;
  if (journal.records.some((record) => record.intentId === intentId && record.state !== "failed")) {
    return refuse(journal, shell, "Duplicate intent. This order was already proposed.");
  }

  const proposal: Proposal = {
    ...shell,
    state: "awaiting_confirmation",
    reason:
      input.mode === "demo"
        ? "Demonstration only. Waiting would still not send. No adapter is installed."
        : "Protection preview only. Danger or critical was crossed. Nothing was sent.",
    positionDirection: fresh > 0n ? "long" : "short",
    currentSize: fresh.toString(),
    protectiveDirection: side,
    isBid: fresh < 0n,
    proposedQuantity: quantity.toString(),
    reductionBps: ((quantity * 10_000n) / abs).toString(),
    intentId,
    signingReachable: false,
  };
  const record: ExecRecord = {
    intentId,
    state: "awaiting_confirmation",
    reason: proposal.reason,
    hash: null,
    quantity: quantity.toString(),
    filled: null,
    sizeBefore: fresh.toString(),
    sizeAfter: null,
    mode: input.mode,
  };
  return {
    journal: { ...journal, lockIntentId: intentId, records: [...journal.records, record].slice(-20) },
    proposal,
  };
}

/** Test seam. Production code must pass `null` and therefore cannot leave `awaiting_confirmation`. */
export function confirm(
  journal: Journal,
  intentId: string,
  sizeNow: string,
  adapter: ExecutionAdapter | null,
): Promise<{ journal: Journal; state: ExecState; reason: string; signingReachable: boolean }> {
  const record = journal.records.find((item) => item.intentId === intentId);
  if (!record || record.state !== "awaiting_confirmation") {
    return Promise.resolve({ journal, state: record?.state ?? "failed", reason: "Nothing is awaiting confirmation.", signingReachable: false });
  }
  if (journal.disarmed) {
    return Promise.resolve({ journal, state: "awaiting_confirmation", reason: "Disarmed. Not sent.", signingReachable: false });
  }
  if (sizeNow !== record.sizeBefore) {
    return Promise.resolve(fail(journal, record, "Position changed before execution. Not sent."));
  }
  if (!adapter) {
    return Promise.resolve({
      journal,
      state: "awaiting_confirmation",
      reason: "No execution adapter is installed. Not sent.",
      signingReachable: false,
    });
  }
  return adapter.submit(intentId).then((result) => {
    if ("error" in result) return fail(journal, record, `Submit refused. ${result.error}`);
    if ("unknown" in result) {
      return {
        journal: replace(journal, { ...record, state: "outcome_unknown", hash: result.hash, reason: "Transaction outcome is unknown. Do not retry." }),
        state: "outcome_unknown" as const,
        reason: "Transaction outcome is unknown. Do not retry.",
        signingReachable: true,
      };
    }
    const submitted: ExecRecord = { ...record, state: "submitted", hash: result.hash, reason: "Submitted. Receipt not seen yet." };
    const pending: ExecRecord = { ...submitted, state: "receipt_pending", reason: "Receipt pending. Do not send another order." };
    return {
      journal: replace(journal, pending),
      state: "receipt_pending" as const,
      reason: pending.reason,
      signingReachable: true,
    };
  });
}

export function reconcile(
  journal: Journal,
  input: { intentId: string; receipt: "success" | "failed" | "unknown"; filled: string; sizeAfter: string },
): { journal: Journal; state: ExecState; reason: string } {
  const record = journal.records.find((item) => item.intentId === input.intentId);
  if (!record || (record.state !== "receipt_pending" && record.state !== "submitted")) {
    return { journal, state: record?.state ?? "failed", reason: "No receipt is pending for that intent." };
  }
  if (input.receipt === "unknown") {
    const next = { ...record, state: "outcome_unknown" as const, reason: "Receipt unknown. The lock stays. Do not retry." };
    return { journal: replace(journal, next), state: next.state, reason: next.reason };
  }
  if (input.receipt === "failed") {
    return fail(journal, record, "Receipt status failed. Exposure was not verified.");
  }
  const check = verifyFill({ sizeBefore: record.sizeBefore, sizeAfter: input.sizeAfter, quantity: record.quantity, filled: input.filled });
  if (!check.ok) return fail(journal, { ...record, filled: input.filled, sizeAfter: input.sizeAfter }, check.reason);
  const verified: ExecRecord = {
    ...record,
    state: "verified",
    filled: input.filled,
    sizeAfter: input.sizeAfter,
    reason: "Post-trade size decreased and the sign held. This path is test-only until an adapter is approved.",
  };
  return {
    journal: { ...replace(journal, verified), lockIntentId: null },
    state: "verified",
    reason: verified.reason,
  };
}

export function verifyFill(input: {
  sizeBefore: string;
  sizeAfter: string;
  quantity: string;
  filled: string;
}): { ok: true } | { ok: false; reason: string } {
  const before = parseInt(input.sizeBefore);
  const after = parseInt(input.sizeAfter);
  const quantity = parseInt(input.quantity);
  const filled = parseInt(input.filled);
  if (before === null || after === null || quantity === null || filled === null) {
    return { ok: false, reason: "Post-trade sizes are not integers." };
  }
  if (sign(before) !== sign(after) || after === 0n) {
    return { ok: false, reason: "Position sign flipped after the fill." };
  }
  if (filled < quantity) return { ok: false, reason: "Partial fill. Not treated as complete." };
  const beforeAbs = before < 0n ? -before : before;
  const afterAbs = after < 0n ? -after : after;
  if (afterAbs >= beforeAbs) return { ok: false, reason: "Exposure did not decrease." };
  return { ok: true };
}

function fail(journal: Journal, record: ExecRecord, reason: string): { journal: Journal; state: ExecState; reason: string; signingReachable: false } {
  const next: ExecRecord = { ...record, state: "failed", reason };
  const release = journal.lockIntentId === record.intentId;
  return {
    journal: { ...replace(journal, next), lockIntentId: release ? null : journal.lockIntentId },
    state: "failed",
    reason,
    signingReachable: false,
  };
}

function refuse(journal: Journal, proposal: Proposal, reason: string): { journal: Journal; proposal: Proposal } {
  return { journal, proposal: { ...proposal, state: "failed", reason, signingReachable: false } };
}

function replace(journal: Journal, record: ExecRecord): Journal {
  return {
    ...journal,
    lockIntentId: record.intentId,
    records: journal.records.map((item) => (item.intentId === record.intentId ? record : item)),
  };
}

function blank(input: ProposeInput, label: Proposal["label"]): Proposal {
  return {
    label,
    state: "proposed",
    reason: "",
    account: input.account,
    market: input.market,
    pool: input.pool,
    positionDirection: "flat",
    currentSize: input.freshSize,
    protectiveDirection: "none",
    isBid: null,
    proposedQuantity: "0",
    reductionBps: null,
    block: input.marginBlock,
    healthRatio: input.ratio,
    risk: input.band,
    intentId: null,
    signingReachable: false,
  };
}

function parseInt(value: string): bigint | null {
  if (!/^-?\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function sign(value: bigint): -1 | 0 | 1 {
  if (value > 0n) return 1;
  if (value < 0n) return -1;
  return 0;
}
