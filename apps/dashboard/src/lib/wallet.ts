import { NETWORK } from "@qday/core";
import { createWalletClient, custom, getAddress, toHex, type EIP1193Provider, type Hex } from "viem";
import { diana, EXPLORER } from "./chain";

/** An injected wallet announced through EIP-6963. */
export type WalletInfo = { uuid: string; name: string; icon: string; rdns: string };
export type DiscoveredWallet = { info: WalletInfo; provider: EIP1193Provider };

type AnnounceEvent = CustomEvent<DiscoveredWallet>;

/**
 * EIP-6963 discovery: ask every injected wallet to announce itself. MetaMask (io.metamask) first. Falls back to
 * `window.ethereum` when nothing announces (older wallets).
 */
export function discoverWallets(waitMs = 250): Promise<DiscoveredWallet[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredWallet>();
    const onAnnounce = (e: Event) => {
      const d = (e as AnnounceEvent).detail;
      if (d?.info?.uuid && d.provider) found.set(d.info.uuid, d);
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      const list = [...found.values()].sort((a, b) => Number(b.info.rdns === "io.metamask") - Number(a.info.rdns === "io.metamask"));
      const legacy = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
      if (!list.length && legacy) list.push({ info: { uuid: "legacy", name: "Injected wallet", icon: "", rdns: "window.ethereum" }, provider: legacy });
      resolve(list);
    }, waitMs);
  });
}

const CHAIN_HEX = toHex(NETWORK.evmChainId);

/** Switch the wallet to diana (9800), adding the network first when the wallet does not know it (error 4902). */
export async function ensureDiana(provider: EIP1193Provider): Promise<void> {
  const current = (await provider.request({ method: "eth_chainId" })) as string;
  if (current?.toLowerCase() === CHAIN_HEX) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
  } catch (e) {
    const code = (e as { code?: number; data?: { originalError?: { code?: number } } }).code ?? (e as { data?: { originalError?: { code?: number } } }).data?.originalError?.code;
    if (code !== 4902) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: CHAIN_HEX,
          chainName: diana.name,
          nativeCurrency: diana.nativeCurrency,
          rpcUrls: [NETWORK.evmRpc],
          blockExplorerUrls: [EXPLORER],
        },
      ],
    });
  }
}

/** Ask for the account, then put the wallet on diana. Returns the checksummed account. */
export async function connectWallet(provider: EIP1193Provider): Promise<Hex> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.length) throw new Error("the wallet returned no account");
  await ensureDiana(provider);
  return getAddress(accounts[0]);
}

export async function walletChainId(provider: EIP1193Provider): Promise<number> {
  return Number(await provider.request({ method: "eth_chainId" }));
}

export const walletClientFor = (provider: EIP1193Provider, account: Hex) => createWalletClient({ account, chain: diana, transport: custom(provider) });
