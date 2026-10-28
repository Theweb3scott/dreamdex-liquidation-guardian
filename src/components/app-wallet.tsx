import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { EMPTY_WALLET, reduceSharedWallet, type SharedWallet } from "@/lib/guardian/app-wallet";
import { allowWalletMethod } from "@/lib/guardian/review";

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};

type WalletApi = {
  wallet: SharedWallet;
  connect: () => Promise<void>;
  disconnect: () => void;
};

const WalletContext = createContext<WalletApi | null>(null);

export function AppWalletProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<SharedWallet>(EMPTY_WALLET);
  const walletRef = useRef(wallet);
  walletRef.current = wallet;

  useEffect(() => {
    const eth = provider();
    if (!eth?.on) return;
    const onAccounts = (...args: unknown[]) => {
      if (walletRef.current.dismissed) return;
      const accounts = Array.isArray(args[0]) ? args[0].filter((item): item is string => typeof item === "string") : [];
      setWallet((current) => reduceSharedWallet(current, { type: "accounts", accounts, chainId: current.chainId }));
    };
    const onChain = (...args: unknown[]) => {
      if (walletRef.current.dismissed) return;
      const hex = typeof args[0] === "string" ? args[0] : "0x0";
      const parsed = Number.parseInt(hex, 16);
      setWallet((current) => reduceSharedWallet(current, { type: "chain", chainId: Number.isFinite(parsed) ? parsed : null }));
    };
    eth.on("accountsChanged", onAccounts);
    eth.on("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, []);

  useEffect(() => {
    const eth = provider();
    if (!eth) return;
    let cancel = false;
    void (async () => {
      try {
        allowWalletMethod("eth_accounts");
        const accounts = await eth.request({ method: "eth_accounts" });
        if (cancel || walletRef.current.dismissed) return;
        const first = Array.isArray(accounts) ? accounts.find((item): item is string => typeof item === "string") : null;
        if (!first) return;
        const chainId = await readChain(eth);
        if (cancel || walletRef.current.dismissed) return;
        setWallet((current) => reduceSharedWallet(current, { type: "restore", address: first, chainId }));
      } catch (caught) {
        if (cancel || walletRef.current.dismissed) return;
        const message = caught instanceof Error ? caught.message : "The wallet could not be read.";
        setWallet((current) => reduceSharedWallet(current, { type: "error", message }));
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  async function connect() {
    const eth = provider();
    if (!eth) {
      setWallet((current) => reduceSharedWallet({ ...current, dismissed: false }, { type: "error", message: "No browser wallet is available." }));
      return;
    }
    try {
      allowWalletMethod("eth_requestAccounts");
      const accounts = await eth.request({ method: "eth_requestAccounts" });
      const first = Array.isArray(accounts) ? accounts.find((item): item is string => typeof item === "string") : null;
      if (!first) throw new Error("The wallet returned no account.");
      const chainId = await readChain(eth);
      setWallet(reduceSharedWallet(walletRef.current, { type: "connect", address: first, chainId }));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "The wallet refused the connection.";
      setWallet((current) => reduceSharedWallet(current, { type: "error", message }));
    }
  }

  function disconnect() {
    setWallet((current) => reduceSharedWallet(current, { type: "dismiss" }));
  }

  return <WalletContext.Provider value={{ wallet, connect, disconnect }}>{children}</WalletContext.Provider>;
}

export function useAppWallet(): WalletApi {
  const value = useContext(WalletContext);
  if (!value) throw new Error("Wallet state is only available inside the app.");
  return value;
}

async function readChain(eth: Eip1193): Promise<number | null> {
  allowWalletMethod("eth_chainId");
  const hex = await eth.request({ method: "eth_chainId" });
  if (typeof hex !== "string") return null;
  const parsed = Number.parseInt(hex, 16);
  return Number.isFinite(parsed) ? parsed : null;
}

function provider(): Eip1193 | null {
  const eth = (globalThis as { ethereum?: Eip1193 }).ethereum;
  return eth && typeof eth.request === "function" ? eth : null;
}
