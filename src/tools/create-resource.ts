import { tool } from "ai";
import { z } from "zod";
import { EnvironmentSchema, ResourceTypeSchema } from "../infra";
import type { ProvisionOutcome } from "../workflows/types";
import type { ToolDeps } from "./deps";

export const createResourceTool = ({
  provisionResource,
  recentUserText
}: ToolDeps) =>
  tool({
    description:
      "Create (provision) ONE infrastructure resource. Call it only when the user has given both a resource type and an environment.",
    // The AI SDK checks the model's arguments against this Zod schema BEFORE
    // execute() runs. A bad call (type "mysql", env "qa", a missing field,
    // malformed JSON) never reaches our code: the SDK turns it into a
    // tool-error that goes back to the model, and the UI shows it.
    // `owner` is .nullish() because Llama often sends null for optional args.
    inputSchema: z.object({
      type: ResourceTypeSchema.describe("Kind of resource"),
      env: EnvironmentSchema.describe("Target environment"),
      owner: z
        .string()
        .nullish()
        .describe("Team or person who owns it. Omit if the user did not say.")
    }),
    execute: async ({ type, env, owner }): Promise<ProvisionOutcome> => {
      // GROUNDING CHECK. Zod only proves the values are *valid*, not that the
      // user *said* them. Llama will happily turn "mysql in qa" into
      // postgres/dev, or answer a missing environment by creating one in every
      // environment. So: the type and env must literally appear in the user's
      // recent messages. Substring match on purpose, so "production" and
      // "Postgres DB" still count. Throwing here becomes a tool-error the
      // model must relay to the user.
      const said = recentUserText.toLowerCase();
      if (!said.includes(type) || !said.includes(env)) {
        throw new Error(
          `Not created: the user did not clearly state both a resource type and an environment (received type="${type}", env="${env}"). Ask the user which type (redis, postgres, worker, bucket) and which environment (dev, staging, prod) they want. Do not guess.`
        );
      }
      // Same idea for `owner`, and it matters more: prod REQUIRES an owner, so
      // a model that invents one ("team-platform") would silently defeat the
      // policy. Compared ignoring case and punctuation ("team-payments" ==
      // "Team Payments").
      const cleanOwner = owner?.trim() || undefined;
      const squash = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (cleanOwner && !squash(recentUserText).includes(squash(cleanOwner))) {
        throw new Error(
          `Not created: the owner "${cleanOwner}" was not stated by the user. Do not invent an owner. Omit it, or ask the user who owns this resource.`
        );
      }
      // Provisioning runs as a Cloudflare Workflow (validatePolicy -> provision
      // -> verifyHealth -> record). This waits for it and returns its outcome:
      // running, rejected by policy, failed, or timed out.
      return provisionResource({ type, env, owner: cleanOwner });
    }
  });
