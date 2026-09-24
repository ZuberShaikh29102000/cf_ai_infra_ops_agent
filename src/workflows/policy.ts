import type { Environment } from "../infra";

// The provisioning policy. A pure function on purpose: no I/O, so it is trivial
// to read, test and defend. The Workflow's validatePolicy step gathers the
// facts (how many resources exist) and calls this.

export const MAX_RESOURCES_PER_ENV = 5;

export type PolicyVerdict = { ok: true } | { ok: false; reason: string };

export function checkPolicy(input: {
  env: Environment;
  owner?: string;
  // Resources already in this environment, NOT counting the one being created.
  existingInEnv: number;
}): PolicyVerdict {
  const { env, owner, existingInEnv } = input;

  if (env === "prod" && !owner) {
    return {
      ok: false,
      reason:
        "Production resources must have an owner. Ask who owns it and try again with an owner."
    };
  }

  // "Would exceed 5": an environment already holding 5 cannot take a 6th.
  if (existingInEnv >= MAX_RESOURCES_PER_ENV) {
    return {
      ok: false,
      reason: `The ${env} environment already has ${existingInEnv} resources, the maximum is ${MAX_RESOURCES_PER_ENV}. Delete one before creating another.`
    };
  }

  return { ok: true };
}
