import { HIDEKI_CHAIN_ID } from "./review.ts";

export type SharedWallet = {
  address: string | null;
  chainId: number | null;
  error: string | null;
  /** True after Disconnect. Provider permission is not revoked. Silent restore is skipped until Connect. */
  dismissed: boolean;
};

export const EMPTY_WALLET: SharedWallet = { address: null, chainId: null, error: null, dismissed: false };

export type WalletEvent =
  | { type: "restore" | "connect"; address: string; chainId: number | null }
  | { type: "accounts"; accounts: string[]; chainId: number | null }
  | { type: "chain"; chainId: number | null }
  | { type: "dismiss" }
  | { type: "error"; message: string };

export function reduceSharedWallet(state: SharedWallet, event: WalletEvent): SharedWallet {
  if (event.type === "dismiss") return { address: null, chainId: null, error: null, dismissed: true };
  if (state.dismissed && (event.type === "restore" || event.type === "accounts" || event.type === "chain")) return state;
  if (event.type === "error") return { ...state, error: event.message };
  if (event.type === "accounts") {
    const next = event.accounts.find((item) => typeof item === "string") ?? null;
    if (!next) return { address: null, chainId: null, error: null, dismissed: false };
    if (state.address && state.address.toLowerCase() === next.toLowerCase()) return { ...state, error: null };
    return { address: next, chainId: event.chainId, error: null, dismissed: false };
  }
  if (event.type === "chain") {
    if (state.chainId === event.chainId) return state;
    return { ...state, chainId: event.chainId, error: null };
  }
  return { address: event.address, chainId: event.chainId, error: null, dismissed: false };
}

export function shortAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function networkLabel(chainId: number | null): string {
  if (chainId == null) return "Network not read";
  if (chainId === HIDEKI_CHAIN_ID) return "Hideki v2";
  return `Chain ${chainId}`;
}

export function connectionStatus(address: string | null, chainId: number | null): "disconnected" | "connected" | "wrong-network" {
  if (!address) return "disconnected";
  if (chainId !== HIDEKI_CHAIN_ID) return "wrong-network";
  return "connected";
}

/** Keep a typed public address. Follow the connected wallet only while the field is blank or still showing the previous wallet. */
export function followConnectedAddress(current: string, previousSynced: string | null, connected: string | null): { value: string; synced: string | null } {
  if (!connected) return { value: current, synced: previousSynced };
  const blank = current.trim() === "";
  const following = previousSynced != null && current.trim().toLowerCase() === previousSynced.toLowerCase();
  if (blank || following) return { value: connected, synced: connected };
  return { value: current, synced: previousSynced };
}

export function tradingSessionKey(address: string | null, chainId: number | null): string {
  return `${address?.toLowerCase() ?? ""}:${chainId ?? ""}`;
}

/** Says which public address a monitor is using, including when it is not the connected wallet. */
export function monitoredAddressNote(field: string, connected: string | null): string | null {
  const value = field.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  if (!connected) return `Monitoring ${shortAddress(value)}. No wallet is connected.`;
  if (value.toLowerCase() === connected.toLowerCase()) return `Monitoring the connected wallet ${shortAddress(value)}.`;
  return `Monitoring ${shortAddress(value)}. This is not the connected wallet ${shortAddress(connected)}.`;
}
