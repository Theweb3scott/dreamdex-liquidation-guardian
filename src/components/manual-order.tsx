import { useEffect, useRef, useState } from "react";
import { HIDEKI_CHAIN_ID } from "@/lib/guardian/review";
import { useAppWallet } from "@/components/app-wallet";
import { networkLabel, shortAddress, tradingSessionKey } from "@/lib/guardian/app-wallet";
import { MANUAL_LEDGER_KEY, parseLedger, quoteFresh, reviewPreconditions, submissionBlock, type ManualLedger, type ManualQuote, type OrderObservation } from "@/lib/guardian/manual-order";
import type { ManualSubmit } from "@/lib/guardian/manual-order-client";
import { confirmAllowed, plainTradeCopy, shownValue, tradeResultCopy, type TradePhase } from "@/lib/guardian/trade-copy";

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};

export function ManualTestOrder({
  symbol = "BTC",
  indexerStale = false,
  indexerMark = null,
  indexerAge = null,
  indexerError = null,
}: {
  symbol?: string;
  indexerStale?: boolean;
  indexerMark?: string | null;
  indexerAge?: string | null;
  indexerError?: string | null;
}) {
  const shared = useAppWallet();
  const address = shared.wallet.address;
  const chainId = shared.wallet.chainId;
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [quote, setQuote] = useState<ManualQuote | null>(null);
  const [phase, setPhase] = useState<TradePhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [observed, setObserved] = useState<OrderObservation | null>(null);
  const [result, setResult] = useState<ManualSubmit | null>(null);
  const [unknownNote, setUnknownNote] = useState<string | null>(null);
  const [ledger, setLedger] = useState<ManualLedger>({ version: 1, intents: [] });
  const [storageError, setStorageError] = useState<string | null>(null);
  const [recoveryNote, setRecoveryNote] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [, setClock] = useState(0);

  useEffect(() => {
    let cancel = false;
    const loaded = readStoredLedger();
    if (!loaded.ok) {
      setStorageError(loaded.error);
      return;
    }
    setLedger(loaded.ledger);
    const needsRecovery = loaded.ledger.intents.some((row) => row.phase === "pending" || row.phase === "unknown");
    if (!needsRecovery) return;
    setRecovering(true);
    void (async () => {
      const { reconcileStoredManual } = await import("@/lib/guardian/manual-order-client");
      const recovered = await reconcileStoredManual();
      if (cancel) return;
      if (!recovered.ok) {
        setStorageError(recovered.error);
        setRecovering(false);
        return;
      }
      setLedger(recovered.ledger);
      setRecoveryNote(recovered.note);
      setRecovering(false);
    })();
    return () => {
      cancel = true;
    };
  }, []);

  const sessionKey = tradingSessionKey(address, chainId);
  const seenSession = useRef(sessionKey);
  useEffect(() => {
    if (seenSession.current === sessionKey) return;
    seenSession.current = sessionKey;
    setQuote(null);
    setObserved(null);
    setResult(null);
    setError(null);
    setPhase((current) => (current === "signing" ? current : "idle"));
  }, [sessionKey]);

  useEffect(() => {
    if (!quote || phase === "signing") return;
    const id = setInterval(() => setClock((tick) => tick + 1), 1_000);
    return () => clearInterval(id);
  }, [quote, phase]);

  function chooseSide(next: "buy" | "sell") {
    if (phase === "signing") return;
    setSide(next);
    clearPreview();
  }

  function clearPreview() {
    if (phase === "signing") return;
    setQuote(null);
    setObserved(null);
    setError(null);
    setPhase("idle");
  }

  async function readQuote() {
    const blocked = reviewPreconditions({ account: address, chainId, symbol });
    if (blocked) {
      setQuote(null);
      setObserved(null);
      setError(blocked);
      setPhase("idle");
      return;
    }
    setPhase("reading");
    setError(null);
    setResult(null);
    try {
      const { prepareManualQuote } = await import("@/lib/guardian/manual-order-client");
      const read = await prepareManualQuote(address as string, side);
      if (!read.ok) {
        setQuote(null);
        setObserved(read.observed ?? null);
        setError(read.error);
        setPhase("idle");
        return;
      }
      setObserved(null);
      setQuote(read.quote);
      setPhase("ready");
    } catch (caught) {
      setQuote(null);
      setObserved(null);
      setError(caught instanceof Error ? caught.message : "The quote could not be read.");
      setPhase("idle");
    }
  }

  async function sign() {
    if (!quote || !quoteFresh(quote, Date.now())) {
      setError("The quote expired. Read it again before signing.");
      return;
    }
    const eth = provider();
    if (!eth) {
      setError("No browser wallet is available.");
      return;
    }
    setPhase("signing");
    setError(null);
    try {
      const { submitManualPostOnly } = await import("@/lib/guardian/manual-order-client");
      const submitted = await submitManualPostOnly(eth, quote, true);
      setResult(submitted);
      setPhase("done");
      const { loadManualLedger } = await import("@/lib/guardian/manual-order-client");
      const loaded = loadManualLedger();
      if (loaded.ok) setLedger(loaded.ledger);
      else setStorageError(loaded.error);
      if (submitted.outcome === "rejected" || submitted.outcome === "failed") setError(submitted.detail);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The wallet did not finish.");
      setPhase("ready");
    }
  }

  async function acknowledge(intentId: string) {
    const { acknowledgeUnknownManual, loadManualLedger } = await import("@/lib/guardian/manual-order-client");
    const note = acknowledgeUnknownManual(intentId);
    setUnknownNote(note ?? "Seen. This hash stays locked and will not be sent again.");
    const loaded = loadManualLedger();
    if (loaded.ok) setLedger(loaded.ledger);
  }

  async function recheck() {
    const { reconcileStoredManual } = await import("@/lib/guardian/manual-order-client");
    const recovered = await reconcileStoredManual();
    if (!recovered.ok) {
      setStorageError(recovered.error);
      return;
    }
    setLedger(recovered.ledger);
    setRecoveryNote(recovered.note);
  }

  const fresh = quote != null && quoteFresh(quote, Date.now());
  const hold = storageError ?? submissionBlock(ledger, quote?.intentId ?? "");
  const unresolved = ledger.intents.filter((row) => row.phase === "pending" || row.phase === "unknown");
  const allowed = confirmAllowed({
    hasQuote: quote != null,
    fresh,
    blocked: Boolean(hold),
    recovering,
    phase,
    outcome: result?.outcome ?? null,
  });
  const copy = error ? plainTradeCopy(error) : quote && !fresh ? plainTradeCopy("The quote expired. Read it again before signing.") : hold ? plainTradeCopy(hold) : null;
  const showReview = phase === "reading" || error != null || quote != null || observed != null;
  const walletLine = !address
    ? "No wallet connected. Use Connect in the header."
    : chainId === HIDEKI_CHAIN_ID
      ? `Connected · ${shortAddress(address)} · ${networkLabel(chainId)}`
      : "Your wallet is connected to the wrong network. Switch to Hideki v2 in your wallet.";

  return (
    <>
      <section className="rounded-2xl border border-line bg-surface p-4">
        <p className="text-xs font-medium text-accent">Step 1</p>
        <h2 className="mt-1 text-lg font-semibold">Trade BTC on Testnet</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted">Practice placing a BTC trade using your connected wallet.</p>
        <p className={"mt-3 text-sm " + (address && chainId !== HIDEKI_CHAIN_ID ? "text-warning" : "text-muted")}>{walletLine}</p>
        <p className="mt-3 text-sm">
          Market <span className="font-semibold">BTC-PERP</span>
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" onClick={() => chooseSide("buy")} disabled={phase === "signing"} className={sideButton(side === "buy", "buy")}>
            Buy
          </button>
          <button type="button" onClick={() => chooseSide("sell")} disabled={phase === "signing"} className={sideButton(side === "sell", "sell")}>
            Sell
          </button>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          The app chooses the smallest size the protocol allows, and a limit price that stays off the current market.
        </p>
        {unresolved.length > 0 ? <p className="mt-3 text-sm text-warning">{plainTradeCopy(hold ?? "A manual order hash is still unresolved.").plain}</p> : null}
        <button
          type="button"
          onClick={() => void readQuote()}
          disabled={phase === "reading" || phase === "signing"}
          className="mt-4 flex h-12 w-full items-center justify-center rounded-xl bg-accent text-sm font-semibold text-ink disabled:opacity-50"
        >
          {phase === "reading" ? "Checking the market…" : "Preview Trade"}
        </button>
      </section>

      {showReview ? (
        <section className="rounded-2xl border border-line bg-surface p-4">
          <p className="text-xs font-medium text-accent">Step 2</p>
          <h2 className="mt-1 text-base font-semibold">Review your trade</h2>
          {phase === "reading" ? <p className="mt-3 text-sm text-muted">Getting a fresh price from Hideki v2…</p> : null}
          {copy ? <p className={"mt-3 text-sm " + (quote && fresh && !hold ? "text-muted" : "text-warning")}>{copy.plain}</p> : null}
          {quote ? (
            <dl className="mt-3 grid gap-2 text-sm">
              <Row label="Direction" value={quote.side === "buy" ? "Buy" : "Sell"} />
              <Row label="Price" value={shownValue(quote.priceDisplay)} />
              <Row label="Size" value={`${shownValue(quote.quantityDisplay)} BTC`} />
              <Row label="Required margin" value={shownValue(quote.imReqDisplay)} />
              <Row label="Status" value={fresh && !hold ? "Ready to confirm" : "Not ready"} />
            </dl>
          ) : observed ? (
            <dl className="mt-3 grid gap-2 text-sm">
              <Row label="Direction" value={side === "buy" ? "Buy" : "Sell"} />
              <Row label="Price" value={shownValue(observed.limitPrice)} />
              <Row label="Size" value={shownValue(observed.minimumSize) === "Unavailable" ? "Unavailable" : `${shownValue(observed.minimumSize)} BTC`} />
              <Row label="Required margin" value={shownValue(observed.requiredMargin)} />
              <Row label="Status" value="Not ready" />
            </dl>
          ) : null}
          <p className="mt-3 text-sm leading-relaxed text-muted">This is a limit order. It can stay open and unfilled until someone trades against it.</p>
          {copy?.retry && phase !== "reading" && phase !== "signing" ? (
            <button type="button" onClick={() => void readQuote()} className="mt-3 h-11 w-full rounded-xl border border-line text-sm font-medium">
              Retry Preview
            </button>
          ) : null}
          {phase !== "signing" ? (
            <button type="button" onClick={clearPreview} className="mt-2 h-11 w-full rounded-xl border border-line text-sm font-medium">
              Back
            </button>
          ) : null}
          <details className="mt-3 rounded-xl border border-line px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Advanced Details</summary>
            <div className="mt-2 grid gap-2 text-xs text-muted">
              <p>On-chain mark: {shownValue(quote?.markDisplay ?? observed?.mark)}</p>
              <p>Best bid: {shownValue(quote?.bestBidDisplay ?? observed?.bestBid)} · Best ask: {shownValue(quote?.bestAskDisplay ?? observed?.bestAsk)}</p>
              <p>Indexer mark: {indexerMark ? `${indexerMark}${indexerAge ? ` · ${indexerAge}` : ""}` : "Unavailable"}{indexerStale ? " · stale, not used as the order price" : ""}</p>
              {indexerError ? <p>Indexer: {indexerError}</p> : null}
              <p>Network: {quote ? `${quote.chainId} · ${quote.deploymentId} · net ${quote.netVersion}` : networkLabel(chainId)}</p>
              <p>Quote time: {quote ? new Date(quote.quotedAt).toISOString() : "Unavailable"}</p>
              {quote ? <p>Margin: {quote.marginStatus} · equity {quote.equityDisplay} · required {quote.imReqDisplay} · maintenance {quote.mmReqDisplay}</p> : null}
              {error ? <p>Technical check: {error}</p> : null}
              {hold ? <p>Submission lock: {hold}</p> : null}
              {storageError ? <p>{storageError}</p> : null}
              {recoveryNote ? <p>{recoveryNote}</p> : null}
              {result ? <p>Technical result: {result.detail}</p> : null}
              {quote
                ? quote.warnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))
                : null}
            </div>
          </details>
        </section>
      ) : null}

      {quote || result || phase === "signing" ? (
        <section className="rounded-2xl border border-line bg-surface p-4">
          <p className="text-xs font-medium text-accent">Step 3</p>
          <h2 className="mt-1 text-base font-semibold">Confirm your trade</h2>
          <p className="mt-1 text-sm text-muted">Your wallet is asked to sign only when you press this button.</p>
          <button
            type="button"
            onClick={() => void sign()}
            disabled={!allowed}
            className="mt-3 h-12 w-full rounded-xl bg-accent text-sm font-semibold text-ink disabled:opacity-40"
          >
            {phase === "signing" ? "Waiting for your wallet…" : "Confirm Testnet Trade"}
          </button>
          {result ? (
            <div className="mt-3 grid gap-2 text-sm">
              <Row label="Transaction" value={tradeResultCopy(result).transaction} />
              <Row label="Order" value={tradeResultCopy(result).order} />
              <p className="text-muted">{tradeResultCopy(result).note}</p>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">No transaction yet.</p>
          )}
          {unresolved.length > 0 ? (
            <div className="mt-3 grid gap-2">
              {unresolved.map((row) => (
                <div key={row.intentId} className="rounded-xl border border-line px-3 py-2 text-sm">
                  <p>{row.phase === "unknown" ? "Status unknown" : "Waiting for the wallet"} · {row.side === "buy" ? "Buy" : "Sell"}</p>
                  <p className="mt-1 break-all font-mono text-[11px] text-muted">{row.hash ?? "No transaction hash yet"}</p>
                  {row.phase === "unknown" ? (
                    <button type="button" onClick={() => void acknowledge(row.intentId)} className="mt-2 h-11 rounded-xl border border-line px-3 text-sm">
                      {row.acknowledged ? "Still locked" : "I have seen this unresolved trade"}
                    </button>
                  ) : null}
                </div>
              ))}
              <button type="button" onClick={() => void recheck()} className="h-11 rounded-xl border border-line px-3 text-sm">
                Check the status again
              </button>
            </div>
          ) : null}
          {unknownNote ? <p className="mt-2 text-sm text-muted">{unknownNote}</p> : null}
        </section>
      ) : null}
    </>
  );
}

function readStoredLedger(): { ok: true; ledger: ManualLedger } | { ok: false; error: string } {
  try {
    return parseLedger(window.localStorage.getItem(MANUAL_LEDGER_KEY));
  } catch {
    return { ok: false, error: "This browser cannot store a pending order. Nothing will be signed." };
  }
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-raised px-3 py-2">
      <dt className="text-muted">{label}</dt>
      <dd className="font-mono text-xs">{value}</dd>
    </div>
  );
}

function sideButton(active: boolean, side: "buy" | "sell"): string {
  if (!active) return "h-12 rounded-xl border border-line bg-raised font-medium text-muted";
  return side === "buy"
    ? "h-12 rounded-xl border border-accent bg-accent/15 font-semibold text-fg"
    : "h-12 rounded-xl border border-danger bg-danger/10 font-semibold text-danger";
}

function provider(): Eip1193 | null {
  const eth = (globalThis as { ethereum?: Eip1193 }).ethereum;
  return eth && typeof eth.request === "function" ? eth : null;
}
