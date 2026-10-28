import { useEffect, useRef, useState } from "react";
import { readWalletReviewAccount, previewProtectiveStopAccount } from "@/lib/guardian/protocol";
import type { StopPreview } from "@/lib/guardian/stop-preview";
import { HIDEKI_CHAIN_ID, allowWalletMethod, decideReview, type ReviewAttempt, type ReviewDecision, type ReviewQuote } from "@/lib/guardian/review";
import { useAppWallet } from "@/components/app-wallet";
import { networkLabel, tradingSessionKey } from "@/lib/guardian/app-wallet";

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

export function WalletReview() {
  const shared = useAppWallet();
  const session = { address: shared.wallet.address, chainId: shared.wallet.chainId, error: shared.wallet.error };
  const [walletError, setWalletError] = useState<string | null>(null);
  const [quantity, setQuantity] = useState("");
  const [loading, setLoading] = useState(false);
  const [quotes, setQuotes] = useState<ReviewQuote[]>([]);
  const [selected, setSelected] = useState(0);
  const [notes, setNotes] = useState<string[]>([]);
  const [decision, setDecision] = useState<ReviewDecision | null>(null);
  const [attempts, setAttempts] = useState<ReviewAttempt[]>([]);
  const [stopPreview, setStopPreview] = useState<StopPreview | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  const quoted = quotes[selected] ?? null;
  const sessionKey = tradingSessionKey(session.address, session.chainId);
  const seenSession = useRef(sessionKey);

  useEffect(() => {
    if (seenSession.current === sessionKey) return;
    seenSession.current = sessionKey;
    setQuotes([]);
    setDecision(null);
    setAttempts([]);
    setStopPreview(null);
  }, [sessionKey]);

  async function ask(method: string, params?: unknown[]) {
    allowWalletMethod(method);
    const eth = provider();
    if (!eth) throw new Error("No browser wallet is available.");
    return eth.request({ method, params });
  }

  async function readChain(): Promise<number> {
    const hex = (await ask("eth_chainId")) as string;
    return Number.parseInt(hex, 16);
  }

  async function load() {
    if (!session.address) {
      setWalletError("Connect the wallet that owns the position.");
      return;
    }
    if (session.chainId !== HIDEKI_CHAIN_ID) {
      setWalletError("Wrong chain. Switch to Hideki 50383 before loading.");
      return;
    }
    setLoading(true);
    setDecision(null);
    setWalletError(null);
    try {
      const result = await readWalletReviewAccount({ data: { account: session.address, quantity } });
      if (!result.ok) {
        setQuotes([]);
        setWalletError(result.error);
        return;
      }
      setNotes(result.notes);
      setQuotes(result.quotes);
      setSelected(0);
      if (result.quotes.length === 0) setWalletError("No order could be prepared for this wallet.");
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : "The review read failed.");
    } finally {
      setLoading(false);
    }
  }

  async function previewStop() {
    if (!session.address || session.chainId !== HIDEKI_CHAIN_ID) {
      setStopError("Connect the owning wallet on Hideki before planning a stop.");
      return;
    }
    setLoading(true);
    setStopError(null);
    try {
      const result = await previewProtectiveStopAccount({ data: { account: session.address, quantity } });
      if (!result.ok) {
        setStopPreview(null);
        setStopError(result.error);
        return;
      }
      setStopPreview(result.preview);
    } catch (error) {
      setStopError(error instanceof Error ? error.message : "The stop preview failed.");
    } finally {
      setLoading(false);
    }
  }

  async function confirm() {
    if (!session.address || !quoted) return;
    setLoading(true);
    try {
      const chainId = await readChain();
      if (!session.address) return;
      const connected = { address: session.address, chainId };
      const again = await readWalletReviewAccount({ data: { account: session.address, quantity: quoted.quantity } });
      const live = again.ok ? again.quotes.find((item) => item.pool.toLowerCase() === quoted.pool.toLowerCase()) ?? null : null;
      const result = decideReview({
        connected,
        quoted,
        live,
        now: Date.now(),
        attempts,
        requireLive: true,
      });
      setDecision(result);
      if (result.ok && result.intentId) {
        setAttempts((current) => [...current, { intentId: result.intentId as string, outcome: "blocked" }]);
      }
      if (!again.ok) setWalletError(again.error);
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : "The recheck failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
      <div>
        <h2 className="text-base font-semibold">Execution review</h2>
        <p className="mt-1 text-xs text-muted">This protective review cannot send a transaction. It uses the header wallet and does not switch networks.</p>
      </div>
      {session.address ? (
        <p className="break-all font-mono text-xs text-muted">
          {session.address} · {networkLabel(session.chainId)}
          {session.chainId === HIDEKI_CHAIN_ID ? "" : " · wrong network"}
        </p>
      ) : (
        <p className="text-sm text-muted">No wallet connected. Use Connect in the header. A public read still requires chain 50383.</p>
      )}
      <label className="flex flex-col gap-1 text-xs text-muted">
        Raw quantity, blank uses the pool minimum
        <input
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          inputMode="numeric"
          spellCheck={false}
          className="h-11 rounded-lg border border-line bg-bg px-3 font-mono text-sm text-fg outline-none focus:border-accent"
        />
      </label>
      <button
        type="button"
        disabled={!session.address || loading}
        onClick={() => void load()}
        className="h-11 rounded-lg border border-line px-4 font-medium text-fg disabled:opacity-50"
      >
        {loading ? "Reading…" : "Load my position"}
      </button>
      {walletError ? <p className="text-sm text-accent">{walletError}</p> : null}
      {notes.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs text-muted">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      {quotes.length > 1 ? (
        <div className="flex flex-wrap gap-2">
          {quotes.map((item, index) => (
            <button
              key={item.pool}
              type="button"
              onClick={() => {
                setSelected(index);
                setDecision(null);
              }}
              className={
                "h-11 rounded-lg border px-3 font-mono text-sm " +
                (index === selected ? "border-accent text-fg" : "border-line text-muted")
              }
            >
              {item.market}
            </button>
          ))}
        </div>
      ) : null}
      {quoted ? <QuoteCard quote={quoted} /> : null}
      {quoted ? (
        <button
          type="button"
          disabled={loading}
          onClick={() => void confirm()}
          className="h-11 rounded-lg border border-line px-4 font-medium text-fg disabled:opacity-50"
        >
          Recheck before confirmation
        </button>
      ) : null}
      {decision ? (
        <div className="rounded-lg border border-line bg-bg px-3 py-3 text-sm">
          <p className="font-mono text-xs text-accent">{decision.ok ? "READY · NOT SENT" : "BLOCKED"}</p>
          <p className="mt-2 text-fg">{decision.reason}</p>
          <ul className="mt-2 flex flex-col gap-1 text-muted">
            {decision.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          <button type="button" disabled className="mt-3 h-11 w-full rounded-lg bg-line px-4 font-medium text-muted">
            Send order disabled
          </button>
        </div>
      ) : null}
      <div className="rounded-lg border border-dashed border-line p-3">
        <p className="font-mono text-xs tracking-widest text-accent">STOP PLAN · NOT ARMED · NO GRANT</p>
        <p className="mt-1 text-sm text-muted">
          A reduce-only stop is a separate action from the order review above. Approval, creation, monitoring, cancellation, and revocation stay separate. None of them is signed here.
        </p>
        <button
          type="button"
          disabled={!session.address || loading}
          onClick={() => void previewStop()}
          className="mt-3 h-11 rounded-lg border border-line px-4 font-medium text-fg disabled:opacity-50"
        >
          {loading ? "Reading…" : "Preview protective stop"}
        </button>
        {stopError ? <p className="mt-2 text-sm text-accent">{stopError}</p> : null}
        {stopPreview ? <StopPlan preview={stopPreview} /> : null}
      </div>
    </section>
  );
}

