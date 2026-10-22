import { useEffect, useState } from "react";
import { allowWalletMethod } from "@/lib/guardian/review";
import { quoteFresh, submissionBlock, type ManualLedger, type ManualQuote } from "@/lib/guardian/manual-order";
import type { ManualSubmit } from "@/lib/guardian/manual-order-client";

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

type Phase = "idle" | "reading" | "ready" | "signing" | "done";

const HIDEKI_HEX = "0xc4cf";

export function ManualTestOrder() {
  const [address, setAddress] = useState<string | null>(null);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [quote, setQuote] = useState<ManualQuote | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ManualSubmit | null>(null);
  const [unknownNote, setUnknownNote] = useState<string | null>(null);
  const [ledger, setLedger] = useState<ManualLedger>({ version: 1, intents: [] });
  const [storageError, setStorageError] = useState<string | null>(null);
  const [recoveryNote, setRecoveryNote] = useState<string | null>(null);
  const [, setClock] = useState(0);

  useEffect(() => {
    let cancel = false;
    void (async () => {
      const { loadManualLedger, reconcileStoredManual } = await import("@/lib/guardian/manual-order-client");
      const loaded = loadManualLedger();
      if (cancel) return;
      if (!loaded.ok) {
        setStorageError(loaded.error);
        return;
      }
      setLedger(loaded.ledger);
      const recovered = await reconcileStoredManual();
      if (cancel) return;
      if (!recovered.ok) {
        setStorageError(recovered.error);
        return;
      }
      setLedger(recovered.ledger);
      setRecoveryNote(recovered.note);
    })();
    return () => {
      cancel = true;
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
      setAddress(first);
      setQuote(null);
      setConfirmed(false);
      setResult(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The wallet was not connected.");
    }
  }

  async function readQuote() {
    if (!address) return;
    setPhase("reading");
    setError(null);
    setResult(null);
    setConfirmed(false);
    try {
      const { prepareManualQuote } = await import("@/lib/guardian/manual-order-client");
      const read = await prepareManualQuote(address, side);
      if (!read.ok) {
        setQuote(null);
        setError(read.error);
        setPhase("idle");
        return;
      }
      setQuote(read.quote);
      setPhase("ready");
    } catch (caught) {
      setQuote(null);
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
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Manual testnet order</h2>
        <p className="text-sm leading-relaxed text-muted">
          One minimum BTC-PERP post-only order, signed by your browser wallet. Guardian monitoring does not send it.
          No private key is requested. The wallet must report Hideki v2 itself: chain 50383 is shared with an older
          network, and a wallet that cannot answer net_version is refused.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void connect()} className="h-11 rounded-lg border border-line px-3 text-sm">
          {address ? "Wallet connected" : "Connect wallet"}
        </button>
        <button type="button" onClick={() => chooseSide("buy")} disabled={phase === "signing"} className={chip(side === "buy")}>
          Buy
        </button>
        <button type="button" onClick={() => chooseSide("sell")} disabled={phase === "signing"} className={chip(side === "sell")}>
          Sell
        </button>
        <button type="button" onClick={() => void readQuote()} disabled={!address || phase === "reading" || phase === "signing"} className="h-11 rounded-lg bg-accent px-3 text-sm text-bg disabled:opacity-50">
          Read BTC-PERP
        </button>
      </div>
      {address ? <p className="font-mono text-xs text-muted">{address}</p> : null}
      {storageError ? <p className="text-sm text-accent">{storageError}</p> : null}
      {recoveryNote ? <p className="text-sm text-muted">{recoveryNote}</p> : null}
      {hold && !storageError ? <p className="text-sm text-accent">{hold}</p> : null}
      {error ? <p className="text-sm text-accent">{error}</p> : null}
      {quote ? (
        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <Fact label="Market" value={`${quote.symbol}-PERP · ${quote.side} · post-only`} />
          <Fact label="Chain" value={`${quote.chainId} · ${quote.deploymentId} · net ${quote.netVersion}`} />
          <Fact label="Price" value={quote.priceDisplay} />
          <Fact label="Book" value={`bid ${quote.bestBidDisplay} · ask ${quote.bestAskDisplay}`} />
          <Fact label="Minimum quantity" value={quote.quantityDisplay} />
          <Fact label="Notional" value={quote.notionalDisplay} />
          <Fact label="Maker fee" value={`${quote.makerFeeDisplay} · rate ${quote.makerFeeRate} (bps×1000)`} />
          <Fact label="Taker fee" value={quote.takerFeeNote} />
          <Fact label="Initial / maintenance" value={`${quote.initialMarginBps} / ${quote.maintenanceMarginBps} bps`} />
          <Fact label="Collateral" value={quote.collateralToken} />
          <Fact label="Unlocked collateral" value={quote.unlockedCollateralDisplay} />
          <Fact label="Equity / margin" value={`${quote.marginStatus} · equity ${quote.equityDisplay} · IM ${quote.imReqDisplay} · MM ${quote.mmReqDisplay}`} />
          <Fact label="Current position" value={quote.positionDisplay} />
          <Fact label="Exposure if later filled" value={quote.filledExposureDisplay} />
          <Fact label="Size limit" value={`${quote.limitedBy} · max ${quote.maxQuantityDisplay}`} />
          <Fact label="Quote block" value={quote.block} />
        </div>
      ) : null}
      {quote ? (
        <ul className="list-disc pl-5 text-sm text-muted">
          {quote.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      <label className="flex items-start gap-2 text-sm">
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
        disabled={!quote || !confirmed || !fresh || Boolean(hold) || phase === "signing" || result?.outcome === "submitted" || result?.outcome === "unknown"}
        className="h-11 rounded-lg border border-accent px-3 text-sm disabled:opacity-50"
      >
        Sign post-only order in wallet
      </button>
      {result ? (
        <div className="grid gap-2 text-sm">
          <Fact label="Transaction hash" value={result.hash ?? "none"} />
          <Fact label="Receipt status" value={result.receiptStatus} />
          <Fact label="Resting order" value={result.resting} />
          <p className="text-muted">{result.detail}</p>
        </div>
      ) : null}
      {unresolved.length > 0 ? (
        <div className="grid gap-2 text-sm">
          {unresolved.map((row) => (
            <div key={row.intentId} className="rounded-lg border border-line px-3 py-2">
              <p className="font-mono text-xs break-all">
                {row.phase} · {row.side} · {row.hash ?? "no hash yet"}
              </p>
              <p className="text-muted">Stored in this browser. Acknowledging it does not allow another send.</p>
              {row.phase === "unknown" ? (
                <button type="button" onClick={() => void acknowledge(row.intentId)} className="mt-2 h-11 rounded-lg border border-line px-3 text-sm">
                  {row.acknowledged ? "Still locked" : "I have seen this unresolved hash"}
                </button>
              ) : null}
            </div>
          ))}
          <button type="button" onClick={() => void recheck()} className="h-11 rounded-lg border border-line px-3 text-sm">
            Check Hideki v2 again
          </button>
        </div>
      ) : null}
      {unknownNote ? <p className="text-sm text-muted">{unknownNote}</p> : null}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <p className="rounded-lg border border-line px-3 py-2">
      <span className="block text-xs text-muted">{label}</span>
      <span className="font-mono text-xs break-all">{value}</span>
    </p>
  );
}

function chip(active: boolean): string {
  return active ? "h-11 rounded-lg bg-raised px-3 text-sm" : "h-11 rounded-lg border border-line px-3 text-sm text-muted";
}

function provider(): Eip1193 | null {
  const eth = (globalThis as { ethereum?: Eip1193 }).ethereum;
  return eth && typeof eth.request === "function" ? eth : null;
}
