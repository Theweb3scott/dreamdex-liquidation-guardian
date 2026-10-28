import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { confirmAllowed, plainTradeCopy, shownValue, tradeResultCopy } from "./trade-copy.ts";

describe("three-step trade copy", () => {
  it("explains a wrong network, an expired quote, a crossing order, missing prices, and low margin", () => {
    assert.equal(
      plainTradeCopy("Wrong network. The wallet is on chain 1, not 50383. Nothing will be signed.").plain,
      "Your wallet is connected to the wrong network. Switch to Hideki v2 in your wallet.",
    );
    assert.equal(plainTradeCopy("The quote expired. Read it again before signing.").plain, "Your trade preview has expired. Preview again to get updated prices.");
    assert.equal(plainTradeCopy("The quote expired. Read it again before signing.").retry, true);
    assert.match(plainTradeCopy("This post-only sell at 1 would cross the best bid 2. Mark 3. Nothing will be signed.").plain, /cannot be submitted as a post-only order/);
    assert.equal(plainTradeCopy("BTC-PERP has no usable mark. Nothing will be signed.").plain, "We couldn't get a reliable market price. Please try again later.");
    assert.equal(
      plainTradeCopy("The order book could not be read, so a crossing post-only price cannot be ruled out. Nothing will be signed.").plain,
      "We couldn't get a reliable market price. Please try again later.",
    );
    assert.equal(plainTradeCopy("The minimum order is larger than the account can place (collateral).").plain, "Your account does not have enough available trading margin for this order.");
    assert.match(plainTradeCopy("Connect a wallet on chain 50383 before reviewing an order. Nothing will be signed.").plain, /Connect your wallet/);
    assert.equal(shownValue("missing"), "Unavailable");
    assert.equal(shownValue("64000.1"), "64000.1");
  });

  it("keeps confirmation closed unless the preview is fresh and unlocked", () => {
    const ready = { hasQuote: true, fresh: true, blocked: false, recovering: false, phase: "ready" as const, outcome: null };
    assert.equal(confirmAllowed(ready), true);
    assert.equal(confirmAllowed({ ...ready, fresh: false }), false);
    assert.equal(confirmAllowed({ ...ready, blocked: true }), false);
    assert.equal(confirmAllowed({ ...ready, hasQuote: false }), false);
    assert.equal(confirmAllowed({ ...ready, phase: "signing" }), false);
    assert.equal(confirmAllowed({ ...ready, phase: "done", outcome: "submitted" }), false);
    assert.equal(confirmAllowed({ ...ready, phase: "done", outcome: "unknown" }), false);
    assert.equal(confirmAllowed({ ...ready, phase: "done", outcome: "rejected" }), true);
    const resting = tradeResultCopy({ outcome: "submitted", receiptStatus: "success", resting: "resting" });
    assert.equal(resting.transaction, "Confirmed");
    assert.match(resting.order, /Resting/);
    assert.match(resting.order, /not a fill/);
    assert.match(resting.note, /not the same as filled/);
    const unknown = tradeResultCopy({ outcome: "unknown", receiptStatus: "unknown", resting: "unverified" });
    assert.equal(unknown.transaction, "Unknown");
    assert.match(unknown.order, /not a fill/);
    assert.doesNotMatch(unknown.transaction, /filled/i);
  });

  it("keeps the three-step screen on the existing quote and signing path", async () => {
    const [trade, desk, client] = await Promise.all([
      readFile(new URL("../../components/manual-order.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../components/guardian-desk.tsx", import.meta.url), "utf8"),
      readFile(new URL("./manual-order-client.ts", import.meta.url), "utf8"),
    ]);
    assert.match(trade, /Trade BTC on Testnet/);
    assert.match(trade, /Preview Trade/);
    assert.match(trade, /Confirm Testnet Trade/);
    assert.match(trade, /Advanced Details/);
    assert.match(trade, /Buy/);
    assert.match(trade, /Sell/);
    assert.match(trade, /reviewPreconditions\(/);
    assert.match(trade, /await import\("@\/lib\/guardian\/manual-order-client"\)/);
    assert.match(trade, /submitManualPostOnly\(eth, quote, true\)/);
    assert.match(trade, /clearPreview/);
    assert.match(trade, /Back/);
    assert.match(trade, /tradingSessionKey/);
    assert.match(trade, /label="Transaction"/);
    assert.match(trade, /label="Order"/);
    assert.doesNotMatch(trade, /eth_requestAccounts/);
    assert.doesNotMatch(trade, /wallet_switchEthereumChain/);
    assert.doesNotMatch(desk, /<WalletReview/);
    assert.doesNotMatch(desk, /Select Market/);
    assert.match(client, /quoteFresh\(/);
    assert.match(client, /walletIdentityReady\(/);
    assert.match(client, /submissionBlock\(/);
    assert.match(client, /ORDER_TYPE\.POST_ONLY/);
  });
});
