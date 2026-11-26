import { NETWORK, vaultAbi, type TokenSymbol } from "@qday/core";
import { broadcastTx } from "@qday/core/chain";
import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { diana, publicClient, readWindow } from "./chain";
import { createHosted } from "./hosted";
import { createOwnerTx } from "./ownerTx";
import { createSession } from "./session";

/**
 * The faucet test tokens on diana (`TestToken`, public `mint`), deployed once by `DeployTokens.s.sol`
 * (docs/EVIDENCE.md, Task 3). A stranger's browser has no agent /config to read them from.
 */
export const DIANA_TOKENS: Record<TokenSymbol, Hex> = {
  fUSD: "0x8478737e5ac2c2cbf70aad17f459d1b8ab8a7a14",
  fETH: "0x0a958bba25f5fddca1b1f9cec44bdf076a8ea6c5",
  fBTC: "0xbd16bc9ffaddf241593d891844cc4281f5af903e",
};

/** The in-app wallet of this tab: keys live in memory only, the encrypted seed in IndexedDB. */
export const appSession = createSession();

/** The hosted service, signing with the session's post-quantum key. */
export const hosted = createHosted({ account: () => appSession.account() });

/** Hybrid and windowed EVM txs from the in-app wallet, on diana. */
export const ownerTx = createOwnerTx({
  broadcast: async (acc, msgs, memo) => (await broadcastTx(acc, msgs, memo, { signMode: "hybrid" })).transactionHash,
  ownerStage: async (owner) => (await hosted.owner(owner)).stage,
  arm: async (acc, blocks) => {
    // Signed with the account the window is opened for, whatever the session holds.
    const signer = createHosted({ account: () => acc });
    await hosted.arm(acc.evm, signer.signed("arm", { blocks }));
  },
  windowLive: async (acc) => (await readWindow(acc.evm)).live,
  wallet: (acc) => createWalletClient({ account: privateKeyToAccount(acc.privateKey as Hex), chain: diana, transport: http(NETWORK.evmRpc) }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

/**
 * `owner()`/`guardian()` of a GuardianVault; null when the address holds none (no code, or the call reverts). Any other
 * failure (transport) throws, so "could not read" never reads as "no vault".
 */
export async function readVaultRoles(vault: Hex): Promise<{ owner: Hex; guardian: Hex } | null> {
  try {
    const [owner, guardian] = await Promise.all([
      publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "owner" }),
      publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "guardian" }),
    ]);
    return { owner, guardian };
  } catch (e) {
    if (e instanceof BaseError && e.walk((c) => c instanceof ContractFunctionZeroDataError || c instanceof ContractFunctionRevertedError)) return null;
    throw e;
  }
}
