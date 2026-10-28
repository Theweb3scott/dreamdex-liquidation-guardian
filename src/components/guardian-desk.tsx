import { useEffect, useMemo, useRef, useState } from "react";
import ChartNoAxesColumn from "lucide-react/dist/esm/icons/chart-no-axes-column";
import Clock from "lucide-react/dist/esm/icons/clock";
import Copy from "lucide-react/dist/esm/icons/copy";
import Home from "lucide-react/dist/esm/icons/home";
import Play from "lucide-react/dist/esm/icons/play";
import Shield from "lucide-react/dist/esm/icons/shield";
import { WalletReview } from "@/components/wallet-review";
import { useAppWallet } from "@/components/app-wallet";
import { ManualTestOrder } from "@/components/manual-order";
import { GuardianShield } from "@/components/guardian-shield";
import { followConnectedAddress, connectionStatus, monitoredAddressNote, networkLabel, shortAddress } from "@/lib/guardian/app-wallet";
import { listHidekiPerps, type PerpQuote } from "@/lib/guardian/markets";
import { readProtocolAccount, previewDryRun } from "@/lib/guardian/protocol";
import { disarm, emptyJournal, restoreJournal, serializeJournal, type Journal, type Proposal } from "@/lib/guardian/execution";
import type { ProtocolRead } from "@/lib/guardian/hideki-read";
import {
  assessAccount,
  createReadGate,
  monitorLog,
  parsePublicAddress,
  parseThresholds,
  protectionDecision,
  type AccountSnapshot,
  type Assessment,
  type RiskBand,
} from "@/lib/guardian/monitor";
import {
  decideProtection,
  distanceToLiquidation,
  formatAge,
  formatPx,
  healthRatio,
  liquidationPrice,
  marginBand,
  quoteToNumber,
  requirement,
  unrealizedPnl,
  type GuardAction,
  type Side,
} from "@/lib/guardian/risk";

type LogLine = { id: number; text: string; kind: GuardAction["kind"] };
type Screen = "dashboard" | "protection" | "trade";

const STALE_SEC = 180;

