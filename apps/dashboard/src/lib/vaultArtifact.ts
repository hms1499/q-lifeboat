import type { Abi, Hex } from "viem";
// Named imports only: Vite then tree-shakes the rest of the forge artifact (AST, metadata) out of the bundle.
// The file is build output (`cd contracts && forge build`); it is gitignored.
import { abi, bytecode } from "../../../../contracts/out/GuardianVault.sol/GuardianVault.json";

/**
 * The compiled GuardianVault: abi + creation bytecode, constructor (owner_, guardian_). Same checks as
 * `loadVaultArtifact` in apps/cli/src/fresh.ts.
 */
export function parseVaultArtifact(j: { abi?: unknown; bytecode?: { object?: string } }): { abi: Abi; bytecode: Hex } {
  const list = Array.isArray(j.abi) ? (j.abi as Abi) : [];
  const ctor = list.find((x) => x.type === "constructor") as { inputs?: { type: string }[] } | undefined;
  if (!ctor || ctor.inputs?.map((i) => i.type).join(",") !== "address,address") {
    throw new Error("GuardianVault artifact: expected a constructor(address owner_, address guardian_)");
  }
  const code = j.bytecode?.object;
  if (!code || !/^0x[0-9a-fA-F]+$/.test(code)) throw new Error("GuardianVault artifact: no creation bytecode");
  return { abi: list, bytecode: code as Hex };
}

let cached: { abi: Abi; bytecode: Hex } | undefined;
/** Parsed on first use and memoised, so a bad artifact fails the deploy path only, not the whole dashboard on import. */
export function getVaultArtifact(): { abi: Abi; bytecode: Hex } {
  return (cached ??= parseVaultArtifact({ abi, bytecode }));
}
