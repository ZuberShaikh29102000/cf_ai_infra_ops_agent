import { useEffect, useState } from "react";
import { Badge, Surface, Text } from "@cloudflare/kumo";
import {
  ArrowClockwiseIcon,
  CaretDownIcon,
  CheckCircleIcon,
  XCircleIcon
} from "@phosphor-icons/react";
import type { Resource } from "./infra";
import type { ProvisionEvent } from "./use-provisioning";

// One line of the activity feed. "running" events are skipped: they are noise
// next to the finished / retrying / rejected ones.
function describe(e: ProvisionEvent) {
  if (e.status === "retrying") {
    return {
      icon: <ArrowClockwiseIcon size={14} className="text-kumo-warning" />,
      text: `${e.step} failed on attempt ${e.attempt}: ${e.message}. Retrying...`
    };
  }
  if (e.status === "rejected") {
    return {
      icon: <XCircleIcon size={14} className="text-kumo-danger" />,
      text: `Rejected by policy: ${e.message}`
    };
  }
  if (e.status === "complete") {
    const retry =
      e.attempt && e.attempt > 1 ? ` (succeeded on attempt ${e.attempt})` : "";
    return {
      icon: <CheckCircleIcon size={14} className="text-kumo-success" />,
      text: `${e.step} done${retry}`
    };
  }
  return null;
}

export function ResourcesPanel({
  loadResources,
  events,
  version,
  connected
}: {
  loadResources: () => Promise<Resource[]>;
  events: ProvisionEvent[];
  version: number;
  connected: boolean;
}) {
  const [resources, setResources] = useState<Resource[]>([]);
  const [open, setOpen] = useState(true);

  // Re-fetch when we (re)connect and whenever the agent says the table changed.
  // The list always comes from the agent's SQLite, never from local memory,
  // which is what makes it survive a page refresh.
  useEffect(() => {
    if (!connected) return;
    loadResources()
      .then(setResources)
      .catch((err) => console.error("Failed to load resources:", err));
  }, [connected, version, loadResources]);

  const feed = events
    .map((e) => ({ e, line: describe(e) }))
    .filter((x) => x.line !== null)
    .slice(-8);

  return (
    <div className="px-5 pt-3 bg-kumo-base border-b border-kumo-line">
      <div className="max-w-3xl mx-auto">
        <button
          type="button"
          className="flex items-center gap-1.5 pb-2 text-sm font-semibold text-kumo-default"
          onClick={() => setOpen(!open)}
        >
          <CaretDownIcon
            size={12}
            className={open ? "" : "-rotate-90"}
            aria-hidden
          />
          Resources ({resources.length})
        </button>

        {open && (
          <div className="grid gap-3 pb-3 md:grid-cols-2">
            <Surface className="rounded-xl ring ring-kumo-line p-3 max-h-48 overflow-y-auto">
              {resources.length === 0 ? (
                <Text size="xs" variant="secondary">
                  Nothing provisioned yet. Try: "create a redis instance for
                  dev"
                </Text>
              ) : (
                <ul className="space-y-1.5">
                  {resources.map((r) => (
                    <li key={r.id} className="flex items-center gap-2">
                      <span className="font-mono text-xs text-kumo-default">
                        {r.id}
                      </span>
                      <Badge
                        variant={
                          r.status === "failed"
                            ? "destructive"
                            : r.status === "provisioning"
                              ? "primary"
                              : "secondary"
                        }
                      >
                        {r.status}
                      </Badge>
                      {r.owner && (
                        <Text size="xs" variant="secondary">
                          owner: {r.owner}
                        </Text>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Surface>

            <Surface className="rounded-xl ring ring-kumo-line p-3 max-h-48 overflow-y-auto">
              <Text size="xs" variant="secondary" bold>
                Provisioning workflow
              </Text>
              {feed.length === 0 ? (
                <div className="mt-1">
                  <Text size="xs" variant="secondary">
                    Steps appear here as a resource is created.
                  </Text>
                </div>
              ) : (
                <ul className="mt-1 space-y-1">
                  {feed.map(({ e, line }) => (
                    <li
                      key={`${e.at}-${e.step}-${e.status}-${e.attempt ?? 0}`}
                      className="flex items-start gap-1.5"
                    >
                      <span className="mt-0.5">{line!.icon}</span>
                      <span className="text-xs text-kumo-subtle">
                        <span className="font-mono text-kumo-default">
                          {e.id}
                        </span>{" "}
                        {line!.text}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Surface>
          </div>
        )}
      </div>
    </div>
  );
}
