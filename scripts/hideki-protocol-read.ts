import { writeFileSync } from "node:fs";
import { findSampleHolder, readHidekiProtocol } from "../src/lib/guardian/hideki-read.ts";

const marketOnly = await readHidekiProtocol();
const holder = await findSampleHolder();
const account = holder.ok ? await readHidekiProtocol(holder.account) : null;
const evidence = { marketOnly, holder, account };
writeFileSync("/workspace/artifacts/hideki-protocol-read.json", JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({
  marketOk: marketOnly.ok,
  chainId: marketOnly.ok ? marketOnly.chainId : undefined,
  signer: marketOnly.ok ? marketOnly.walletAddress : undefined,
  called: marketOnly.ok ? marketOnly.called : marketOnly.called,
  markets: marketOnly.ok
    ? marketOnly.markets.map((m) => ({
        symbol: m.symbol,
        maintenanceMarginBps: m.risk.maintenanceMarginBps,
        health: m.health,
      }))
    : marketOnly.error,
  system: marketOnly.ok ? marketOnly.system : undefined,
  holder,
  accountStatus: account && account.ok ? account.account?.margin.status : account,
  equityOverMaintenance: account && account.ok ? account.account?.margin.equityOverMaintenance : undefined,
  positions: account && account.ok
    ? account.account?.positions.map((p) => ({
        symbol: p.symbol,
        priceable: p.priceable,
        size: p.size,
        maintenanceMarginBps: p.maintenanceMarginBps,
        liquidationPrice: p.liquidationPrice,
        asOfBlock: p.asOfBlock,
      }))
    : undefined,
}, null, 2));
