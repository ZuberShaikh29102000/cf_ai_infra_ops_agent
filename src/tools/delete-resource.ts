import { tool } from "ai";
import { z } from "zod";
import type { ToolDeps } from "./deps";

export const deleteResourceTool = ({ store, provider }: ToolDeps) =>
  tool({
    description:
      "Permanently delete one resource by its exact id (for example 'redis-dev-01'). The user is asked to confirm in the UI first. If unsure of the id, call listResources first.",
    inputSchema: z.object({
      id: z
        .string()
        .trim()
        .min(1)
        .describe("Exact resource id, e.g. redis-dev-01")
    }),
    // Human-in-the-loop, the same mechanism the starter uses for `calculate`:
    // the SDK pauses this tool call and streams an "approval-requested" part;
    // the UI renders Delete / Cancel; execute() runs ONLY after the user
    // approves. If they cancel, execute() never runs and state is untouched.
    // An unknown id skips the prompt (nothing to confirm); execute() then
    // reports "not found" instead.
    needsApproval: async ({ id }) => store.get(id) !== undefined,
    execute: async ({ id }) => {
      // Re-check: the resource could have vanished while awaiting approval.
      if (!store.get(id)) {
        return { deleted: false, error: `No resource with id "${id}".` };
      }
      await provider.deprovision(id);
      store.remove(id);
      return { deleted: true, id };
    }
  });
