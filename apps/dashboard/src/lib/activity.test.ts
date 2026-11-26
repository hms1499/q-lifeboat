import type { Incident } from "@qday/core";
import { describe, expect, it } from "vitest";
import { activityFeed } from "./activity";
import type { Activity } from "./ownerReads";

const NOW = Date.parse("2026-11-26T03:00:00Z");
const inc = (id: string, at: string, hash: string) => ({ id, detectedAt: at, trigger: { hash } }) as unknown as Incident;
const out = (hash: string, block: bigint): Activity => ({ kind: "transfer", block, hash: hash as `0x${string}`, logIndex: 0, token: "0xt", to: "0xto", amount: 1n }) as unknown as Activity;

describe("activityFeed", () => {
  it("merges incidents and outgoing transfers newest first, timing a block by the 1.4 s block time", () => {
    const tip = 1000n;
    const feed = activityFeed([inc("a", "2026-11-26T02:59:00Z", "0xaa")], [out("0xbb", 1000n), out("0xcc", 900n)], tip, NOW);
    // 0xbb is at the tip (now), the incident 60 s ago, 0xcc 100 blocks = 140 s ago
    expect(feed.map((f) => (f.kind === "incident" ? f.incident.id : f.item.hash))).toEqual(["0xbb", "a", "0xcc"]);
  });

  it("an outgoing transfer that triggered an incident appears once, as the incident", () => {
    const feed = activityFeed([inc("a", "2026-11-26T02:59:00Z", "0xAA")], [out("0xaa", 990n)], 1000n, NOW);
    expect(feed).toHaveLength(1);
    expect(feed[0]!.kind).toBe("incident");
  });

  it("works with no outgoing reads yet", () => {
    expect(activityFeed([inc("a", "2026-11-26T02:59:00Z", "0xaa")], undefined, undefined, NOW)).toHaveLength(1);
  });
});
