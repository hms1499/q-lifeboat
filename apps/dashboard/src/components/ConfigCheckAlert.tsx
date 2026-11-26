import { useApp } from "../state";

/** The alert when the agent's config does not match the vault's immutable owner and guardian on chain. */
export function ConfigCheckAlert() {
  const { cfg, check } = useApp().config;
  if (!cfg || !check || check.ok) return null;
  return (
    <div className="banner bad" role="alert">
      <strong>Config does not match the vault on chain.</strong> {check.detail}. Every report is marked ✗ until the agent serves the vault's own
      owner and guardian.
    </div>
  );
}