export function GuardianDesk() {
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [quotes, setQuotes] = useState<PerpQuote[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [symbol, setSymbol] = useState("BTC");
  const [side, setSide] = useState<Side>("long");
  const [size, setSize] = useState("0.1");
  const [entry, setEntry] = useState("");
  const [collateral, setCollateral] = useState("2000");
  const [mmBps, setMmBps] = useState("250");
  const [reduceBelow, setReduceBelow] = useState("1.5");
  const [flattenBelow, setFlattenBelow] = useState("1.15");
  const [reducePct, setReducePct] = useState("25");
  const [maxReducePct, setMaxReducePct] = useState("25");
  const [log, setLog] = useState<LogLine[]>([]);
  const [pending, setPending] = useState<Extract<GuardAction, { kind: "reduce" }> | null>(null);
  const [lastKey, setLastKey] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    listHidekiPerps()
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setLoadError(result.error);
          setQuotes([]);
          return;
        }
        setQuotes(result.quotes);
        setLoadError(null);
        if (!result.quotes.some((q) => q.symbol === "BTC") && result.quotes[0]) {
          setSymbol(result.quotes[0].symbol);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : "Could not load markets.");
        setQuotes([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const quote = quotes?.find((q) => q.symbol === symbol) ?? null;
  const mark = quote ? quoteToNumber(quote.mark) : 0;
  const index = quote ? quoteToNumber(quote.index) : 0;
  const ageSec = quote?.markUpdatedAt ? now / 1000 - quote.markUpdatedAt : Number.POSITIVE_INFINITY;

  useEffect(() => {
    if (mark > 0) setEntry((current) => (current === "" ? String(roundInput(mark)) : current));
  }, [mark, symbol]);

  const view = useMemo(() => {
    const sizeN = num(size);
    const entryN = num(entry);
    const collateralN = num(collateral);
    const mm = num(mmBps);
    const im = quote?.initialMarginBps ?? 0;
    const pnl = unrealizedPnl(side, sizeN, entryN, mark);
    const equity = collateralN + pnl;
    const mmReq = requirement(sizeN, mark, mm);
    const imReq = requirement(sizeN, mark, im);
    const ratio = healthRatio(equity, mmReq);
    const liq = liquidationPrice({ equity, mmReq, side, size: sizeN, mark, mmBps: mm });
    const distance = distanceToLiquidation(side, mark, liq);
    const band = marginBand(equity, imReq, mmReq);
    return { sizeN, entryN, collateralN, mm, im, pnl, equity, mmReq, imReq, ratio, liq, distance, band };
  }, [size, entry, collateral, mmBps, quote, side, mark]);

  function push(text: string, kind: GuardAction["kind"]) {
    setLog((lines) => [{ id: Date.now(), text, kind }, ...lines].slice(0, 12));
  }

  function runCheck() {
    const fractionKey = `${symbol}:${side}:${view.sizeN}:${reducePct}:${maxReducePct}:${view.ratio.toFixed(3)}`;
    const action = decideProtection({
      ratio: view.ratio,
      stale: !quote || ageSec > STALE_SEC,
      reduceBelow: num(reduceBelow),
      flattenBelow: num(flattenBelow),
      reducePct: num(reducePct) / 100,
      maxReducePct: num(maxReducePct) / 100,
      duplicate: lastKey === fractionKey,
    });
    if (action.kind === "reduce") {
      setPending(action);
      setLastKey(fractionKey);
      push(
        `Dry-run. Would ${action.fraction >= 1 ? "flatten" : "reduce"} ${symbol} ${side} by ${(action.fraction * 100).toFixed(0)}% (${formatPx(view.sizeN * action.fraction)}). ${action.reason} No transaction sent.`,
        "reduce",
      );
      return;
    }
    setPending(null);
    push(action.reason, action.kind);
  }

  function applySimulatedFill() {
    if (!pending) return;
    const next = view.sizeN * (1 - pending.fraction);
    setSize(String(roundInput(next)));
    push(
      `Simulated fill only. ${symbol} size ${formatPx(view.sizeN)} → ${formatPx(next)}. Chain position was not read back.`,
      "hold",
    );
    setPending(null);
    setLastKey(null);
  }

  const ratioLabel = Number.isFinite(view.ratio) ? `${view.ratio.toFixed(2)}×` : "∞";
  const bar = Number.isFinite(view.ratio) ? Math.max(4, Math.min(100, (view.ratio / 2.5) * 100)) : 4;
  const stressed = view.band !== "Healthy";

  return (
    <div className="min-h-screen overflow-x-hidden bg-bg">
      <main className="mx-auto flex w-full min-w-0 max-w-[430px] flex-col gap-3 px-4 pb-28 pt-4">
        <AppHeader />
        <ProtocolPanel screen={screen} />

        <div className={screen === "protection" ? "order-2 flex flex-col gap-3" : "hidden"}>
          <GuardianShield />
        </div>

        <div className={screen === "trade" ? "flex flex-col gap-3" : "hidden"}>
          <ManualTestOrder symbol={symbol} indexerStale={Boolean(quote && ageSec > STALE_SEC)} />
          <section className="order-2 rounded-2xl border border-line bg-surface p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold">Select Market</h2>
              <p className="flex items-center gap-1.5 text-xs text-muted">
                <span className={"size-1.5 rounded-full " + (loadError ? "bg-danger" : "bg-healthy")} />
                {quotes === null ? "Loading" : loadError ? "Indexer unavailable" : "Live prices (testnet)"}
              </p>
            </div>
            {loadError ? <p className="mt-3 text-sm text-danger">{loadError}</p> : null}
            <div className="mt-3 flex min-w-0 gap-2 overflow-x-auto pb-1">
              {[...(quotes ?? [])]
                .sort((a, b) => chipRank(a.symbol) - chipRank(b.symbol) || a.symbol.localeCompare(b.symbol))
                .map((item) => {
                const selected = item.symbol === symbol;
                const orderable = item.symbol === "BTC";
                return (
                  <button
                    key={item.symbol}
                    type="button"
                    onClick={() => {
                      setSymbol(item.symbol);
                      setEntry("");
                      setPending(null);
                      setLastKey(null);
                    }}
                    className={
                      "inline-flex h-10 shrink-0 items-center justify-center rounded-xl border px-3 text-xs font-medium whitespace-nowrap " +
                      (orderable && selected
                        ? "border-accent bg-accent/15 text-fg"
                        : selected
                          ? "border-line bg-raised text-fg"
                          : "border-line bg-raised text-muted")
                    }
                  >
                    {item.symbol}-PERP
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-muted">Orders stay on BTC-PERP. Other markets are read-only.</p>
            <div className="mt-4 flex items-start justify-between gap-3">
              <div>
                <p className="text-base font-semibold">{symbol}-PERP</p>
                <p className="mt-1 text-xs text-muted">{quote ? formatAge(ageSec) : "No indexer row"}</p>
              </div>
              <p className="text-right font-mono text-lg font-medium">{mark ? formatPx(mark) : "—"}</p>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted">Open interest</dt>
                <dd className="mt-1 font-mono">{quote ? formatPx(quoteToNumber(quote.openInterest, quote.baseDecimals)) : "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Initial margin</dt>
                <dd className="mt-1 font-mono">{quote ? `${(view.im / 100).toFixed(2)}%` : "—"}</dd>
              </div>
            </dl>
            {quote && ageSec > STALE_SEC ? <p className="mt-3 text-sm text-warning">This mark is stale. It is not used as an order price.</p> : null}
          </section>
          <div className="order-6">
            <WalletReview />
          </div>
        </div>

        <details className={screen === "protection" ? "order-4 rounded-2xl border border-line bg-surface p-4" : "hidden"}>
          <summary className="cursor-pointer text-sm font-semibold">What If? Simulation</summary>
          <p className="mt-2 text-xs text-muted">Hypothetical desk math. Not the live account, and nothing is sent.</p>
          <div className="mt-4 grid gap-4">
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                runCheck();
              }}
            >
              <div className="grid grid-cols-2 gap-2">
                {(["long", "short"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setSide(option)}
                    className={
                      "h-11 rounded-xl border font-medium capitalize " +
                      (side === option ? "border-healthy bg-healthy/15 text-healthy" : "border-line text-muted")
                    }
                  >
                    {option}
                  </button>
                ))}
              </div>
              <Field label="Size" value={size} onChange={setSize} />
              <Field label="Entry" value={entry} onChange={setEntry} />
              <Field label="Collateral USDso" value={collateral} onChange={setCollateral} />
              <Field label="Maintenance bps" value={mmBps} onChange={setMmBps} />
              <div className="grid grid-cols-2 gap-3">
                <Field label="Reduce below" value={reduceBelow} onChange={setReduceBelow} />
                <Field label="Flatten below" value={flattenBelow} onChange={setFlattenBelow} />
                <Field label="Reduce %" value={reducePct} onChange={setReducePct} />
                <Field label="Max reduce %" value={maxReducePct} onChange={setMaxReducePct} />
              </div>
              <button type="submit" className="h-12 rounded-xl bg-accent font-semibold text-ink">
                Check protection
              </button>
              <button
                type="button"
                disabled={!pending}
                onClick={applySimulatedFill}
                className="h-11 rounded-xl border border-line font-medium text-fg disabled:opacity-40"
              >
                Apply simulated fill
              </button>
            </form>
            <div className="rounded-xl border border-line bg-raised p-4">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-sm font-medium">New health ratio</h2>
                <p className={"font-mono text-sm " + (stressed ? "text-danger" : "text-healthy")}>{view.band}</p>
              </div>
              <p className="mt-3 font-mono text-3xl font-medium">{ratioLabel}</p>
              <p className="mt-1 text-sm text-muted">Equity over maintenance. 1.00× is the liquidation line.</p>
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-bg">
                <div className={"h-full " + (stressed ? "bg-danger" : "bg-healthy")} style={{ width: `${bar}%` }} />
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <Pair k="Equity" v={formatPx(view.equity)} />
                <Pair k="Unrealized" v={formatPx(view.pnl)} />
                <Pair k="Maintenance" v={formatPx(view.mmReq)} />
                <Pair k="Initial" v={formatPx(view.imReq)} />
                <Pair k="Liq. price" v={view.liq == null ? "—" : formatPx(view.liq)} />
                <Pair k="Distance" v={view.distance == null ? "—" : `${(view.distance * 100).toFixed(2)}%`} />
              </dl>
            </div>
            <div>
              <h2 className="text-sm font-medium">Action log</h2>
              {log.length === 0 ? (
                <p className="mt-3 text-sm text-muted">No check yet. Nothing is sent from this desk.</p>
              ) : (
                <ol className="mt-3 flex flex-col gap-2">
                  {log.map((line) => (
                    <li key={line.id} className="border-l-2 border-line pl-3 text-sm leading-relaxed text-muted">
                      <span className="font-mono text-xs text-accent">{line.kind}</span>
                      <span className="mt-1 block text-fg">{line.text}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <p className="rounded-xl border border-line bg-raised px-3 py-3 text-sm text-muted">
              Use this to see how a typed scenario changes estimated health before taking action.
            </p>
          </div>
        </details>
      </main>
      <BottomNav screen={screen} onChange={setScreen} />
    </div>
  );
}

function ProtocolPanel({ screen }: { screen: Screen }) {
  const shared = useAppWallet();
  const [account, setAccount] = useState("");
  const [pending, setPending] = useState(false);
  const [watching, setWatching] = useState(false);
  const [intervalSec, setIntervalSec] = useState(30);
  const [warning, setWarning] = useState("2");
  const [danger, setDanger] = useState("1.5");
  const [critical, setCritical] = useState("1.15");
  const [error, setError] = useState<string | null>(null);
  const [read, setRead] = useState<ProtocolRead | null>(null);
  const [events, setEvents] = useState<Array<{ id: number; message: string }>>([]);
  const [requestedPct, setRequestedPct] = useState("25");
  const [maxPct, setMaxPct] = useState("25");
  const [previewing, setPreviewing] = useState(false);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [includeWarning, setIncludeWarning] = useState(false);
  const [journal, setJournal] = useState<Journal>(emptyJournal());
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const bandRef = useRef<RiskBand | null>(null);
  const gate = useRef(createReadGate());
  const seq = useRef(0);
  const limitsRef = useRef({ warning, danger, critical });
  const syncedAddress = useRef<string | null>(null);
  limitsRef.current = { warning, danger, critical };

  useEffect(() => {
    const connected = shared.wallet.address;
    setAccount((current) => {
      const next = followConnectedAddress(current, syncedAddress.current, connected);
      syncedAddress.current = next.synced;
      return next.value;
    });
  }, [shared.wallet.address]);

  const limits = parseThresholds({ warning, danger, critical });
  const snapshot = useMemo(() => (read?.account ? toSnapshot(read) : null), [read]);
  const assessment = snapshot && limits.ok ? assessAccount(snapshot, limits.thresholds) : null;

  function push(message: string) {
    const id = ++seq.current;
    setEvents((lines) => [{ id, message }, ...lines].slice(0, 12));
  }

  async function pull(target: string) {
    if (!gate.current.tryEnter()) {
      push(`${new Date().toISOString()} refresh skipped. Previous read still running.`);
      return;
    }
    setPending(true);
    try {
      const result = await readProtocolAccount({ data: target });
      if (!result.ok) {
        const event = monitorLog(bandRef.current, { error: result.error });
        if (event) push(`${new Date().toISOString()} ${event.message}`);
        setError(result.error);
        return;
      }
      setError(null);
      setRead(result);
      setUpdatedAt(Date.now());
      if (!result.account) return;
      const parsed = parseThresholds(limitsRef.current);
      if (!parsed.ok) return;
      const view = assessAccount(toSnapshot(result), parsed.thresholds);
      const decision = protectionDecision(view);
      const change = monitorLog(bandRef.current, view);
      if (change?.kind === "changed") bandRef.current = change.band;
      push(
        `${new Date().toISOString()} block ${result.account.margin.asOfBlock} status ${result.account.margin.status} band ${view.band} health ${view.ratio ?? "withheld"} · ${decision.reason}`,
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Protocol read failed.";
      const event = monitorLog(bandRef.current, { error: message });
      if (event) push(`${new Date().toISOString()} ${event.message}`);
      setError(message);
    } finally {
      gate.current.leave();
      setPending(false);
    }
  }

  const pullRef = useRef(pull);
  pullRef.current = pull;

  useEffect(() => {
    const saved = window.localStorage.getItem("guardian.execution.journal");
    if (!saved) return;
    try {
      setJournal(restoreJournal(saved));
    } catch {
      window.localStorage.removeItem("guardian.execution.journal");
    }
  }, []);

  useEffect(() => {
    if (!watching) return;
    const parsed = parsePublicAddress(account);
    if (!parsed.ok) return;
    void pullRef.current(parsed.address);
    const timer = window.setInterval(() => {
      void pullRef.current(parsed.address);
    }, intervalSec * 1000);
    return () => window.clearInterval(timer);
  }, [watching, account, intervalSec]);

  function runPreview(mode: "demo" | "protection") {
    const parsed = parsePublicAddress(account);
    if (!parsed.ok) {
      setPreviewError(parsed.error);
      return;
    }
    const requested = Number(requestedPct);
    const max = Number(maxPct);
    if (!Number.isInteger(requested) || !Number.isInteger(max)) {
      setPreviewError("Use whole percents.");
      return;
    }
    setPreviewError(null);
    setPreviewing(true);
    void previewDryRun({
      data: {
        account: parsed.address,
        requestedPct: requested,
        maxPct: max,
        mode,
        journal: serializeJournal(journal),
        includeWarning,
      },
    })
      .then((result) => {
        if (!result.ok) {
          setPreviewError(result.error);
          setProposals(null);
          return;
        }
        setJournal(result.journal);
        window.localStorage.setItem("guardian.execution.journal", serializeJournal(result.journal));
        setProposals(result.proposals);
      })
      .catch((caught: unknown) => {
        setPreviewError(caught instanceof Error ? caught.message : "Preview failed.");
      })
      .finally(() => setPreviewing(false));
  }

  function readAccount() {
    const parsed = parsePublicAddress(account);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    if (!limits.ok) {
      setError(limits.error);
      return;
    }
    setError(null);
    void pull(parsed.address);
  }

  return (
    <>
      <div className={screen === "dashboard" ? "flex flex-col gap-3" : "hidden"}>
        <section className="rounded-2xl border border-line bg-surface p-4">
          <h2 className="text-base font-semibold">Check Your Account</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted">Enter a public wallet address to monitor your dreamDEX account. No connection is required.</p>
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-line bg-raised px-3">
            <input
              value={account}
              onChange={(event) => {
                setAccount(event.target.value);
                setWatching(false);
              }}
              placeholder="0x Your wallet address"
              spellCheck={false}
              aria-label="Public wallet address"
              className="h-12 min-w-0 flex-1 bg-transparent font-mono text-sm text-fg outline-none placeholder:text-muted"
            />
            <button type="button" onClick={() => void navigator.clipboard?.writeText(account)} aria-label="Copy address" className="text-muted">
              <Copy className="size-4" />
            </button>
          </div>
          {monitoredAddressNote(account, shared.wallet.address) ? (
            <p className={"mt-2 text-xs " + (shared.wallet.address && account.trim().toLowerCase() !== shared.wallet.address.toLowerCase() ? "text-warning" : "text-muted")}>
              {monitoredAddressNote(account, shared.wallet.address)}
            </p>
          ) : null}
          <button
            type="button"
            disabled={pending && !watching}
            onClick={readAccount}
            className="mt-3 h-12 w-full rounded-xl bg-accent text-sm font-semibold text-ink disabled:opacity-50"
          >
            {pending ? "Reading…" : "Check My Account"}
          </button>
          <div className="mt-3 flex items-center justify-between gap-3 text-sm text-muted">
            <span className="flex items-center gap-1.5">
              <Clock className="size-4" />
              Auto refresh (monitoring)
            </span>
            <select
              value={intervalSec}
              onChange={(event) => setIntervalSec(Number(event.target.value))}
              aria-label="Refresh interval"
              className="h-9 rounded-lg border border-line bg-raised px-2 font-mono text-sm text-fg outline-none"
            >
              <option value={15}>15 seconds</option>
              <option value={30}>30 seconds</option>
              <option value={60}>60 seconds</option>
              <option value={120}>120 seconds</option>
            </select>
          </div>
        </section>

        <section className="rounded-2xl border border-line bg-surface p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold">Account Health</h2>
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <span className={"size-1.5 rounded-full " + (assessment ? "bg-healthy" : "bg-muted")} />
              {updatedAt ? `Last updated ${new Date(updatedAt).toLocaleTimeString()}` : "Not read yet"}
            </p>
          </div>
          {assessment ? (
            <HealthCard assessment={assessment} />
          ) : (
            <p className="mt-4 text-sm text-muted">
              {read?.account ? "This snapshot has no comparable health." : "Check an account to see health. No sample balance is shown."}
            </p>
          )}
        </section>

        <section className="rounded-2xl border border-line bg-surface p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold">Your Positions</h2>
            <span className="rounded-full bg-raised px-2 py-1 text-xs text-muted">
              {assessment ? `${assessment.positions.filter((position) => position.direction !== "flat").length} open` : "—"}
            </span>
          </div>
          {assessment && assessment.positions.filter((position) => position.direction !== "flat").length > 0 ? (
            <ul className="mt-3 flex flex-col gap-3">
              {assessment.positions
                .filter((position) => position.direction !== "flat")
                .map((position) => (
                  <li key={position.symbol} className="rounded-xl border border-line bg-raised p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold">{position.symbol}-PERP</p>
                      <span className={"rounded-full px-2 py-0.5 text-xs font-medium " + (position.direction === "long" ? "bg-healthy/15 text-healthy" : "bg-danger/15 text-danger")}>
                        {position.direction === "long" ? "Long" : "Short"}
                      </span>
                    </div>
                    <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
                      <Pair k="Size" v={position.size} />
                      <Pair k="Entry" v={position.entry ?? "—"} />
                      <Pair k="Mark" v={position.mark ?? "—"} />
                    </dl>
                    <p className="mt-2 font-mono text-xs text-muted">{liquidationText(position.liquidation)}</p>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-muted">No open position was returned.</p>
          )}
          <button
            type="button"
            onClick={() => {
              if (watching) {
                setWatching(false);
                return;
              }
              const parsed = parsePublicAddress(account);
              if (!parsed.ok) {
                setError(parsed.error);
                return;
              }
              if (!limits.ok) {
                setError(limits.error);
                return;
              }
              setError(null);
              setWatching(true);
            }}
            className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-accent font-semibold text-accent"
          >
            <Play className="size-4" />
            {watching ? "Stop Monitoring" : "Start Monitoring"}
          </button>
          <p className="mt-2 text-center text-xs text-muted">
            {watching ? "Guardian is re-reading this public account." : "Guardian will keep checking your account health."}
          </p>
        </section>

        <details className="rounded-2xl border border-line bg-surface p-4">
          <summary className="cursor-pointer text-sm font-medium">Thresholds and monitor log</summary>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <Field label="Warning below" value={warning} onChange={setWarning} />
            <Field label="Danger below" value={danger} onChange={setDanger} />
            <Field label="Critical below" value={critical} onChange={setCritical} />
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setWatching(false);
              void pull("");
            }}
            className="mt-3 h-11 rounded-xl border border-line px-4 text-sm font-medium disabled:opacity-50"
          >
            Markets only
          </button>
          {!limits.ok ? <p className="mt-2 text-sm text-danger">{limits.error}</p> : null}
          {events.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No account read yet. Nothing is sent.</p>
          ) : (
            <ol className="mt-3 flex flex-col gap-2">
              {events.map((line) => (
                <li key={line.id} className="border-l-2 border-line pl-3 text-sm text-fg">
                  {line.message}
                </li>
              ))}
            </ol>
          )}
        </details>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {read ? (
          <p className="font-mono text-xs text-muted">
            chain {read.chainId} · signer none · bank {short(read.system.marginBank)}
          </p>
        ) : null}
      </div>

      <section className={screen === "protection" ? "order-3 rounded-2xl border border-line bg-surface p-4" : "hidden"}>
        <h2 className="text-base font-semibold">Recommended Actions</h2>
        <p className="mt-1 text-sm text-muted">Unsigned previews only. Neither path can submit, grant, or arm a stop.</p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Field label="Requested reduction %" value={requestedPct} onChange={setRequestedPct} />
          <Field label="Max reduction %" value={maxPct} onChange={setMaxPct} />
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={includeWarning} onChange={(event) => setIncludeWarning(event.target.checked)} />
          Protection may also propose on warning
        </label>
        <div className="mt-3 flex flex-col gap-2">
          <ActionRow
            title={proposals?.[0]?.label ?? "Reduce position"}
            detail="Preview a reduction. Nothing is sent."
            disabled={previewing || journal.disarmed}
            onClick={() => runPreview("protection")}
            label={previewing ? "Previewing…" : "Preview"}
          />
          <ActionRow
            title="Demonstration preview"
            detail="Can preview a healthy position. Still unsigned."
            disabled={previewing || journal.disarmed}
            onClick={() => runPreview("demo")}
            label="Preview"
          />
          <button
            type="button"
            onClick={() => {
              const next = disarm(journal);
              setJournal(next);
              window.localStorage.setItem("guardian.execution.journal", serializeJournal(next));
            }}
            className="h-11 rounded-xl border border-line text-sm font-medium text-warning"
          >
            Disarm
          </button>
        </div>
        {journal.disarmed ? <p className="mt-2 text-sm text-warning">Disarmed. New previews are refused.</p> : null}
        {previewError ? <p className="mt-2 text-sm text-danger">{previewError}</p> : null}
        {proposals ? (
          <ul className="mt-3 flex flex-col gap-3">
            {proposals.map((proposal) => (
              <li key={`${proposal.pool}-${proposal.market}-${proposal.intentId ?? proposal.state}`} className="rounded-xl border border-line bg-raised px-3 py-3 text-sm">
                <p className="font-mono text-xs text-accent">{proposal.label} · {proposal.state}</p>
                <dl className="mt-2 grid grid-cols-2 gap-2">
                  <Pair k="Account" v={short(proposal.account)} />
                  <Pair k="Market" v={proposal.market} />
                  <Pair k="Position" v={proposal.positionDirection} />
                  <Pair k="Size" v={proposal.currentSize} />
                  <Pair k="Order" v={proposal.protectiveDirection} />
                  <Pair k="Raw quantity" v={proposal.proposedQuantity} />
                  <Pair k="Reduction" v={proposal.reductionBps ? `${(Number(proposal.reductionBps) / 100).toFixed(2)}%` : "—"} />
                  <Pair k="Block" v={proposal.block} />
                  <Pair k="Health" v={proposal.healthRatio ? `${proposal.healthRatio}×` : "—"} />
                  <Pair k="Risk" v={proposal.risk} />
                </dl>
                <p className="mt-2 text-muted">{proposal.reason}</p>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </>
  );
}

function toSnapshot(read: ProtocolRead): AccountSnapshot {
  const account = read.account;
  if (!account) {
    return { equity: "0", mmReq: "0", healthAgrees: true, marginBlock: "0", positions: [] };
  }
  return {
    equity: account.margin.equity,
    mmReq: account.margin.mmReq,
    healthAgrees: account.accountHealth.agreesWithMarginAccount,
    marginBlock: account.margin.asOfBlock,
    positions: account.positions.map((position) => ({
      symbol: position.symbol,
      size: position.position.size,
      baseDecimals: position.baseDecimals,
      priceable: position.priceable,
      poolPriceable: position.poolPriceable,
      asOfBlock: position.asOfBlock,
      entry: position.avgEntryPrice ?? position.position.avgEntryPrice,
      mark: position.markPrice ?? null,
      liquidationPrice: position.liquidationPrice,
    })),
  };
}

function HealthCard({ assessment }: { assessment: Assessment }) {
  const tone = bandTone(assessment.band);
  const ratio = assessment.ratio == null ? null : Number(assessment.ratio);
  const width = ratio != null && Number.isFinite(ratio) ? Math.max(6, Math.min(100, (ratio / 3.5) * 100)) : 6;
  return (
    <div className="mt-4">
      <div className="flex items-center gap-3">
        <span className={"grid size-11 place-items-center rounded-full bg-raised " + tone.text}>
          <Shield className="size-5" />
        </span>
        <div>
          <p className={"text-2xl font-semibold " + tone.text}>{tone.label}</p>
          <p className="text-sm text-muted">{assessment.reason}</p>
        </div>
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-raised">
        <div className={"h-full rounded-full " + tone.bar} style={{ width: `${width}%` }} />
      </div>
      <dl className="mt-4 grid grid-cols-3 gap-2">
        <Pair k="Health Ratio" v={assessment.ratio ? `${assessment.ratio}×` : "—"} />
        <Pair k="Margin Equity" v={formatPx(quoteToNumber(assessment.equity))} />
        <Pair k="Maintenance" v={formatPx(quoteToNumber(assessment.mmReq))} />
      </dl>
    </div>
  );
}

function bandTone(band: RiskBand): { label: string; text: string; bar: string } {
  if (band === "clear") return { label: "Healthy", text: "text-healthy", bar: "bg-healthy" };
  if (band === "warning") return { label: "Warning", text: "text-warning", bar: "bg-warning" };
  if (band === "danger") return { label: "Danger", text: "text-danger", bar: "bg-danger" };
  if (band === "critical") return { label: "Critical", text: "text-danger", bar: "bg-danger" };
  return { label: "Unavailable", text: "text-muted", bar: "bg-line" };
}

function chipRank(symbol: string): number {
  if (symbol === "BTC") return 0;
  if (symbol === "ETH") return 1;
  if (symbol === "SOL") return 2;
  return 3;
}

function liquidationText(view: Assessment["positions"][number]["liquidation"]): string {
  if (view.kind === "level") return `liq ${view.price} · distance ${view.distance}`;
  if (view.kind === "floored") return "liq 0 floored — not a liquidation level";
  if (view.kind === "flat") return "no liquidation price";
  if (view.kind === "unpriced") return "mark unpriceable — liquidation withheld";
  return view.reason;
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function AppHeader() {
  const { wallet, connect, disconnect } = useAppWallet();
  const status = connectionStatus(wallet.address, wallet.chainId);
  return (
    <header>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid size-9 shrink-0 place-items-center rounded-full border border-accent/40 text-accent">
            <Shield className="size-4" />
          </span>
          <div className="min-w-0">
            <h1 className="text-[15px] font-semibold leading-tight">Liquidation Guardian</h1>
            <p className="text-[11px] text-muted">Your futures risk companion</p>
          </div>
        </div>
        {wallet.address ? (
          <div className="shrink-0 text-right">
            <p className="flex items-center justify-end gap-1.5 font-mono text-[11px] text-fg">
              <span className={"size-1.5 rounded-full " + (status === "connected" ? "bg-healthy" : "bg-warning")} />
              {shortAddress(wallet.address)}
            </p>
            <p className="text-[10px] text-muted">
              {networkLabel(wallet.chainId)}
              {" · "}
              <button type="button" onClick={disconnect} className="text-accent">
                Disconnect
              </button>
            </p>
          </div>
        ) : (
          <button type="button" onClick={() => void connect()} className="h-9 shrink-0 rounded-full bg-accent px-3 text-[11px] font-semibold text-ink">
            Connect
          </button>
        )}
      </div>
      {wallet.error ? <p className="mt-2 text-right text-[11px] text-danger">{wallet.error}</p> : null}
    </header>
  );
}

function BottomNav({ screen, onChange }: { screen: Screen; onChange: (screen: Screen) => void }) {
  const items: Array<{ id: Screen; label: string; icon: typeof Home }> = [
    { id: "dashboard", label: "Dashboard", icon: Home },
    { id: "protection", label: "Protection", icon: Shield },
    { id: "trade", label: "Testnet Trade", icon: ChartNoAxesColumn },
  ];
  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-bg/95 backdrop-blur">
      <div className="mx-auto flex max-w-[430px] items-stretch justify-around px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2">
        {items.map((item) => {
          const active = screen === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onChange(item.id)}
              className={"flex min-h-12 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium " + (active ? "text-accent" : "text-muted")}
            >
              <Icon className="size-5" />
              {item.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function ActionRow({
  title,
  detail,
  label,
  disabled,
  onClick,
}: {
  title: string;
  detail: string;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-raised px-3 py-3">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted">{detail}</p>
      </div>
      <button type="button" disabled={disabled} onClick={onClick} className="h-9 shrink-0 rounded-lg border border-danger/60 px-3 text-sm font-medium text-danger disabled:opacity-50">
        {label}
      </button>
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      {label}
      <input
        value={value}
        inputMode="decimal"
        onChange={(event) => onChange(event.target.value)}
        className="h-11 rounded-lg border border-line bg-bg px-3 font-mono text-sm text-fg outline-none focus:border-accent"
      />
    </label>
  );
}

function Pair({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted">{k}</dt>
      <dd className="truncate font-mono text-fg">{v}</dd>
    </div>
  );
}

function num(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function roundInput(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1e8) / 1e8;
}
