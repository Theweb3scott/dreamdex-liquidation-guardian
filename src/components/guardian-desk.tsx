import { useEffect, useMemo, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { WalletReview } from "@/components/wallet-review";
import { ManualTestOrder } from "@/components/manual-order";
import { GuardianShield } from "@/components/guardian-shield";
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

const STALE_SEC = 180;

export function GuardianDesk() {
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
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-5 px-4 py-5 sm:px-6 sm:py-8">
      <header className="flex flex-col gap-3 border-b border-line pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-1 size-6 shrink-0 text-accent" aria-hidden="true" />
          <div>
            <p className="font-mono text-xs tracking-widest text-muted">HIDEKI · CHAIN 50383 · DRY-RUN</p>
            <h1 className="text-2xl font-semibold tracking-tight">Liquidation Guardian</h1>
            <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted">
              Indexer marks feed the scenario calculator only. Account risk uses the protocol snapshot.
              Orders stay disarmed.
            </p>
          </div>
        </div>
        <p className="font-mono text-xs text-accent">No key · no withdraw · no send</p>
      </header>

      <ProtocolPanel />

      <GuardianShield />

      <WalletReview />

      <ManualTestOrder />

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium">Markets</h2>
          <p className="font-mono text-xs text-muted">
            {quotes === null ? "Loading indexer…" : loadError ? "Indexer unavailable" : `${quotes.length} perps`}
          </p>
        </div>
        {loadError ? (
          <p className="rounded-lg border border-line bg-surface px-3 py-3 text-sm text-muted">{loadError}</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {(quotes ?? []).map((item) => {
            const selected = item.symbol === symbol;
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
                  "h-11 min-w-16 rounded-lg border px-3 font-mono text-sm transition-colors " +
                  (selected
                    ? "border-accent bg-raised text-fg"
                    : "border-line bg-surface text-muted hover:text-fg")
                }
              >
                {item.symbol}
              </button>
            );
          })}
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-4">
        <Stat label="Mark" value={mark ? formatPx(mark) : "—"} hint={quote ? formatAge(ageSec) : "no row"} warn={Boolean(quote) && ageSec > STALE_SEC} />
        <Stat label="Index" value={index ? formatPx(index) : "—"} hint="indexer" />
        <Stat label="Initial margin" value={quote ? `${(view.im / 100).toFixed(2)}%` : "—"} hint="from market row" />
        <Stat
          label="Open interest"
          value={quote ? formatPx(quoteToNumber(quote.openInterest, quote.baseDecimals)) : "—"}
          hint={quote ? quote.symbol : ""}
        />
      </section>

      <details className="rounded-xl border border-line bg-surface p-4">
        <summary className="cursor-pointer text-sm font-medium">Scenario calculator — not live account data</summary>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <form
          className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4"
          onSubmit={(event) => {
            event.preventDefault();
            runCheck();
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium">Simulated scenario</h2>
            <p className="font-mono text-xs text-muted">Not the account monitor</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(["long", "short"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setSide(option)}
                className={
                  "h-11 rounded-lg border font-medium capitalize transition-colors " +
                  (side === option ? "border-accent bg-raised text-fg" : "border-line text-muted")
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
          <button type="submit" className="h-11 rounded-lg bg-accent font-medium text-bg transition-opacity hover:opacity-90">
            Check protection
          </button>
          <button
            type="button"
            disabled={!pending}
            onClick={applySimulatedFill}
            className="h-11 rounded-lg border border-line font-medium text-fg disabled:cursor-not-allowed disabled:opacity-40"
          >
            Apply simulated fill
          </button>
        </form>

        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-line bg-surface p-4">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-medium">Estimated health</h2>
              <p className={"font-mono text-sm " + (stressed ? "text-accent" : "text-fg")}>{view.band}</p>
            </div>
            <p className="mt-3 font-mono text-3xl font-medium tracking-tight">{ratioLabel}</p>
            <p className="mt-1 text-sm text-muted">Equity over maintenance. 1.00× is the liquidation line.</p>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-raised">
              <div className="h-full bg-accent" style={{ width: `${bar}%` }} />
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <Pair k="Equity" v={formatPx(view.equity)} />
              <Pair k="Unrealized" v={formatPx(view.pnl)} />
              <Pair k="Maintenance" v={formatPx(view.mmReq)} />
              <Pair k="Initial" v={formatPx(view.imReq)} />
              <Pair k="Liq. price" v={view.liq == null ? "—" : formatPx(view.liq)} />
              <Pair
                k="Distance"
                v={view.distance == null ? "—" : `${(view.distance * 100).toFixed(2)}%`}
              />
            </dl>
          </div>
          <div className="rounded-xl border border-line bg-surface p-4">
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
        </div>
      </div>
      </details>
    </main>
  );
}

function ProtocolPanel() {
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
  const bandRef = useRef<RiskBand | null>(null);
  const gate = useRef(createReadGate());
  const seq = useRef(0);
  const limitsRef = useRef({ warning, danger, critical });
  limitsRef.current = { warning, danger, critical };

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
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 className="text-sm font-medium">Account monitor</h2>
        <p className="font-mono text-xs text-muted">SDK 0.32.1 · read only · no signer</p>
      </div>
      <p className="text-sm leading-relaxed text-muted">
        Health is equity over maintenance from the margin account, and only when that read matches account
        health on one block. The scenario below is not used.
      </p>
      <input
        value={account}
        onChange={(event) => {
          setAccount(event.target.value);
          setWatching(false);
        }}
        placeholder="0x public address"
        spellCheck={false}
        className="h-11 rounded-lg border border-line bg-bg px-3 font-mono text-sm text-fg outline-none focus:border-accent"
      />
      <div className="grid grid-cols-3 gap-2">
        <Field label="Warning below" value={warning} onChange={setWarning} />
        <Field label="Danger below" value={danger} onChange={setDanger} />
        <Field label="Critical below" value={critical} onChange={setCritical} />
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="flex h-11 items-center gap-2 rounded-lg border border-line px-3 text-sm text-muted">
          Refresh
          <select
            value={intervalSec}
            onChange={(event) => setIntervalSec(Number(event.target.value))}
            className="bg-transparent font-mono text-fg outline-none"
          >
            <option value={15}>15s</option>
            <option value={30}>30s</option>
            <option value={60}>60s</option>
            <option value={120}>120s</option>
          </select>
        </label>
        <button
          type="button"
          disabled={pending && !watching}
          onClick={readAccount}
          className="h-11 rounded-lg bg-accent px-4 font-medium text-bg disabled:opacity-50"
        >
          {pending ? "Reading…" : "Read account"}
        </button>
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
          className="h-11 rounded-lg border border-line px-4 font-medium text-fg"
        >
          {watching ? "Stop watch" : "Watch"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setWatching(false);
            void pull("");
          }}
          className="h-11 rounded-lg border border-line px-4 font-medium text-fg disabled:opacity-50"
        >
          Markets only
        </button>
      </div>
      <div className="rounded-lg border border-dashed border-line p-3">
        <p className="font-mono text-xs tracking-widest text-accent">NO SIGNER · NO SEND</p>
        <p className="mt-1 text-sm text-muted">
          Demonstration can preview a healthy position. Protection only proposes at danger or critical. Neither path can submit.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Field label="Requested reduction %" value={requestedPct} onChange={setRequestedPct} />
          <Field label="Max reduction %" value={maxPct} onChange={setMaxPct} />
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            checked={includeWarning}
            onChange={(event) => setIncludeWarning(event.target.checked)}
          />
          Protection may also propose on warning
        </label>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <button type="button" disabled={previewing || journal.disarmed} onClick={() => runPreview("demo")} className="h-11 rounded-lg border border-line px-4 font-medium text-fg disabled:opacity-50">
            {previewing ? "Previewing…" : "Demo preview"}
          </button>
          <button type="button" disabled={previewing || journal.disarmed} onClick={() => runPreview("protection")} className="h-11 rounded-lg border border-line px-4 font-medium text-fg disabled:opacity-50">
            Protection preview
          </button>
          <button
            type="button"
            onClick={() => {
              const next = disarm(journal);
              setJournal(next);
              window.localStorage.setItem("guardian.execution.journal", serializeJournal(next));
            }}
            className="h-11 rounded-lg border border-line px-4 font-medium text-accent"
          >
            Disarm
          </button>
        </div>
        {journal.disarmed ? <p className="mt-2 text-sm text-accent">Disarmed. New previews are refused.</p> : null}
        {previewError ? <p className="mt-2 text-sm text-accent">{previewError}</p> : null}
        {proposals ? (
          <ul className="mt-3 flex flex-col gap-3">
            {proposals.map((proposal) => (
              <li key={`${proposal.pool}-${proposal.market}-${proposal.intentId ?? proposal.state}`} className="rounded-lg border border-line bg-bg px-3 py-3 text-sm">
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
      </div>
      {!limits.ok ? <p className="text-sm text-accent">{limits.error}</p> : null}
      {error ? <p className="text-sm text-accent">{error}</p> : null}
      {read ? <ProtocolBody read={read} assessment={assessment} /> : null}
      <div>
        <h3 className="text-sm font-medium">Monitor log</h3>
        {events.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No account read yet. Nothing is sent.</p>
        ) : (
          <ol className="mt-2 flex flex-col gap-2">
            {events.map((line) => (
              <li key={line.id} className="border-l-2 border-line pl-3 text-sm text-fg">
                {line.message}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
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

function ProtocolBody({ read, assessment }: { read: ProtocolRead; assessment: Assessment | null }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="font-mono text-xs text-muted">
        chain {read.chainId} · signer {read.signerConnected ? "yes" : "none"} · bank {short(read.system.marginBank)}
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        {read.markets.map((market) => (
          <div key={market.symbol} className="rounded-lg border border-line bg-bg px-3 py-3">
            <p className="text-sm font-medium">{market.symbol}</p>
            <p className="mt-1 font-mono text-sm text-fg">
              {market.health.priceable ? formatPx(quoteToNumber(market.health.markPrice)) : "unpriceable"}
            </p>
            <p className="mt-1 font-mono text-xs text-muted">
              MM {Number(market.risk.maintenanceMarginBps) / 100}%
              {market.health.priceable ? "" : " · mark withheld"}
            </p>
          </div>
        ))}
      </div>
      {assessment ? (
        <div className="rounded-lg border border-line bg-bg px-3 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <p className="font-mono text-xs text-muted">{read.account?.address}</p>
            <p className="font-mono text-sm text-accent">{assessment.band}</p>
          </div>
          <p className="mt-2 font-mono text-3xl">{assessment.ratio ? `${assessment.ratio}×` : "—"}</p>
          <p className="mt-1 text-sm text-muted">{assessment.reason}</p>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <Pair k="Equity" v={formatPx(quoteToNumber(assessment.equity))} />
            <Pair k="Maintenance" v={formatPx(quoteToNumber(assessment.mmReq))} />
          </dl>
          <ul className="mt-3 flex flex-col gap-3">
            {assessment.positions.length === 0 ? (
              <li className="text-sm text-muted">No active perp pools.</li>
            ) : (
              assessment.positions.map((position) => (
                <li key={position.symbol} className="text-sm">
                  <p className="font-medium">
                    {position.symbol} · {position.direction}
                  </p>
                  <p className="font-mono text-xs text-muted">
                    size {position.size} · entry {position.entry ?? "—"} · mark {position.mark ?? "—"}
                  </p>
                  <p className="font-mono text-xs text-muted">{liquidationText(position.liquidation)}</p>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-muted">No account in this snapshot.</p>
      )}
    </div>
  );
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

function Stat({ label, value, hint, warn }: { label: string; value: string; hint: string; warn?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 truncate font-mono text-lg text-fg">{value}</p>
      <p className={"mt-1 font-mono text-xs " + (warn ? "text-accent" : "text-muted")}>{hint}</p>
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
