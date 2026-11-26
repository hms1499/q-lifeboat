export type NavMode = "hosted" | "local";
export type NavItem = { id: string; label: string; href: string };
export type NavGroup = { label: string; items: NavItem[] };

/**
 * "hosted": the public product (in-app wallet, hosted Guardian). "local": the builder's own agent on this machine,
 * with MetaMask onboarding (Protect) and the fire drill. A browser with an in-app wallet is always hosted.
 */
export function navMode(i: { hasSeed: boolean | undefined; localAgent: boolean; hostedBuild?: boolean }): NavMode {
  return i.hostedBuild || i.hasSeed || !i.localAgent ? "hosted" : "local";
}

export function navGroups(mode: NavMode): NavGroup[] {
  if (mode === "hosted") {
    return [
      { label: "Start", items: [{ id: "start", label: "Get protected", href: "#/start" }] },
      {
        label: "Monitor",
        items: [
          { id: "overview", label: "Overview", href: "#/overview" },
          { id: "incidents", label: "Incidents", href: "#/incidents" },
          { id: "recover", label: "Recover", href: "#/recover" },
          { id: "attack", label: "Try an attack", href: "#/attack" },
        ],
      },
      { label: "Set up", items: [{ id: "rules", label: "Rules", href: "#/rules" }] },
    ];
  }
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
