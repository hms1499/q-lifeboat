import type { OwnerStage } from "@qday/core";

/**
 * Where this browser is: no wallet (visitor), a wallet whose protection is not on yet (onboarding), a protected owner,
 * or the builder's own local agent (local mode keeps its legacy screens).
 */
export type Stage = "visitor" | "onboarding" | "protected" | "local";

const HOSTED_SCREENS = ["home", "setup", "restore", "dashboard", "activity", "vault", "settings"] as const;
const LOCAL_SCREENS = ["overview", "incidents", "recover", "rules", "protect", "drill"] as const;
export type HostedScreen = (typeof HOSTED_SCREENS)[number];
export type LocalScreen = (typeof LOCAL_SCREENS)[number];
export type RouteId = HostedScreen | LocalScreen;

/** null while the wallet check or the owner's hosted state is still loading. */
export function appStage(i: { hasSeed: boolean | undefined; ownerStage: OwnerStage | "none" | undefined; localAgent: boolean; hostedBuild: boolean }): Stage | null {
  if (i.hasSeed === undefined) return null;
  if (!i.hasSeed) return !i.hostedBuild && i.localAgent ? "local" : "visitor";
  if (i.ownerStage === undefined) return null;
  // A retired owner (7 idle days) keeps its guardian and vault, and its next arm (protection test, withdrawal) revives the
  // Guardian: it belongs in the app, never back in setup.
  return i.ownerStage === "active" || i.ownerStage === "retired" ? "protected" : "onboarding";
}

/** Old hosted links that now land on one of the four app screens. */
const ALIASES: Record<string, HostedScreen> = {
  overview: "dashboard",
  attack: "dashboard",
  start: "dashboard",
  setup: "dashboard",
  incidents: "activity",
  recover: "vault",
  rules: "settings",
};

/** The screen for `#/<screen>` at this stage: each stage only reaches the screens that have content for it. */
export function resolveRoute(screen: string, stage: Stage | null): RouteId | null {
  // Restore needs no wallet: it must resolve before the stage is known (or a lost browser could never reach it).
  if (screen === "restore") return "restore";
  if (stage === null) return null;
  if (screen === "home") return "home";
  switch (stage) {
    case "visitor":
      return screen === "setup" || screen === "start" ? "setup" : "home";
    case "onboarding":
      return "setup";
    case "protected":
      if ((["dashboard", "activity", "vault", "settings"] as string[]).includes(screen)) return screen as HostedScreen;
      return ALIASES[screen] ?? "dashboard";
    case "local":
      return (LOCAL_SCREENS as readonly string[]).includes(screen) ? (screen as LocalScreen) : "overview";
  }
}

export type HostedNavItem = { id: HostedScreen; label: string; href: string };

/** The protected owner's navigation: sidebar on desktop, bottom tabs on phones. */
export function hostedNav(): HostedNavItem[] {
  return [
    { id: "dashboard", label: "Dashboard", href: "#/dashboard" },
    { id: "activity", label: "Activity", href: "#/activity" },
    { id: "vault", label: "Vault", href: "#/vault" },
    { id: "settings", label: "Settings", href: "#/settings" },
  ];
}

type AnyStage = OwnerStage | "none";
/**
 * The owner's hosted stage for routing: the live read, else the last stage this browser saw (service unreachable, or
 * the first read still in flight), else "none" when the service is unreachable so the owner still reaches Setup instead
 * of a blank screen. undefined while a first read with nothing cached is in flight.
 */
export function ownerStageFor(live: AnyStage | undefined, error: string | null, cached: AnyStage | null): AnyStage | undefined {
  if (live !== undefined) return live;
  if (cached) return cached;
  if (error) return "none";
  return undefined;
}

/** Asks the app to read the owner's hosted stage again now (Setup's "Open my dashboard" right after activation). */
export const STAGE_REFRESH_EVENT = "qlifeboat-stage-refresh";
export function requestStageRefresh(): void {
  window.dispatchEvent(new Event(STAGE_REFRESH_EVENT));
}
