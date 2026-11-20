import { chain } from "@qday/core/chain";
import { createPublicClient, http } from "viem";

/**
 * An EVM RPC client for the agent's latency-critical reads. Calls made in the same tick go out as ONE JSON-RPC
 * batch (one HTTP request, one round trip, served by one node): on diana, 7 parallel unbatched calls took
 * ~650-870 ms (new TLS connections) and the same 7 as one batch ~320 ms. `cacheTime: 0` because viem caches
 * `eth_blockNumber` for 4 s on a chain with no `blockTime`, which hid new blocks from the watcher.
 * Each call creates its own batch queue, so separate clients never wait on each other's requests.
 */
export function createBatchClient(fetchFn?: typeof fetch) {
  return createPublicClient({ chain, cacheTime: 0, transport: http(undefined, { batch: true, ...(fetchFn ? { fetchFn } : {}) }) });
}
