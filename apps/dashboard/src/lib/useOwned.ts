import { useMemo } from "react";
import { useApp } from "../state";
import { useTriggerSenders } from "./hooks";
import { partitionByOwner } from "./incidents";

/**
 * The agent's incidents split by who sent the trigger tx (read from the chain). `own` is mine + still-checking, in the
 * agent's order: a report whose sender is not known yet stays visible. Never decided from the agent's word.
 */
export function useOwnedIncidents() {
  const { incidents, config } = useApp();
  const senders = useTriggerSenders(incidents);
  const owner = config.cfg?.owner ?? "";
  return useMemo(() => {
    const p = partitionByOwner(incidents, senders, owner);
    const checking = new Set(p.checking.map((i) => i.id));
    const mine = new Set(p.mine.map((i) => i.id));
    const own = incidents.filter((i) => mine.has(i.id) || checking.has(i.id));
    return { ...p, own, isChecking: (i: { id: string }) => checking.has(i.id) };
  }, [incidents, senders, owner]);
}
