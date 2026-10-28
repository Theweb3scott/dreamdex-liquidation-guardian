/** Plain-language labels for the manual trade screen. This module cannot sign or change a quote. */

export type TradePhase = "idle" | "reading" | "ready" | "signing" | "done";

export type TradeCopy = {
  plain: string;
  retry: boolean;
};

const WRONG_NETWORK = "Your wallet is connected to the wrong network. Switch to Hideki v2 in your wallet.";
const EXPIRED = "Your trade preview has expired. Preview again to get updated prices.";
const CROSSES = "This order would execute immediately, so it cannot be submitted as a post-only order. Try again when the market changes.";
const NO_PRICE = "We couldn't get a reliable market price. Please try again later.";
const NO_MARGIN = "Your account does not have enough available trading margin for this order.";
const CONNECT = "Connect your wallet from the header before previewing a trade.";
const UNFINISHED = "A previous trade is still unfinished. Wait until its status is known before starting another.";
const FALLBACK = "This trade cannot be submitted yet. Open Advanced Details for the exact reason.";

/** Maps an existing technical refusal to a beginner sentence. The original text is not discarded by the screen. */
export function plainTradeCopy(technical: string): TradeCopy {
  const text = technical.trim();
  if (/connect a wallet|no wallet|no browser wallet/i.test(text)) return { plain: CONNECT, retry: false };
  if (/user rejected|user denied|rejected the request/i.test(text)) {
    return { plain: "You cancelled the signature in your wallet. Nothing was submitted.", retry: false };
  }
  if (/would cross the best/i.test(text)) return { plain: CROSSES, retry: true };
  if (/expired|stale quote/i.test(text)) return { plain: EXPIRED, retry: true };
  if (/wrong network|not on chain 50383|not 50383|network version is not|cannot prove Hideki|did not report chain/i.test(text)) {
    return { plain: WRONG_NETWORK, retry: false };
  }
  if (/no usable mark|order book could not be read|rpc failed|could not be read|no valid minimum|base unit is missing|collateral token/i.test(text)) {
    return { plain: NO_PRICE, retry: true };
  }
  if (/larger than the account can place|not enough/i.test(text)) return { plain: NO_MARGIN, retry: false };
  if (/unresolved|already submitted|already stored|will not be sent again|already waiting/i.test(text)) {
    return { plain: UNFINISHED, retry: false };
  }
  if (/only BTC/i.test(text)) return { plain: "Only BTC-PERP can be traded here.", retry: false };
  if (/account does not match|did not return the quoted account/i.test(text)) {
    return { plain: "The connected wallet changed. Preview the trade again.", retry: true };
  }
  return { plain: FALLBACK, retry: true };
}

export function shownValue(value: string | null | undefined): string {
  const text = value?.trim() ?? "";
  if (!text || text === "missing" || text === "—") return "Unavailable";
  return text;
}

export function confirmAllowed(input: {
  hasQuote: boolean;
  fresh: boolean;
  blocked: boolean;
  recovering: boolean;
  phase: TradePhase;
  outcome: "rejected" | "failed" | "submitted" | "unknown" | null;
}): boolean {
  if (!input.hasQuote || !input.fresh || input.blocked || input.recovering) return false;
  if (input.phase === "idle" || input.phase === "reading" || input.phase === "signing") return false;
  if (input.outcome === "submitted" || input.outcome === "unknown") return false;
  return input.phase === "ready" || input.phase === "done";
}

export function tradeResultCopy(result: {
  outcome: "rejected" | "failed" | "submitted" | "unknown";
  receiptStatus: "success" | "reverted" | "unknown" | "none";
  resting: "resting" | "not-resting" | "unverified";
}): { headline: string; note: string; transaction: string; order: string } {
  const transaction =
    result.outcome === "rejected" || result.receiptStatus === "none"
      ? "Not submitted"
      : result.outcome === "failed" || result.receiptStatus === "reverted"
        ? "Failed"
        : result.receiptStatus === "success"
          ? "Confirmed"
          : result.outcome === "submitted"
            ? "Submitted"
            : "Unknown";
  const order =
    result.resting === "resting"
      ? "Resting. This is not a fill."
      : result.resting === "not-resting"
        ? "Not resting. This is not a fill."
        : "Unknown. This is not a fill.";
  if (result.outcome === "rejected" || result.receiptStatus === "none") {
    return { headline: "Nothing was submitted.", note: "No transaction was sent.", transaction, order: "No order was sent." };
  }
  if (result.outcome === "failed" || result.receiptStatus === "reverted") {
    return { headline: "Transaction failed.", note: "The network confirmed the failure. This is not an open order.", transaction, order: "No resting order was verified." };
  }
  if (result.resting === "resting") {
    return {
      headline: result.receiptStatus === "success" ? "Transaction confirmed. Order resting." : "Order resting.",
      note: "A matching order is resting on the book. Resting is not the same as filled.",
      transaction,
      order,
    };
  }
  if (result.outcome === "unknown" || result.receiptStatus === "unknown") {
    return {
      headline: "Transaction status unknown.",
      note: "The result could not be verified. This is not a fill, and the trade will not be sent again until it is known.",
      transaction,
      order,
    };
  }
  if (result.receiptStatus === "success") {
    return {
      headline: "Transaction confirmed.",
      note: result.resting === "not-resting"
        ? "The transaction succeeded. The order is not resting. That does not mean it was filled."
        : "The transaction succeeded. Whether the order is resting could not be verified. This is not a fill.",
      transaction,
      order,
    };
  }
  return { headline: "Transaction submitted.", note: "A signature was sent. Confirmation and a fill are separate.", transaction, order };
}
