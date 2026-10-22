import { useEffect, useState } from "react";
import { readWalletReviewAccount, previewProtectiveStopAccount } from "@/lib/guardian/protocol";
import type { StopPreview } from "@/lib/guardian/stop-preview";
import {
  HIDEKI_CHAIN_ID,
  allowWalletMethod,
  decideReview,
  reduceWallet,
  type ReviewAttempt,
  type ReviewDecision,
  type ReviewQuote,
  type WalletSession,
} from "@/lib/guardian/review";

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};

const HIDEKI_HEX = "0xc4cf";
const EMPTY: WalletSession = { address: null, chainId: null, error: null };

export function WalletReview() {
  const [session, setSession] = useState<WalletSession>(EMPTY);
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

  function apply(event: Parameters<typeof reduceWallet>[1]) {
    setSession((current) => {
      const next = reduceWallet(current, event);
      if (next.clearQuote) {
        setQuotes([]);
        setDecision(null);
        setAttempts([]);
        setStopPreview(null);
      }
      setWalletError(next.session.error);
      return next.session;
    });
  }

  useEffect(() => {
    const eth = provider();
    if (!eth?.on) return;
    const onAccounts = (...args: unknown[]) => {
      const accounts = Array.isArray(args[0]) ? args[0].filter((item): item is string => typeof item === "string") : [];
      apply({ type: "accounts", accounts });
    };
    const onChain = (...args: unknown[]) => {
      const hex = typeof args[0] === "string" ? args[0] : "0x0";
      apply({ type: "chain", chainId: Number.parseInt(hex, 16) });
    };
    eth.on("accountsChanged", onAccounts);
    eth.on("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, []);

  async function ask(method: string, params?: unknown[]) {
    allowWalletMethod(method);
    const eth = provider();
    if (!eth) throw new Error("No browser wallet is available.");
    return eth.request({ method, params });
  }

  async function connect() {
    setWalletError(null);
    try {
      const accounts = (await ask("eth_requestAccounts")) as string[];
      const address = accounts[0];
      if (!address) throw new Error("The wallet returned no account.");
      const chainId = await readChain();
      apply({ type: "connected", address, chainId });
    } catch (error) {
      apply({ type: "rejected", message: error instanceof Error ? error.message : "The wallet refused the connection." });
    }
  }

  async function readChain(): Promise<number> {
    const hex = (await ask("eth_chainId")) as string;
    return Number.parseInt(hex, 16);
  }

  async function switchChain() {
    setWalletError(null);
    try {
      await ask("wallet_switchEthereumChain", [{ chainId: HIDEKI_HEX }]);
      apply({ type: "chain", chainId: await readChain() });
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? Number(error.code) : 0;
      if (code === 4902) {
        try {
          await ask("wallet_addEthereumChain", [
            {
              chainId: HIDEKI_HEX,
              chainName: "Hideki Testnet",
              nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
              rpcUrls: ["https://api.hideki2.infra.testnet.somnia.network"],
            },
          ]);
          apply({ type: "chain", chainId: await readChain() });
          return;
        } catch (addError) {
          setWalletError(addError instanceof Error ? addError.message : "The wallet did not add Hideki.");
          return;
        }
      }
      setWalletError(error instanceof Error ? error.message : "The wallet did not switch chain.");
    }
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
      if (chainId !== session.chainId) apply({ type: "chain", chainId });
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
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 className="text-sm font-medium">Execution review</h2>
        <p className="font-mono text-xs text-accent">BROWSER WALLET · SEND DISABLED</p>
      </div>
      <p className="text-sm leading-relaxed text-muted">
        The monitor above stays a public read. This section asks a browser wallet for an address and chain only.
        Quotes are read from the Hideki v2 RPC, because chain 50383 is not a unique deployment. Nothing is signed or sent.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <button type="button" onClick={() => void connect()} className="h-11 rounded-lg bg-accent px-4 font-medium text-bg">
          {session.address ? "Reconnect wallet" : "Connect wallet"}
        </button>
        {session.address && session.chainId !== HIDEKI_CHAIN_ID ? (
          <button type="button" onClick={() => void switchChain()} className="h-11 rounded-lg border border-line px-4 font-medium text-fg">
            Switch to Hideki
          </button>
        ) : null}
        {session.address ? (
          <button type="button" onClick={() => apply({ type: "disconnect" })} className="h-11 rounded-lg border border-line px-4 font-medium text-fg">
            Disconnect
          </button>
        ) : null}
      </div>
      {session.address ? (
        <p className="break-all font-mono text-xs text-muted">
          {session.address} · chain {session.chainId}
          {session.chainId === HIDEKI_CHAIN_ID ? "" : " · wrong network"}
        </p>
      ) : (
        <p className="text-sm text-muted">No wallet connected. Chain 50383 is required, and it is checked against the v2 contracts.</p>
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
