import { tool } from "ai";
import { z } from "zod";
import { EnvironmentSchema } from "../infra";
import type { ToolDeps } from "./deps";

export const listResourcesTool = ({ store }: ToolDeps) =>
  tool({
    description:
      "List infrastructure resources managed by this agent, optionally only one environment. Use for 'what's running?' and to look up exact ids.",
    inputSchema: z.object({
      env: EnvironmentSchema.nullish().describe(
        "Only this environment. Omit to list all."
      )
    }),
    execute: async ({ env }) => {
      const resources = store.list(env ?? undefined);
      return { count: resources.length, resources };
    }
  });