function StopPlan({ preview }: { preview: StopPreview }) {
  return (
    <div className="mt-3 text-sm">
      <p className="font-mono text-xs text-accent">{preview.ok ? "PLAN ONLY" : "BLOCKED"} · {preview.createFunction}</p>
      <p className="mt-2 text-fg">{preview.reason}</p>
      <dl className="mt-2 grid grid-cols-2 gap-2">
        <div><dt className="text-xs text-muted">Operator</dt><dd className="truncate font-mono">{preview.operator.address ?? "—"}</dd></div>
        <div><dt className="text-xs text-muted">Selector</dt><dd className="font-mono">{preview.operator.selector}</dd></div>
        <div><dt className="text-xs text-muted">Scope</dt><dd>{preview.operator.scope}</dd></div>
        <div><dt className="text-xs text-muted">SOMI wei</dt><dd className="truncate font-mono">{preview.somiWei ?? "—"}</dd></div>
        <div><dt className="text-xs text-muted">Trigger</dt><dd className="font-mono">{preview.triggerRule ?? "—"} {preview.triggerPrice ?? ""}</dd></div>
        <div><dt className="text-xs text-muted">Quantity</dt><dd className="font-mono">{preview.quantity ?? "—"} {preview.direction}</dd></div>
      </dl>
      <ol className="mt-3 flex flex-col gap-2">
        {preview.steps.map((step) => (
          <li key={step.id} className="border-l-2 border-line pl-3">
            <p className="font-medium">{step.title}</p>
            <p className="text-muted">{step.detail}</p>
          </li>
        ))}
      </ol>
      <ul className="mt-3 flex flex-col gap-1 text-muted">
        {preview.warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </div>
  );
}

function QuoteCard({ quote }: { quote: ReviewQuote }) {
  const rows: Array<[string, string]> = [
    ["Deployment", quote.deploymentId],
    ["Market", quote.market],
    ["Pool", quote.pool],
    ["Wallet", quote.wallet],
    ["Position", quote.positionSize],
    ["Direction", quote.direction],
    ["Raw quantity", quote.quantity],
    ["Price bound", quote.priceBound],
    ["Mark", quote.markPrice],
    ["Estimated taker fee", quote.takerFee],
    ["Fee rate", `${quote.feeRate} bps×1000`],
    ["Reducing capacity", quote.reducingCapacity],
    ["Open orders", quote.openOrderIds.length === 0 ? "none" : quote.openOrderIds.join(", ")],
    ["Market status", String(quote.marketStatus)],
    ["Block", quote.block],
  ];
  return (
    <div className="rounded-lg border border-dashed border-line px-3 py-3">
      <p className="font-mono text-xs tracking-widest text-accent">IOC PREVIEW · NOT REDUCE-ONLY · NOT SENT</p>
      <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="truncate font-mono text-fg">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function provider(): Eip1193 | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as Window & { ethereum?: Eip1193 }).ethereum;
  if (!candidate || typeof candidate.request !== "function") return null;
  return candidate;
}
