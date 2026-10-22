import { useEffect, useRef, useState } from "react";
import { readGuardianShield } from "@/lib/guardian/protocol";
import { allowWalletMethod, HIDEKI_CHAIN_ID } from "@/lib/guardian/review";
import { diffShield, localPreviewEvent, shieldHelp, shieldLayout, type ActivityEvent, type ShieldModel } from "@/lib/guardian/shield";
import type { IntelBook } from "@/lib/guardian/intelligence";
import { RiskIntelligence } from "@/components/risk-intelligence";

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

const HELP = shieldHelp();

export function GuardianShield() {
  const [address, setAddress] = useState("");
  const [chainId, setChainId] = useState<number | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState<ShieldModel | null>(null);
  const [intel, setIntel] = useState<IntelBook | null>(null);
  const [timeline, setTimeline] = useState<ActivityEvent[]>([]);
  const [width, setWidth] = useState(390);
  const modelRef = useRef<ShieldModel | null>(null);

  useEffect(() => {
    const read = () => setWidth(window.innerWidth);
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);

  const layout = shieldLayout(width);

  async function connect() {
    setWalletError(null);
    const eth = provider();
    if (!eth) {
      setWalletError("No browser wallet is available. Paste a public address to read it.");
      return;
    }
    try {
      allowWalletMethod("eth_requestAccounts");
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      const next = accounts[0];
      if (!next) throw new Error("The wallet returned no account.");
      allowWalletMethod("eth_chainId");
      const hex = (await eth.request({ method: "eth_chainId" })) as string;
      setAddress(next);
      setChainId(Number.parseInt(hex, 16));
    } catch (caught) {
      setWalletError(caught instanceof Error ? caught.message : "The wallet refused the connection.");
    }
  }

  async function load(target: string) {
    setLoading(true);
    setError(null);
    try {
      const result = await readGuardianShield({ data: target });
      if (!result.ok) {
        setTimeline((current) => [
          { id: `fail-${current.length}`, kind: "observed" as const, title: "observed", detail: `Read failed: ${result.error}` },
          ...current,
        ].slice(0, 24));
        setError(result.error);
        setIntel(null);
        return;
      }
      setModel(result.model);
      setIntel(result.intel);
      setTimeline((current) => {
        const observed = diffShield(modelRef.current, result.model);
        modelRef.current = result.model;
        return [localPreviewEvent(result.model), ...observed, ...current].slice(0, 24);
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The shield read failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="flex flex-col gap-4" data-columns={layout.columns}>
      <div className="flex flex-col gap-1">
        <p className="font-mono text-xs tracking-widest text-accent">GUARDIAN SHIELD · READ ONLY</p>
        <h2 className="text-xl font-semibold tracking-tight">Account protection</h2>
        <p className="max-w-2xl text-sm leading-relaxed text-muted">
          Live protocol values only. Blank fields were not returned. Nothing on this screen can sign, grant a permission, or arm a stop.
        </p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <button type="button" onClick={() => void connect()} className="h-11 rounded-lg bg-accent px-4 font-medium text-bg">
          {address ? "Reconnect wallet" : "Connect wallet"}
        </button>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted">
          Public address
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="0x public address"
            spellCheck={false}
            className="h-11 rounded-lg border border-line bg-bg px-3 font-mono text-sm text-fg outline-none focus:border-accent"
          />
        </label>
        <button
          type="button"
          disabled={loading || address.trim() === ""}
          onClick={() => void load(address)}
          className="h-11 rounded-lg border border-line px-4 font-medium text-fg disabled:opacity-50"
        >
          {loading ? "Reading…" : "Refresh shield"}
        </button>
      </div>
      <p className="text-sm text-muted">
        {address
          ? `${address} · wallet chain ${chainId ?? "not read"} · quotes come from Hideki v2, not from the wallet node`
          : "No wallet connected. A public address is enough for a read."}
        {chainId != null && chainId !== HIDEKI_CHAIN_ID ? " · wallet is not on chain 50383" : ""}
      </p>
      {walletError ? <p className="text-sm text-accent">{walletError}</p> : null}
      {error ? <p className="rounded-lg border border-line bg-surface px-3 py-3 text-sm text-accent">{error}</p> : null}

      {model ? <ShieldBody model={model} columns={layout.columns} timeline={timeline} /> : null}
      {intel ? <RiskIntelligence key={`${intel.address}:${intel.chainId}:${intel.refreshedAt}`} book={intel} walletChainId={chainId} /> : null}

      <details className="rounded-xl border border-line bg-surface p-4">
        <summary className="cursor-pointer text-sm font-medium">What these words mean</summary>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          {Object.entries(HELP).map(([key, text]) => (
            <div key={key}>
              <dt className="font-medium capitalize text-fg">{key}</dt>
              <dd className="mt-1 text-muted">{text}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}

function ShieldBody({ model, columns, timeline }: { model: ShieldModel; columns: 1 | 2; timeline: ActivityEvent[] }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Tile label="Network" value={model.network} hint={model.deploymentId} />
        <Tile label="Risk" value={model.band} hint={model.healthRatio ? `${model.healthRatio}×` : "not comparable"} warn={model.band !== "SAFE"} />
        <Tile label="Equity" value={model.equity ?? "—"} hint="protocol" />
        <Tile label="Maintenance" value={model.maintenance ?? "—"} hint="protocol" />
      </div>
      <p className="font-mono text-xs text-muted">Last refresh {model.refreshedAt} · signer none · send disabled</p>
      <p className="text-sm text-muted">{model.bandReason}</p>
      {model.warnings.length > 0 ? (
        <ul className="flex flex-col gap-1 rounded-lg border border-accent/50 bg-surface px-3 py-3 text-sm text-fg">
          {model.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      {model.positions.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface px-4 py-4 text-sm text-muted">No open position was returned.</p>
      ) : (
        <div className={columns === 1 ? "grid grid-cols-1 gap-3" : "grid grid-cols-1 gap-3 sm:grid-cols-2"}>
          {model.positions.map((position) => (
            <article key={position.pool} className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-lg font-semibold">{position.symbol}</h3>
                <p className="font-mono text-xs uppercase text-accent">{position.direction} · {position.protection.state}</p>
              </div>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <Fact label="Size" value={position.size} />
                <Fact label="Entry" value={position.entry} />
                <Fact label="Mark" value={position.mark} />
                <Fact label="Unrealized PnL" value={position.pnl} />
                <Fact label="Liquidation" value={position.liquidation} />
                <Fact label="Distance" value={position.distance} />
              </dl>
              {position.liquidationNote ? <p className="text-sm text-accent">{position.liquidationNote}</p> : null}
              <p className="text-sm text-muted">{position.protection.reason}</p>
              <div className="rounded-lg border border-line bg-bg px-3 py-3 text-sm">
                <p className="font-medium">Stops</p>
                {position.stops.length === 0 ? (
                  <p className="mt-1 text-muted">No pending stop was listed.</p>
                ) : (
                  <ul className="mt-2 flex flex-col gap-2">
                    {position.stops.map((stop) => (
                      <li key={stop.orderId} className="font-mono text-xs text-fg">
                        {stop.live} · {stop.direction} · qty {stop.quantity ?? "—"} · trigger {stop.trigger ?? "—"} · SOMI wei {stop.somiPaid ?? "—"} · {stop.intent}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-muted">Coverage {position.coverage ?? "unknown"}</p>
              </div>
              <div className="rounded-lg border border-line bg-bg px-3 py-3 text-sm">
                <p className="font-medium">Operator permission</p>
                <p className="mt-1 break-all font-mono text-xs text-muted">
                  {position.permission.registry ?? "registry unread"} · {position.permission.selector} · {position.permission.scope}
                </p>
                <p className="mt-2 text-muted">
                  Pool approval {flag(position.permission.poolApproved)} · global {flag(position.permission.globalApproved)} · permission required {position.permission.required ? "yes" : "no"}
                  {position.permission.revokeRecommended ? " · revocation recommended" : ""}
                </p>
                {position.permission.warning ? <p className="mt-2 text-accent">{position.permission.warning}</p> : null}
              </div>
              <div className="rounded-lg border border-dashed border-line px-3 py-3 text-sm">
                <p className="font-mono text-xs tracking-widest text-accent">REDUCE-ONLY PLAN · NOT ARMED</p>
                <p className="mt-2 text-fg">{position.plan.reason}</p>
                <dl className="mt-2 grid grid-cols-2 gap-2">
                  <Fact label="Suggested quantity" value={position.plan.quantity} />
                  <Fact label="Trigger" value={position.plan.trigger} />
                  <Fact label="Minimum" value={position.plan.minQuantity} />
                  <Fact label="Lot" value={position.plan.lotSize} />
                  <Fact label="SOMI wei" value={position.plan.somiWei} />
                  <Fact label="New stop needed" value={position.plan.needed == null ? "unknown" : position.plan.needed ? "yes" : "no"} />
                </dl>
              </div>
            </article>
          ))}
        </div>
      )}
      <div className="rounded-xl border border-line bg-surface p-4">
        <h3 className="text-sm font-medium">Activity</h3>
        <p className="mt-1 text-xs text-muted">Observed means the read changed. Local means this app prepared a preview. Verified would require a receipt, and none is claimed here.</p>
        {timeline.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No activity yet.</p>
        ) : (
          <ol className="mt-3 flex flex-col gap-2">
            {timeline.map((item) => (
              <li key={item.id} className="border-l-2 border-line pl-3 text-sm">
                <span className="font-mono text-xs text-accent">{item.kind}</span>
                <span className="mt-1 block text-fg">{item.detail}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function Tile({ label, value, hint, warn = false }: { label: string; value: string; hint: string; warn?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={"mt-1 truncate font-mono text-sm " + (warn ? "text-accent" : "text-fg")}>{value}</p>
      <p className="mt-1 truncate text-xs text-muted">{hint}</p>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="truncate font-mono text-fg">{value ?? "—"}</dd>
    </div>
  );
}

function flag(value: boolean | null): string {
  if (value == null) return "unknown";
  return value ? "yes" : "no";
}

function provider(): Eip1193 | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as Window & { ethereum?: Eip1193 }).ethereum;
  if (!candidate || typeof candidate.request !== "function") return null;
  return candidate;
}
