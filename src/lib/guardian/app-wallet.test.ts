import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  EMPTY_WALLET,
  connectionStatus,
  followConnectedAddress,
  monitoredAddressNote,
  networkLabel,
  reduceSharedWallet,
  shortAddress,
  tradingSessionKey,
} from "./app-wallet.ts";

const WALLET = "0xd167376D0431131b4C2EC25e3581c6AF734794F3";
const OTHER = "0x0000000000000000000000000000000000000001";

describe("shared wallet", () => {
  it("connects once, labels Hideki v2, and shortens the address", () => {
    const connected = reduceSharedWallet(EMPTY_WALLET, { type: "connect", address: WALLET, chainId: 50383 });
    assert.equal(connectionStatus(connected.address, connected.chainId), "connected");
    assert.equal(networkLabel(connected.chainId), "Hideki v2");
    assert.equal(shortAddress(WALLET), "0xd167…94F3");
    assert.equal(connected.dismissed, false);
  });

  it("disconnects the app session without claiming the provider permission was revoked", () => {
    const connected = reduceSharedWallet(EMPTY_WALLET, { type: "connect", address: WALLET, chainId: 50383 });
    const dismissed = reduceSharedWallet(connected, { type: "dismiss" });
    assert.equal(dismissed.address, null);
    assert.equal(dismissed.chainId, null);
    assert.equal(dismissed.dismissed, true);
    assert.equal(connectionStatus(dismissed.address, dismissed.chainId), "disconnected");
    const echoed = reduceSharedWallet(dismissed, { type: "accounts", accounts: [WALLET], chainId: 50383 });
    assert.equal(echoed.address, null);
    const restored = reduceSharedWallet(dismissed, { type: "restore", address: WALLET, chainId: 50383 });
    assert.equal(restored.address, null);
  });

  it("invalidates the trading session when the account or network changes", () => {
    const connected = reduceSharedWallet(EMPTY_WALLET, { type: "connect", address: WALLET, chainId: 50383 });
    const switched = reduceSharedWallet(connected, { type: "accounts", accounts: [OTHER], chainId: 50383 });
    assert.notEqual(tradingSessionKey(connected.address, connected.chainId), tradingSessionKey(switched.address, switched.chainId));
    const wrong = reduceSharedWallet(connected, { type: "chain", chainId: 1 });
    assert.equal(connectionStatus(wrong.address, wrong.chainId), "wrong-network");
    assert.equal(networkLabel(wrong.chainId), "Chain 1");
    assert.notEqual(tradingSessionKey(connected.address, connected.chainId), tradingSessionKey(wrong.address, wrong.chainId));
    const same = reduceSharedWallet(connected, { type: "accounts", accounts: [WALLET.toLowerCase()], chainId: 50383 });
    assert.equal(tradingSessionKey(same.address, same.chainId), tradingSessionKey(connected.address, connected.chainId));
  });

  it("lets a public monitor keep a different address", () => {
    const followed = followConnectedAddress("", null, WALLET);
    assert.equal(followed.value, WALLET);
    const typed = followConnectedAddress(OTHER, followed.synced, WALLET);
    assert.equal(typed.value, OTHER);
    const next = followConnectedAddress(WALLET, followed.synced, OTHER);
    assert.equal(next.value, OTHER);
    const kept = followConnectedAddress(OTHER, null, null);
    assert.equal(kept.value, OTHER);
    assert.match(monitoredAddressNote(WALLET, WALLET) ?? "", /connected wallet/);
    assert.match(monitoredAddressNote(OTHER, WALLET) ?? "", /not the connected wallet/);
    assert.match(monitoredAddressNote(OTHER, null) ?? "", /No wallet is connected/);
    assert.equal(monitoredAddressNote("0xabc", WALLET), null);
  });

  it("keeps connection requests in the header and signing checks in the order client", async () => {
    const [header, shield, review, trade, client] = await Promise.all([
      readFile(new URL("../../components/guardian-desk.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../components/guardian-shield.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../components/wallet-review.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../components/manual-order.tsx", import.meta.url), "utf8"),
      readFile(new URL("./manual-order-client.ts", import.meta.url), "utf8"),
    ]);
    assert.match(header, /Connect/);
    assert.doesNotMatch(shield, /eth_requestAccounts/);
    assert.doesNotMatch(review, /eth_requestAccounts/);
    assert.doesNotMatch(trade, /eth_requestAccounts/);
    assert.doesNotMatch(trade, /wallet_switchEthereumChain/);
    assert.match(client, /quoteFresh\(/);
    assert.match(client, /walletIdentityReady\(/);
    assert.match(client, /submissionBlock\(/);
    assert.match(client, /ORDER_TYPE\.POST_ONLY/);
  });
});
