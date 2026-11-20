/**
 * `pnpm -F agent guardian-info`: read-only pre-deploy check of the guardian (GAS_MNEMONIC) account.
 * Prints its addresses, QOR balance, PQC registration and whether GUARDIAN_ADDRESS matches. Never prints a secret.
 */
import { loadGasAccount, NETWORK } from "@qday/core";
import { uqorBalance } from "@qday/core/chain";
import { fetchPqcStatus } from "@qorechain/sdk";

const gas = await loadGasAccount();
const [uqor, pqc] = await Promise.all([uqorBalance(gas.cosmos), fetchPqcStatus({ rest: NETWORK.rest, address: gas.cosmos })]);
const set = process.env.GUARDIAN_ADDRESS?.trim();

console.log(`guardian EVM address : ${gas.evm}`);
console.log(`guardian qor address : ${gas.cosmos}`);
console.log(`QOR balance          : ${Number(uqor) / 1e6} QOR`);
console.log(`ML-DSA key registered: ${pqc.registered}${pqc.possessionProven === false ? " (no proof of possession)" : ""}`);
console.log(
  `GUARDIAN_ADDRESS     : ${!set ? "NOT SET -> add the EVM address above to .env" : set.toLowerCase() === gas.evm.toLowerCase() ? "OK" : `MISMATCH (${set})`}`,
);
