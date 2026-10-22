# Liquidation Guardian

Read-only liquidation-risk monitor for dreamDEX Perps on Somnia Hideki testnet.

This is not an automated liquidation bot. It reads public protocol state, classifies cross-margin health, and prepares unsigned protective proposals. It does not hold a signer, does not submit transactions, and cannot grant an operator permission.

Proposed public repository: [Theweb3scott/dreamdex-liquidation-guardian](https://github.com/Theweb3scott/dreamdex-liquidation-guardian).

## Problem

A cross-margin perpetual is liquidated when account equity falls through the protocol maintenance requirement. Watching that by hand is slow. An immediate opposite-side order is not reduce-only, so it can shrink a position and then reverse it. Liquidation Guardian shows the protocol's own numbers and stops before any signature.

## What it does

- Reads a public address, or the address a browser wallet reports, on Hideki chain 50383.
- Verifies the dreamDEX v2 deployment before trusting a quote. Chain id 50383 is shared, so the app also checks network version, the pinned RPC host, and the margin-bank and factory contracts.
- Shows equity, maintenance, health, position size, direction, entry, mark, unrealized PnL, and the protocol liquidation price.
- Classifies the account as SAFE, WARNING, DANGER, CRITICAL, or UNKNOWN. Health is equity divided by maintenance only when both values are comparable. A liquidation price of 0 is a floor, not a price.
- Lists pending stop orders, prepaid SOMI, and pool versus global operator approval. It does not grant or revoke anything.
- Previews a protocol-enforced reduce-only stop. It does not arm one.
- Runs a portfolio scanner and a what-if simulator. Simulated health is labeled as an estimate. If the protocol formula cannot be reproduced, the result is UNKNOWN.
- Keeps a local activity log that separates protocol reads, observed changes, and local previews. It does not invent transaction history.

## dreamDEX SDK

Package: `@somnia-chain/markets-sdk` 0.32.1, chain helper `hidekiTestnet`.

| Method | Use |
|---|---|
| `listPerpMarkets` | Registered perp pools |
| `getPerpSystemConfig` | Margin bank, collateral, factory |
| `getPerpRiskParams` | Maintenance rate and taker fee |
| `getPerpHealthSnapshot` | Mark, funding index, base unit, priceable flag |
| `getMarginAccount` | Equity, maintenance, block |
| `getAccountHealth` | Second health read, compared with the margin account |
| `listPerpPositionAnalytics` | Open positions, notional, unrealized PnL |
| `getPerpPosition` | Signed size and entry |
| `getLiquidationPrice` | Protocol liquidation price |
| `getOwnOpenOrdersOnchain` | Resting orders, via `eth_call` impersonation, no signature |
| `listPerpStopOrders` / `getPerpStopOrder` | Pending stops and whether they are still live |

`perpPositionAnalytics` is the integer formula behind the what-if panel. The app does not call `placePerpOrder`, `placeOrderFor`, or `createPendingOrder`.

Indexer used for the market strip: `https://hideki-dev.smk.somnia.host/v1/graphql`.

## Hideki

| Setting | Value |
|---|---|
| Network | Somnia Hideki testnet, dreamDEX v2 |
| Chain id | 50383 |
| Client | `SomniaMarkets` with `hidekiTestnet` |
| Signer | Not passed |

Contract addresses come from `SOMNIA_HIDEKI_TESTNET_ADDRESSES` and `getPerpSystemConfig`.

## Install

```bash
npm ci
cp .env.example .env.local
npm run dev
```

The dev server listens on port 8080. No environment variable is required for a Hideki read. Paste a public address. Do not paste a private key.

```bash
npm run typecheck
npm run check:unsigned
npm test
npm run build
```

`check:unsigned` fails if `src` calls `createTrader`, `placePerpOrder`, or `placeOrderFor`, or if guardian code contains a private key.

## Environment

See [.env.example](.env.example). Every secret slot is blank. There is no `PRIVATE_KEY`.

`DATABASE_URL` and `GROK_AUTH_*` belong to the optional app host. The Hideki monitor ignores them.

## Safety

- No private key, seed, or trading key is read or stored.
- Wallet access is limited to account and chain requests. Sending is disabled.
- Stop protection and operator approval are displayed, not submitted.
- A what-if deposit, withdrawal, or reduction is arithmetic. It is not an executed action.
- The preview OAuth secret used by the Grok sandbox is not in this export. `PREVIEW_CLIENT_SECRET` is an empty string.

## Known limitations

- Not a working liquidation bot. No order has been sent from this project.
- An immediate IOC order is not protocol reduce-only. The unsigned plan uses a stop order instead, and that stop is not armed.
- Estimated health is withheld when marks are stale, maintenance does not reproduce, or base decimals disagree with `oneBase`.
- The estimate ignores slippage and a builder fee.
- Activity history lasts for the browser session. A stop that disappears is not treated as executed.

## Bounty

| | |
|---|---|
| Project | Liquidation Guardian |
| Owner | Scott |
| Bounty | dreamDEX Perps Builder Bounty |
| Network | Somnia Hideki testnet, chain id 50383 |
| Hackathon | [DoraHacks dreamDEX Perps](https://dorahacks.io/hackathon/dreamdex-perps-bounty) |
| SDK | [@somnia-chain/markets-sdk](https://www.npmjs.com/package/@somnia-chain/markets-sdk) |
| Protocol docs | [dreamDEX perps testnet](https://app.testnet.dreamdex.io/docs/developers/perps-testnet) |
| Bot kit | [somnia-chain/dreamdex-bot-kit](https://github.com/somnia-chain/dreamdex-bot-kit) |

Signing needs a separate approval. It is not included.
