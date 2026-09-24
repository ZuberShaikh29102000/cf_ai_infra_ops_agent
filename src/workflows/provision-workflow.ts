import {
  AgentWorkflow,
  type AgentWorkflowEvent,
  type AgentWorkflowStep
} from "agents/workflows";
import { createProvider } from "../infra";
import { checkPolicy } from "./policy";
import type { InfraAgent } from "../server";
import type {
  ProvisionParams,
  ProvisionProgress,
  ProvisionResult
} from "./types";

// Each step is its own `step.do`, so Cloudflare checkpoints it and retries it
// on its own: if verifyHealth fails, validatePolicy and provision are NOT
// re-run, their saved results are reused.
const RETRY = {
  retries: { limit: 3, delay: "2 seconds", backoff: "constant" },
  timeout: "30 seconds"
} as const;

// DEMO SWITCH. When true, verifyHealth fails on its first attempt of every
// provisioning run and succeeds on the retry, so the retry is visible in the
// UI. It keys off Cloudflare's own attempt counter (`ctx.attempt`, 1 on the
// first try), so it is deterministic: no randomness, no per-id bookkeeping.
// Set to false for a Workflow that never fails on purpose.
const SIMULATE_FLAKY_HEALTH_CHECK = true;

export class ProvisionWorkflow extends AgentWorkflow<
  InfraAgent,
  ProvisionParams,
  ProvisionProgress
> {
  async run(
    event: AgentWorkflowEvent<ProvisionParams>,
    step: AgentWorkflowStep
  ): Promise<ProvisionResult> {
    const { id, type, env, owner } = event.payload;
    // Stateless (see infra/provider.ts), so a fresh one here is fine.
    const provider = createProvider();

    const verdict = await step.do("validatePolicy", RETRY, async () => {
      await this.reportProgress({
        id,
        step: "validatePolicy",
        status: "running"
      });
      // The agent's SQLite is the only record of what exists, so ask it
      // (RPC). The resource being created is already reserved there, hence
      // the `id` to exclude.
      const existingInEnv = await this.agent.countResourcesInEnv(env, id);
      const result = checkPolicy({ env, owner, existingInEnv });
      await this.reportProgress({
        id,
        step: "validatePolicy",
        status: result.ok ? "complete" : "rejected",
        ...(result.ok ? {} : { message: result.reason })
      });
      return result;
    });

    // A rejection is a normal outcome, not an error: finish cleanly (no
    // retries, nothing provisioned) and report the reason. The agent frees
    // the reserved id and the tool relays the reason to the user in chat.
    if (!verdict.ok) {
      const rejected: ProvisionResult = {
        status: "rejected",
        id,
        reason: verdict.reason
      };
      await step.reportComplete(rejected);
      return rejected;
    }

    await step.do("provision", RETRY, async () => {
      await this.reportProgress({ id, step: "provision", status: "running" });
      const result = await provider.provision({ id, type, env, owner });
      await this.reportProgress({ id, step: "provision", status: "complete" });
      return result;
    });

    await step.do("verifyHealth", RETRY, async (ctx) => {
      const attempt = ctx.attempt;
      await this.reportProgress({
        id,
        step: "verifyHealth",
        status: "running",
        attempt
      });
      if (SIMULATE_FLAKY_HEALTH_CHECK && attempt === 1) {
        const message =
          "Health check timed out (simulated first-attempt failure)";
        // Tell the UI a retry is coming, then fail. Cloudflare re-runs ONLY
        // this step, after RETRY.retries.delay.
        await this.reportProgress({
          id,
          step: "verifyHealth",
          status: "retrying",
          attempt,
          message
        });
        throw new Error(message);
      }
      const health = await provider.checkHealth(id);
      if (!health.healthy) throw new Error(health.detail);
      await this.reportProgress({
        id,
        step: "verifyHealth",
        status: "complete",
        attempt
      });
      return health;
    });

    await step.do("record", RETRY, async () => {
      await this.reportProgress({ id, step: "record", status: "running" });
      // Writes to the agent's own SQLite via RPC. Idempotent: setting the
      // status to "running" twice is harmless, so a retry can't corrupt it.
      await this.agent.markResourceRunning(id);
      await this.reportProgress({ id, step: "record", status: "complete" });
      return { recorded: true };
    });

    const result: ProvisionResult = { status: "running", id };
    // The return value is NOT sent to the agent automatically (only errors
    // are), so completion has to be reported explicitly.
    await step.reportComplete(result);
    return result;
  }
}
