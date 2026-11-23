import { NETWORK } from "@qday/core";
import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { errorText } from "../lib/format";
import { connectWallet, discoverWallets, ensureDiana, walletChainId, type DiscoveredWallet } from "../lib/wallet";
import { useApp, type WalletState } from "../state";

export type WalletConnectState = {
  wallet: WalletState;
  /** The wallet's current chain; null until read (or with no wallet). */
  chainId: number | null;
  error: string | null;
  /** Several wallets announced themselves: the owner picks one. */
  choices: DiscoveredWallet[] | null;
  pick: () => Promise<void>;
  connect: (d: DiscoveredWallet) => Promise<void>;
  /** Put the connected wallet on diana (adding the network if needed), then re-read its chain. */
  switchToDiana: () => Promise<void>;
};

/** Connect a browser wallet (EIP-6963) into the shared `wallet` state, and follow its account and chain. */
export function useWalletConnect(): WalletConnectState {
  const { wallet, setWallet } = useApp();
  const [choices, setChoices] = useState<DiscoveredWallet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);

  // Follow the wallet's account and chain.
  useEffect(() => {
    if (!wallet) return;
    const p = wallet.provider;
    const onAccounts = (a: unknown) => {
      const list = a as string[];
      if (!list?.length) setWallet(null);
      else setWallet({ ...wallet, account: list[0] as Hex });
    };
    const onChain = (id: unknown) => setChainId(Number(id));
    void walletChainId(p).then(setChainId, () => setChainId(null));
    p.on?.("accountsChanged", onAccounts as never);
    p.on?.("chainChanged", onChain as never);
    return () => {
      p.removeListener?.("accountsChanged", onAccounts as never);
      p.removeListener?.("chainChanged", onChain as never);
    };
  }, [wallet, setWallet]);

  async function connect(d: DiscoveredWallet) {
    setChoices(null);
    setError(null);
    try {
      const account = await connectWallet(d.provider);
      setWallet({ provider: d.provider, name: d.info.name, account });
      setChainId(await walletChainId(d.provider));
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function pick() {
    setError(null);
    const list = await discoverWallets();
    if (!list.length) return setError("No browser wallet found. Install MetaMask, import the account, then reload.");
    if (list.length === 1) return connect(list[0]);
    setChoices(list);
  }

  async function switchToDiana() {
    if (!wallet) return;
    setError(null);
    try {
      await ensureDiana(wallet.provider);
    } catch (e) {
      setError(errorText(e));
    }
    setChainId(await walletChainId(wallet.provider).catch(() => null));
  }

  return { wallet, chainId: wallet ? chainId : null, error, choices, pick, connect, switchToDiana };
}

/** "Connect MetaMask", then the wallet picker when several wallets announce themselves. */
export function WalletConnect({ w, label = "Connect MetaMask", small = false }: { w: WalletConnectState; label?: string; small?: boolean }) {
  return (
    <>
      <button type="button" className={`btn${small ? " small" : ""}`} onClick={() => void w.pick()}>
        {label}
      </button>
      {w.choices ? (
        <div className="actions" style={{ marginTop: 10 }}>
          {w.choices.map((d) => (
            <button key={d.info.uuid} type="button" className="btn small" onClick={() => void w.connect(d)}>
              {d.info.icon ? <img src={d.info.icon} alt="" width={18} height={18} style={{ marginRight: 8 }} /> : null}
              {d.info.name}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** "Switch to diana" when the connected wallet is on another chain. */
export function SwitchToDiana({ w }: { w: WalletConnectState }) {
  if (!w.wallet || w.chainId === NETWORK.evmChainId) return null;
  return (
    <button type="button" className="btn small" onClick={() => void w.switchToDiana()}>
      Switch to diana
    </button>
  );
}
