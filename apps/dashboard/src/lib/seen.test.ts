import type { Incident } from "@qday/core";
import { describe, expect, it } from "vitest";
import { loadSeenIncident, saveSeenIncident, unseenIncident } from "./seen";

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const inc = (id: string, at: string) => ({ id, detectedAt: at }) as unknown as Incident;

describe("incident seen store", () => {
  it("remembers the last seen incident per owner, case-insensitively", () => {
    const kv = mem();
    expect(loadSeenIncident(kv, "0xABC")).toBeNull();
    saveSeenIncident(kv, "0xABC", "i1");
    expect(loadSeenIncident(kv, "0xabc")).toBe("i1");
    expect(loadSeenIncident(kv, "0xdef")).toBeNull();
    expect(loadSeenIncident(undefined, "0xabc")).toBeNull();
  });

  it("the newest incident is unseen until it is the one marked seen", () => {
    const list = [inc("old", "2026-11-26T01:00:00Z"), inc("new", "2026-11-26T02:00:00Z")];
    expect(unseenIncident(list, null)?.id).toBe("new");
    expect(unseenIncident(list, "old")?.id).toBe("new");
    expect(unseenIncident(list, "new")).toBeNull();
    expect(unseenIncident([], null)).toBeNull();
  });
});
