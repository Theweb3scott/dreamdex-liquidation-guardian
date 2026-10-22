import { readHidekiProtocol } from "../src/lib/guardian/hideki-read.ts";
import { assessAccount, createReadGate, protectionDecision, type AccountSnapshot } from "../src/lib/guardian/monitor.ts";

const ACCOUNT = "0xd167376D0431131b4C2EC25e3581c6AF734794F3";

function snapshotOf(read: Awaited<ReturnType<typeof readHidekiProtocol>>): AccountSnapshot | null {
  if (!read.ok || !read.account) return null;
  const account = read.account;
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

const fixtures = [
  { label: "SIMULATED warning", equity: "180", mmReq: "100", block: "10" },
  { label: "SIMULATED danger", equity: "140", mmReq: "100", block: "10" },
  { label: "SIMULATED critical", equity: "100", mmReq: "100", block: "10" },
  { label: "SIMULATED stale", equity: "300", mmReq: "100", block: "10", priceable: false },
  { label: "SIMULATED inconsistent", equity: "300", mmReq: "100", block: "11" },
].map((fixture) => {
  const view = assessAccount({
    equity: fixture.equity,
    mmReq: fixture.mmReq,
    healthAgrees: true,
    marginBlock: "10",
    positions: [
      {
        symbol: "FIXTURE",
        size: "1",
        baseDecimals: 0,
        priceable: fixture.priceable !== false,
        poolPriceable: fixture.priceable !== false,
        asOfBlock: fixture.block,
        entry: "1",
        mark: "1",
        liquidationPrice: { price: "1" },
      },
    ],
  });
  return { label: fixture.label, band: view.band, ratio: view.ratio, decision: protectionDecision(view) };
});

const gate = createReadGate();
const cycles = [];
for (let index = 1; index <= 3; index += 1) {
  const startedAt = new Date().toISOString();
  const entered = gate.tryEnter();
  const secondEntered = gate.tryEnter();
  if (!entered || secondEntered) {
    throw new Error(`overlap gate failed on cycle ${index}: entered=${entered} second=${secondEntered}`);
  }
  const read = await readHidekiProtocol(ACCOUNT);
  const finishedAt = new Date().toISOString();
  gate.leave();
  const snapshot = snapshotOf(read);
  const view = snapshot ? assessAccount(snapshot) : null;
  cycles.push({
    index,
    startedAt,
    finishedAt,
    overlapSkipped: secondEntered === false,
    signer: read.ok ? read.walletAddress : null,
    ok: read.ok,
    error: read.ok ? null : read.error,
    chainId: read.ok ? read.chainId : null,
    block: snapshot?.marginBlock ?? null,
    healthAgrees: snapshot?.healthAgrees ?? null,
    status: read.ok ? read.account?.margin.status ?? null : null,
    equity: snapshot?.equity ?? null,
    mmReq: snapshot?.mmReq ?? null,
    band: view?.band ?? null,
    ratio: view?.ratio ?? null,
    priceable: snapshot?.positions.map((position) => ({
      symbol: position.symbol,
      priceable: position.priceable,
      poolPriceable: position.poolPriceable,
      asOfBlock: position.asOfBlock,
    })) ?? null,
    decision: view ? protectionDecision(view) : protectionDecision({ error: read.ok ? "no account" : read.error }),
  });
}

console.log(JSON.stringify({ fixtures, cycles }, null, 2));
