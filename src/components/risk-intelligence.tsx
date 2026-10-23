import { useMemo, useState } from "react";
import {
  parseCollateral,
  percentToBps,
  scanPortfolio,
  scenarioMatches,
  simulate,
  type Figure,
  type IntelBook,
} from "@/lib/guardian/intelligence";
import { HIDEKI_CHAIN_ID } from "@/lib/guardian/review";

const PRESETS = [1, 3, 5, 10];

export function RiskIntelligence({ book, walletChainId }: { book: IntelBook; walletChainId: number | null }) {
  const [direction, setDirection] = useState<"up" | "down">("down");
  const [preset, setPreset] = useState<number | "custom">(5);
  const [custom, setCustom] = useState("5");
  const [allMarkets, setAllMarkets] = useState(true);
  const [pool, setPool] = useState(book.positions[0]?.pool ?? "");
  const [reduceBps, setReduceBps] = useState(0);
  const [collateral, setCollateral] = useState("");
  const [collateralSide, setCollateralSide] = useState<"deposit" | "withdraw">("deposit");
  const scan = useMemo(() => scanPortfolio(book), [book]);
  const parsed = percentToBps(preset === "custom" ? custom : String(preset), direction);
  const cash = parseCollateral(collateral, collateralSide);
  const shockPools = allMarkets ? book.positions.filter((position) => position.priceable).map((position) => position.pool) : pool ? [pool] : [];
  const result = parsed.ok && cash.ok
    ? simulate(book, {
        shockBps: parsed.bps,
        shockPools,
        reducePool: reduceBps > 0 ? pool : null,
        reduceBps,
        collateralRaw: cash.raw,
      })
    : null;
  const current = result != null && scenarioMatches(result, book);

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border border-line bg-surface p-4">
        <p className="font-mono text-xs tracking-widest text-accent">PORTFOLIO · PROTOCOL READS</p>
        <h3 className="mt-1 text-lg font-semibold">Exposure</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted">{scan.summary}</p>
        {walletChainId != null && walletChainId !== HIDEKI_CHAIN_ID ? (
          <p className="mt-2 text-sm text-accent">The wallet is not on chain 50383. These figures are still the Hideki v2 read.</p>
        ) : null}
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Metric label="Long notional" figure={scan.longNotional} />
          <Metric label="Short notional" figure={scan.shortNotional} />
          <Metric label="Gross absolute" figure={scan.grossNotional} />
        </div>
        <p className="mt-3 text-sm text-muted">
          Live health {scan.health.band}
          {scan.health.ratio ? ` · ${scan.health.ratio}×` : ""} · {scan.health.reason}
        </p>
        {scan.largest ? (
          <p className="mt-1 text-sm text-fg">
            Largest priced market: {scan.largest.symbol} · {scan.largest.share}
          </p>
        ) : null}
        {scan.warnings.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-1 text-sm text-accent">
            {scan.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
        <ul className="mt-3 flex flex-col gap-2">
          {scan.legs.map((leg) => (
            <li key={leg.pool} className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-bg px-3 py-2 text-sm sm:grid-cols-4">
              <span className="font-medium">{leg.symbol} · {leg.direction}</span>
              <span className="font-mono text-muted">size {leg.size ?? "—"}</span>
              <span className="font-mono">{leg.notional.kind === "unknown" ? "notional UNKNOWN" : leg.notional.text}</span>
              <span className="font-mono">{leg.pnl.kind === "unknown" ? "PnL UNKNOWN" : leg.pnl.text}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border border-dashed border-line bg-surface p-4">
        <p className="font-mono text-xs tracking-widest text-accent">WHAT-IF · ESTIMATE ONLY</p>
        <h3 className="mt-1 text-lg font-semibold">What If? Simulation</h3>
        <p className="mt-2 text-sm text-muted">Nothing here is sent, deposited, withdrawn, or reduced. Estimated health is not a protocol classification.</p>
        {result && !current ? <p className="mt-2 text-sm text-accent">This scenario belongs to a different account or network and was discarded.</p> : null}
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {(["down", "up"] as const).map((option) => (
              <button key={option} type="button" onClick={() => setDirection(option)} className={chip(direction === option)}>
                Mark {option}
              </button>
            ))}
            {PRESETS.map((value) => (
              <button key={value} type="button" onClick={() => setPreset(value)} className={chip(preset === value)}>
                {value}%
              </button>
            ))}
            <button type="button" onClick={() => setPreset("custom")} className={chip(preset === "custom")}>
              Custom
            </button>
          </div>
          {preset === "custom" ? (
            <label className="flex flex-col gap-1 text-xs text-muted">
              Custom percent
              <input value={custom} onChange={(event) => setCustom(event.target.value)} inputMode="decimal" className="h-11 rounded-lg border border-line bg-bg px-3 font-mono text-sm text-fg" />
            </label>
          ) : null}
          {!parsed.ok ? <p className="text-sm text-accent">{parsed.error}</p> : null}
          <label className="flex items-center gap-2 text-sm text-fg">
            <input type="checkbox" checked={allMarkets} onChange={(event) => setAllMarkets(event.target.checked)} />
            Shock every priced market together
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Position
            <select value={pool} onChange={(event) => setPool(event.target.value)} className="h-11 rounded-lg border border-line bg-bg px-3 text-sm text-fg">
              {book.positions.map((position) => (
                <option key={position.pool} value={position.pool}>
                  {position.symbol}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            {[0, 25, 50, 75, 100].map((value) => (
              <button key={value} type="button" onClick={() => setReduceBps(value * 100)} className={chip(reduceBps === value * 100)}>
                {value === 0 ? "No reduction" : `Reduce ${value}%`}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="flex gap-2">
              {(["deposit", "withdraw"] as const).map((option) => (
                <button key={option} type="button" onClick={() => setCollateralSide(option)} className={chip(collateralSide === option)}>
                  {option}
                </button>
              ))}
            </div>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Hypothetical collateral
              <input value={collateral} onChange={(event) => setCollateral(event.target.value)} inputMode="decimal" placeholder="0" className="h-11 rounded-lg border border-line bg-bg px-3 font-mono text-sm text-fg" />
            </label>
          </div>
          {!cash.ok ? <p className="text-sm text-accent">{cash.error}</p> : null}
        </div>

        {current ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="py-2 pr-3 font-medium">Market</th>
                  <th className="py-2 pr-3 font-medium">Observed</th>
                  <th className="py-2 font-medium">Hypothetical estimate</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={row.symbol} className="border-t border-line align-top">
                    <td className="py-2 pr-3 font-medium">{row.symbol}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-muted">
                      mark {row.observedMark ?? "—"}
                      <br />
                      size {row.observedSize ?? "—"}
                      <br />
                      PnL {textOf(row.observedPnl)}
                    </td>
                    <td className="py-2 font-mono text-xs">
                      mark {textOf(row.hypotheticalMark)}
                      <br />
                      size {row.hypotheticalSize ?? "UNKNOWN"}
                      <br />
                      PnL {textOf(row.hypotheticalPnl)}
                      <br />
                      change {textOf(row.pnlChange)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-line">
                  <td className="py-2 pr-3">Account equity</td>
                  <td className="py-2 pr-3 font-mono text-xs">{textOf(result.observedEquity)}</td>
                  <td className="py-2 font-mono text-xs">{textOf(result.estimatedEquity)}</td>
                </tr>
                <tr className="border-t border-line">
                  <td className="py-2 pr-3">Maintenance</td>
                  <td className="py-2 pr-3 font-mono text-xs">{textOf(result.observedMaintenance)}</td>
                  <td className="py-2 font-mono text-xs">{textOf(result.estimatedMaintenance)}</td>
                </tr>
                <tr className="border-t border-line">
                  <td className="py-2 pr-3">Health</td>
                  <td className="py-2 pr-3 font-mono text-xs">{book.band}</td>
                  <td className="py-2 font-mono text-xs">
                    {result.estimatedHealth.band}
                    {result.estimatedHealth.ratio ? ` · ${result.estimatedHealth.ratio}×` : ""}
                  </td>
                </tr>
              </tbody>
            </table>
            <ul className="mt-3 flex flex-col gap-1 text-sm text-muted">
              {result.explanation.map((line) => (
                <li key={line}>{line}</li>
              ))}
              {result.notes.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function Metric({ label, figure }: { label: string; figure: Figure }) {
  return (
    <div className="rounded-lg border border-line bg-bg px-3 py-2">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 font-mono text-sm text-fg">{figure.kind === "unknown" ? "UNKNOWN" : figure.text}</p>
      <p className="mt-1 text-xs text-muted">{figure.kind === "unknown" ? figure.reason : figure.kind === "protocol" ? "protocol read" : "estimate"}</p>
    </div>
  );
}

function textOf(figure: Figure): string {
  return figure.kind === "unknown" ? "UNKNOWN" : `${figure.text} · ${figure.kind}`;
}

function chip(active: boolean): string {
  return "h-10 rounded-lg border px-3 text-sm " + (active ? "border-accent bg-raised text-fg" : "border-line text-muted");
}
