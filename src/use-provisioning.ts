import { useCallback, useState } from "react";
import type { ProvisionProgress } from "./workflows/types";

// A Workflow event as the browser stores it.
export type ProvisionEvent = ProvisionProgress & { at: number };

const MAX_EVENTS = 40;

// Listens to the agent's WebSocket for the two custom messages it broadcasts:
//   "provision-progress"  a Workflow step started, finished, retried or was rejected
//   "resources-changed"   the resources table changed, so re-fetch the list
// `onMessage` is handed to useAgent(); everything that is not one of these two
// (i.e. the normal chat traffic) is ignored here.
export function useProvisioning() {
  const [events, setEvents] = useState<ProvisionEvent[]>([]);
  const [version, setVersion] = useState(0);

  const onMessage = useCallback((message: MessageEvent) => {
    let data: { type?: string } & Partial<ProvisionProgress>;
    try {
      data = JSON.parse(String(message.data));
    } catch {
      return; // not JSON: not ours
    }
    if (data.type === "provision-progress") {
      const event = { ...(data as ProvisionProgress), at: Date.now() };
      setEvents((prev) => [...prev, event].slice(-MAX_EVENTS));
    } else if (data.type === "resources-changed") {
      setVersion((v) => v + 1);
    }
  }, []);

  return { events, version, onMessage };
}
