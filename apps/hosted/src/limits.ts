import type { Hex } from "viem";

/** What a new owner gets from `/api/starter`: 2.5 QOR. */
export const STARTER_OWNER_UQOR = 2_500_000n;
/** One signed top-up of 1 QOR, only while the owner holds less than `TOPUP_BELOW_UQOR`. */
export const TOPUP_UQOR = 1_000_000n;
export const TOPUP_BELOW_UQOR = 500_000n;
/** What a new guardian account gets at provisioning: 1 QOR (its register fee, then on-demand windows). */
export const GUARDIAN_FUND_UQOR = 1_000_000n;
/** A signed `arm` refills the guardian back to `GUARDIAN_FUND_UQOR` when it holds less than this (one window is 0.225 QOR). */
export const REFILL_BELOW_UQOR = 500_000n;
/** At most this many arm refills per owner per UTC day. */
export const REFILLS_PER_DAY = 3;
/** All owners together: at most this many arm refills per UTC day (about 27 QOR at most), so sybil owners cannot drain the funder. */
export const REFILLS_GLOBAL_PER_DAY = 30;
/** Below 20 QOR the funder hands out no more starter packs and `/api/status` says onboarding is paused. */
export const FUNDER_FLOOR_UQOR = 20_000_000n;
/** What the funder keeps for its own fees on top of a send it makes past the floor (guardian fund, top-up). */
export const FUNDER_FEE_RESERVE_UQOR = 500_000n;
export const PER_IP_24H = 3;
export const DAILY_CAP = 30;

const DAY_MS = 24 * 3600 * 1000;

export type LimitReason = "owner-used" | "ip-limit" | "daily-cap" | "funder-low";
export type LimitCheck = { ok: true } | { ok: false; reason: LimitReason };

const utcDay = (ms: number) => Math.floor(ms / DAY_MS);

/**
 * Starter-pack caps, in memory: one starter per owner address, `PER_IP_24H` per IP in a rolling 24 h, `DAILY_CAP`
 * per UTC day overall, none below the funder floor. `seed` (owners already in the store, with their `createdAt`)
 * keeps owners used and today's count across a restart; per-IP counts restart empty.
 * `clock` returns milliseconds.
 */
export function createLimits(clock: () => number, seed: { owner: string; at: number }[] = []) {
  const owners = new Set<string>(seed.map((s) => s.owner.toLowerCase()));
  let grants: { ip: string | null; owner: string; at: number }[] = seed.map((s) => ({ ip: null, owner: s.owner.toLowerCase(), at: s.at }));

  const prune = (now: number) => {
    // Keep what either window can still count: the last 24 h and today.
    grants = grants.filter((g) => now - g.at < DAY_MS || utcDay(g.at) === utcDay(now));
  };

  return {
    check(ip: string, owner: Hex, funderUqor: bigint): LimitCheck {
      const now = clock();
      prune(now);
      if (owners.has(owner.toLowerCase())) return { ok: false, reason: "owner-used" };
      if (funderUqor < FUNDER_FLOOR_UQOR) return { ok: false, reason: "funder-low" };
      if (grants.filter((g) => g.ip === ip && now - g.at < DAY_MS).length >= PER_IP_24H) return { ok: false, reason: "ip-limit" };
      if (grants.filter((g) => utcDay(g.at) === utcDay(now)).length >= DAILY_CAP) return { ok: false, reason: "daily-cap" };
      return { ok: true };
    },
    /** Count a starter pack. Call it right after a passing `check`, before any await, so a concurrent request sees it. */
    record(ip: string, owner: Hex): void {
      owners.add(owner.toLowerCase());
      grants.push({ ip, owner: owner.toLowerCase(), at: clock() });
    },
    /** Release a `record` whose starter tx failed, so the owner can retry. */
    undo(ip: string, owner: Hex): void {
      const o = owner.toLowerCase();
      owners.delete(o);
      for (let i = grants.length - 1; i >= 0; i--) {
        if (grants[i]!.ip === ip && grants[i]!.owner === o) {
          grants.splice(i, 1);
          break;
        }
      }
    },
    /** Starter packs handed out this UTC day. */
    todayCount(): number {
      const now = clock();
      return grants.filter((g) => utcDay(g.at) === utcDay(now)).length;
    },
  };
}

export type Limits = ReturnType<typeof createLimits>;
