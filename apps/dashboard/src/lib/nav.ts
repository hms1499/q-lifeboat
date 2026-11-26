export type NavMode = "visitor" | "hosted" | "local";
export type NavItem = { id: string; label: string; href: string };
export type NavGroup = { label: string; items: NavItem[] };

/**
 * "hosted": the public product (in-app wallet, hosted Guardian). "local": the builder's own agent on this machine,
 * with MetaMask onboarding (Protect) and the fire drill. A browser with an in-app wallet is always hosted.
 * "visitor": no wallet in this browser and no local agent to read, so there is nothing to monitor yet.
 */
export function navMode(i: { hasSeed: boolean | undefined; localAgent: boolean; hostedBuild?: boolean }): NavMode {
  if (i.hasSeed === false && (i.hostedBuild || !i.localAgent)) return "visitor";
  return i.hostedBuild || i.hasSeed || !i.localAgent ? "hosted" : "local";
}

/** The legacy sidebar's groups. Only local mode (the builder's own agent) still renders that shell. */
export function navGroups(): NavGroup[] {
  return [
    {
      label: "Monitor",
      items: [
        { id: "overview", label: "Overview", href: "#/overview" },
        { id: "incidents", label: "Incidents", href: "#/incidents" },
        { id: "recover", label: "Recover", href: "#/recover" },
      ],
    },
    {
      label: "Set up",
      items: [
        { id: "protect", label: "Protect", href: "#/protect" },
        { id: "rules", label: "Rules", href: "#/rules" },
        { id: "drill", label: "Fire drill", href: "#/drill" },
      ],
    },
  ];
}
