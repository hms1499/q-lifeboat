import { chain } from "@qday/core/chain";
import { createPublicClient, http } from "viem";

/**
 * An EVM RPC client for the agent's latency-critical reads. Calls made in the same tick go out as ONE JSON-RPC
 * batch (one HTTP request, one round trip, served by one node): on diana, 7 parallel unbatched calls took
 * ~650-870 ms (new TLS connections) and the same 7 as one batch ~320 ms. `cacheTime: 0` because viem caches
 * `eth_blockNumber` for 4 s on a chain with no `blockTime`, which hid new blocks from the watcher.
 * Each call creates its own batch queue, so separate clients never wait on each other's requests.
 */
export function createBatchClient(fetchFn?: typeof fetch, retryCount?: number) {
  return createPublicClient({
    chain,
    cacheTime: 0,
    transport: http(undefined, { batch: true, ...(fetchFn ? { fetchFn } : {}), ...(retryCount === undefined ? {} : { retryCount }) }),
  });
}

/**
 * The watcher's log-loop client: batching, and NO retries. The watcher moves its cursor to the tip only because
 * one node answered both the tip and the `getLogs(from, latest)` in the same request. viem retries a failed item
 * on its own, in a new request that may reach another node whose `latest` is lower, and the cursor would then
 * skip the blocks between. The loop itself retries the whole tick `pollMs` later.
 */
export function createWatchClient(fetchFn?: typeof fetch) {
  return createBatchClient(fetchFn, 0);
}
