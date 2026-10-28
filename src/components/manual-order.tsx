import { useEffect, useState } from "react";
import Wallet from "lucide-react/dist/esm/icons/wallet";
import { HIDEKI_CHAIN_ID, allowWalletMethod } from "@/lib/guardian/review";
import { MANUAL_LEDGER_KEY, parseLedger, quoteFresh, reviewPreconditions, submissionBlock, type ManualLedger, type ManualQuote, type OrderObservation } from "@/lib/guardian/manual-order";
import type { ManualSubmit } from "@/lib/guardian/manual-order-client";

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};

type Phase = "idle" | "reading" | "ready" | "signing" | "done";

const HIDEKI_HEX = "0xc4cf";

export function ManualTestOrder({ symbol = "BTC", indexerStale = false }: { symbol?: string; indexerStale?: boolean }) {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [quote, setQuote] = useState<ManualQuote | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
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

  useEffect(() => {
    const eth = provider();
    if (!eth?.on) return;
    const onChain = (...args: unknown[]) => {
      const hex = typeof args[0] === "string" ? args[0] : "0x0";
      const parsed = Number.parseInt(hex, 16);
      setChainId(Number.isFinite(parsed) ? parsed : null);
      setQuote(null);
      setObserved(null);
      setConfirmed(false);
      setPhase("idle");
    };
    const onAccounts = (...args: unknown[]) => {
      const accounts = Array.isArray(args[0]) ? args[0].filter((item): item is string => typeof item === "string") : [];
      setAddress(accounts[0] ?? null);
      if (accounts.length === 0) setChainId(null);
      setQuote(null);
      setObserved(null);
      setConfirmed(false);
      setPhase("idle");
    };
    eth.on("chainChanged", onChain);
    eth.on("accountsChanged", onAccounts);
    return () => {
      eth.removeListener?.("chainChanged", onChain);
      eth.removeListener?.("accountsChanged", onAccounts);
    };
  }, []);

  useEffect(() => {
    if (!quote || phase === "signing") return;
    const id = setInterval(() => setClock((tick) => tick + 1), 1_000);
    return () => clearInterval(id);
  }, [quote, phase]);

  function chooseSide(next: "buy" | "sell") {
    if (phase === "signing") return;
    setSide(next);
    setQuote(null);
    setObserved(null);
    setConfirmed(false);
    setResult(null);
    setError(null);
    setPhase("idle");
  }

  async function connect() {
    setError(null);
    try {
      const eth = provider();
      if (!eth) throw new Error("No browser wallet is available.");
      allowWalletMethod("wallet_switchEthereumChain");
      try {
        await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: HIDEKI_HEX }] });
      } catch (switchError) {
        const code = typeof switchError === "object" && switchError && "code" in switchError ? switchError.code : 0;
        if (code !== 4902) throw switchError;
        allowWalletMethod("wallet_addEthereumChain");
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: HIDEKI_HEX,
              chainName: "Somnia Tokyo (Hideki v2)",
              nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
              rpcUrls: ["https://api.hideki2.infra.testnet.somnia.network"],
            },
          ],
        });
      }
      allowWalletMethod("eth_requestAccounts");
      const accounts = await eth.request({ method: "eth_requestAccounts" });
      const first = Array.isArray(accounts) ? accounts.find((item) => typeof item === "string") : null;
      if (typeof first !== "string") throw new Error("The wallet did not return an account.");
      allowWalletMethod("eth_chainId");
      const hex = await eth.request({ method: "eth_chainId" });
      const parsed = typeof hex === "string" ? Number.parseInt(hex, 16) : Number.NaN;
      setChainId(Number.isFinite(parsed) ? parsed : null);
      setAddress(first);
      setQuote(null);
      setObserved(null);
      setConfirmed(false);
      setResult(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The wallet was not connected.");
    }
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
    setConfirmed(false);
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
    if (!quote || !confirmed || !quoteFresh(quote, Date.now())) {
      setError("Read a fresh quote and confirm it before the wallet is asked to sign.");
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

  return (
    <>
      <section className="order-1 rounded-2xl border border-line bg-surface p-4">
        <div className="flex items-center gap-2">
          <Wallet className="size-5 text-accent" />
          <h2 className="text-base font-semibold">Connect Wallet</h2>
        </div>
        <p className="mt-1 text-sm text-muted">Connect your wallet to place a testnet order on dreamDEX.</p>
        <button type="button" onClick={() => void connect()} className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-accent text-sm font-semibold text-ink">
          <Wallet className="size-4" />
          {address ? "Wallet connected" : "Connect Wallet"}
        </button>
        <p className="mt-2 text-center text-xs text-muted">Make sure you're on Somnia Testnet (Chain 50383).</p>
        {address ? (
          <p className="mt-2 break-all text-center font-mono text-[11px] text-muted">
            {address}
            <br />
            chain {chainId ?? "not read"}
            {chainId === HIDEKI_CHAIN_ID ? " · Hideki v2 chain id matches" : " · wrong network"}
          </p>
        ) : (
          <p className="mt-2 text-center text-xs text-muted">No wallet connected.</p>
        )}
      </section>

      <section className="order-3 rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-base font-semibold">Order Details</h2>
        <p className="mt-1 text-xs text-muted">One minimum BTC-PERP post-only order. The price and size are locked by the protocol quote.</p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" onClick={() => chooseSide("buy")} disabled={phase === "signing"} className={sideButton(side === "buy")}>
            Long
          </button>
          <button type="button" onClick={() => chooseSide("sell")} disabled={phase === "signing"} className={sideButton(false) + (side === "sell" ? " border-danger text-danger" : "")}>
            Short
          </button>
        </div>
        <label className="mt-3 flex items-center justify-between gap-3 text-sm">
          <span className="text-muted">Order Type</span>
          <span className="rounded-lg border border-line bg-raised px-3 py-2 font-mono text-xs">Post Only (Limit)</span>
        </label>
        <div className="mt-3 grid gap-2 text-sm">
          <ReadOnly label="Price" value={quote ? quote.priceDisplay : "Locked after the quote"} unit="" />
          <ReadOnly label="Minimum size" value={quote ? quote.quantityDisplay : observed?.minimumSize ?? "Protocol minimum"} unit="BTC" />
        </div>
        {indexerStale ? (
          <p className="mt-3 text-sm text-warning">The market-list mark is stale. Review Order reads Hideki v2 directly and does not use that mark.</p>
        ) : null}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-line bg-raised px-3 py-2">
            <p className="text-xs text-muted">Required margin</p>
            <p className="mt-1 font-mono text-sm">{quote ? quote.imReqDisplay : observed?.requiredMargin ?? "—"}</p>
          </div>
          <div className="rounded-xl border border-line bg-raised px-3 py-2">
            <p className="text-xs text-muted">Min. order size</p>
            <p className="mt-1 font-mono text-sm">{quote ? quote.quantityDisplay : observed?.minimumSize ?? "—"}</p>
          </div>
        </div>
        {observed && !quote ? <p className="mt-2 text-xs text-muted">Read during the failed check. Not an order, and nothing will be signed.</p> : null}
      </section>

      <section className="order-4 rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-base font-semibold">Review and Confirm Order</h2>
        <p className="mt-1 text-xs text-muted">Read the locked quote, then confirm. The wallet is asked to sign only from the button below.</p>
        <button
          type="button"
          onClick={() => void readQuote()}
          disabled={!address || phase === "reading" || phase === "signing"}
          className="mt-3 flex h-12 w-full items-center justify-center rounded-xl bg-accent text-sm font-semibold text-ink disabled:opacity-50"
        >
          {phase === "reading" ? "Reading Hideki v2…" : "Review Order →"}
        </button>
        <p className="mt-2 text-center text-xs text-muted">You'll confirm the transaction in your wallet.</p>
        {storageError ? <p className="mt-2 text-sm text-danger">{storageError}</p> : null}
        {recoveryNote ? <p className="mt-2 text-sm text-muted">{recoveryNote}</p> : null}
        {hold && !storageError ? <p className="mt-2 text-sm text-warning">{hold}</p> : null}
        {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
        {quote && !fresh ? <p className="mt-2 text-sm text-warning">This quote expired. Review the order again before anything can be signed.</p> : null}
        {quote ? (
          <div className="mt-3 grid gap-2 text-sm">
            <Fact label="Market" value={`${quote.symbol}-PERP · ${quote.side} · post-only`} />
            <Fact label="Chain" value={`${quote.chainId} · ${quote.deploymentId} · net ${quote.netVersion}`} />
            <Fact label="Book" value={`bid ${quote.bestBidDisplay} · ask ${quote.bestAskDisplay}`} />
            <Fact label="Notional" value={quote.notionalDisplay} />
            <Fact label="Maker fee" value={`${quote.makerFeeDisplay} · rate ${quote.makerFeeRate}`} />
            <Fact label="Taker fee" value={quote.takerFeeNote} />
            <Fact label="Initial / maintenance" value={`${quote.initialMarginBps} / ${quote.maintenanceMarginBps} bps`} />
            <Fact label="Unlocked collateral" value={quote.unlockedCollateralDisplay} />
            <Fact label="Equity / margin" value={`${quote.marginStatus} · equity ${quote.equityDisplay} · IM ${quote.imReqDisplay} · MM ${quote.mmReqDisplay}`} />
            <Fact label="Size limit" value={`${quote.limitedBy} · max ${quote.maxQuantityDisplay}`} />
            <Fact label="Position" value={quote.positionDisplay} />
            <Fact label="If later filled" value={quote.filledExposureDisplay} />
            <Fact label="Quote block" value={quote.block} />
          </div>
        ) : null}
        {quote ? (
          <ul className="mt-3 list-disc pl-5 text-xs text-muted">
            {quote.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            disabled={!quote || phase === "signing"}
            className="mt-1"
          />
          I confirm this single minimum post-only order. It will not be repeated automatically.
        </label>
        <button
          type="button"
          onClick={() => void sign()}
          disabled={!quote || !confirmed || !fresh || Boolean(hold) || recovering || phase === "signing" || result?.outcome === "submitted" || result?.outcome === "unknown"}
          className="mt-3 h-12 w-full rounded-xl border border-accent text-sm font-semibold text-accent disabled:opacity-40"
        >
          Sign post-only order in wallet
        </button>
      </section>

      <section className="order-5 rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-base font-semibold">Transaction Status</h2>
        {recovering ? <p className="mt-2 text-sm text-muted">Checking saved orders…</p> : null}
        {result ? (
          <div className="mt-3 grid gap-2 text-sm">
            <Fact label="Transaction hash" value={result.hash ?? "none"} />
            <Fact label="Receipt status" value={result.receiptStatus} />
            <Fact label="Resting order" value={result.resting} />
            <p className="text-muted">{result.detail}</p>
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted">No transaction yet. The hash, receipt, and resting order are shown separately after a signature.</p>
        )}
        {unresolved.length > 0 ? (
          <div className="mt-3 grid gap-2 text-sm">
            {unresolved.map((row) => (
              <div key={row.intentId} className="rounded-xl border border-line px-3 py-2">
                <p className="break-all font-mono text-xs">
                  {row.phase} · {row.side} · {row.hash ?? "no hash yet"}
                </p>
                <p className="text-muted">Stored in this browser. Acknowledging it does not allow another send.</p>
                {row.phase === "unknown" ? (
                  <button type="button" onClick={() => void acknowledge(row.intentId)} className="mt-2 h-11 rounded-xl border border-line px-3 text-sm">
                    {row.acknowledged ? "Still locked" : "I have seen this unresolved hash"}
                  </button>
                ) : null}
              </div>
            ))}
            <button type="button" onClick={() => void recheck()} className="h-11 rounded-xl border border-line px-3 text-sm">
              Check Hideki v2 again
            </button>
          </div>
        ) : null}
        {unknownNote ? <p className="mt-2 text-sm text-muted">{unknownNote}</p> : null}
      </section>
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

function ReadOnly({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-raised px-3 py-2">
      <span className="text-muted">{label}</span>
      <span className="truncate font-mono text-xs">
        {value} <span className="text-muted">{unit}</span>
      </span>
    </div>
  );
}

function sideButton(active: boolean): string {
  return active
    ? "h-11 rounded-xl border border-healthy bg-healthy/15 font-semibold text-healthy"
    : "h-11 rounded-xl border border-line bg-raised font-medium text-muted";
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <p className="rounded-lg border border-line px-3 py-2">
      <span className="block text-xs text-muted">{label}</span>
      <span className="font-mono text-xs break-all">{value}</span>
    </p>
  );
}

function provider(): Eip1193 | null {
  const eth = (globalThis as { ethereum?: Eip1193 }).ethereum;
  return eth && typeof eth.request === "function" ? eth : null;
}
