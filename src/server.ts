import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText
} from "ai";
import {
  createProvider,
  type Environment,
  type Resource,
  type ResourceType
} from "./infra";
import { ResourceStore } from "./infra/store";
import { SYSTEM_PROMPT } from "./prompt";
import { summarizeToolRound } from "./summarize-step";
import { createResourceTool } from "./tools/create-resource";
import { deleteResourceTool } from "./tools/delete-resource";
import { listResourcesTool } from "./tools/list-resources";
import { withWorkersAICompat } from "./workers-ai-compat";
import type {
  ProvisionOutcome,
  ProvisionParams,
  ProvisionProgress,
  ProvisionResult
} from "./workflows/types";

// Cloudflare finds Workflow classes as exports of the Worker's main module.
export { ProvisionWorkflow } from "./workflows/provision-workflow";

// How long createResource waits for the Workflow before it stops waiting (the
// Workflow itself keeps running). Long enough to cover a retry.
const PROVISION_TIMEOUT_MS = 45_000;

// Llama 3.3 70B on Workers AI (the starter shipped with a Kimi model).
// The "-fp8-fast" variant is the Llama 3.3 build that supports function calling.
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export class InfraAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;

  // The second argument runs after every write to the resources table. The
  // browser reacts by re-fetching the list (see getResources below).
  private store = new ResourceStore(this, () =>
    this.broadcast(JSON.stringify({ type: "resources-changed" }))
  );
  private provider = createProvider();

  // createResource calls that are waiting for their Workflow, keyed by resource
  // id. In memory is fine: a waiter only exists while the tool call that made
  // it is still running on this same Durable Object instance.
  private waiters = new Map<string, (outcome: ProvisionOutcome) => void>();
  // Workflow instance id -> resource id, so an error callback (which only
  // knows the workflow id) can find its waiter.
  private workflowResource = new Map<string, string>();

  onStart() {
    // Runs on every wake-up; CREATE TABLE IF NOT EXISTS makes it safe.
    this.store.init();
  }

  // ---- For the browser panel ------------------------------------------------

  // @callable exposes this to the browser: `agent.stub.getResources()`.
  @callable()
  getResources(): Resource[] {
    return this.store.list();
  }

  // ---- Provisioning (called by the createResource tool) ---------------------

  // Reserves an id, starts the ProvisionWorkflow and waits for it to finish.
  // The row is inserted as "provisioning" BEFORE the Workflow starts so that
  // two quick requests can't be handed the same id, and so the resource shows
  // up in listings immediately.
  async provisionResource(input: {
    type: ResourceType;
    env: Environment;
    owner?: string;
  }): Promise<ProvisionOutcome> {
    const { type, env, owner } = input;
    const id = this.store.nextId(type, env);
    this.store.insert({
      id,
      type,
      env,
      status: "provisioning",
      ...(owner ? { owner } : {}),
      createdAt: new Date().toISOString()
    });

    const finished = new Promise<ProvisionOutcome>((resolve) =>
      this.waiters.set(id, resolve)
    );
    const params: ProvisionParams = { id, type, env, owner };
    try {
      const workflowId = await this.runWorkflow("PROVISION_WORKFLOW", params);
      this.workflowResource.set(workflowId, id);
    } catch (error) {
      this.waiters.delete(id);
      this.store.remove(id);
      return {
        status: "failed",
        error: `Could not start provisioning: ${error}`
      };
    }

    const timedOut = new Promise<ProvisionOutcome>((resolve) =>
      setTimeout(
        () =>
          resolve({
            status: "timeout",
            message: `${id} is still provisioning. Ask again shortly to check its status.`
          }),
        PROVISION_TIMEOUT_MS
      )
    );
    const outcome = await Promise.race([finished, timedOut]);
    this.waiters.delete(id);
    return outcome;
  }

  // ---- Called BY the ProvisionWorkflow over RPC -------------------------------
  // Public on purpose: `this.agent.<method>()` inside the Workflow is a Durable
  // Object RPC call to exactly these methods.

  countResourcesInEnv(env: Environment, excludeId: string): number {
    return this.store.countInEnv(env, excludeId);
  }

  markResourceRunning(id: string): void {
    this.store.setStatus(id, "running");
  }

  // ---- Workflow callbacks (from the Agents SDK) -----------------------------

  async onWorkflowProgress(
    _workflowName: string,
    _workflowId: string,
    progress: unknown
  ) {
    const p = progress as ProvisionProgress;
    this.broadcast(JSON.stringify({ type: "provision-progress", ...p }));
  }

  async onWorkflowComplete(
    _workflowName: string,
    _workflowId: string,
    result?: unknown
  ) {
    const r = result as ProvisionResult | undefined;
    if (!r) return;
    if (r.status === "running") {
      const resource = this.store.get(r.id);
      if (resource) this.waiters.get(r.id)?.({ status: "running", resource });
    } else {
      // Rejected by policy: give the reserved id back.
      this.store.remove(r.id);
      this.waiters.get(r.id)?.({ status: "rejected", reason: r.reason });
    }
  }

  // Runs when a step has used up all its retries (or the Workflow crashed).
  async onWorkflowError(
    _workflowName: string,
    workflowId: string,
    error: string
  ) {
    const id = this.workflowResource.get(workflowId);
    if (!id) return;
    this.store.setStatus(id, "failed");
    this.waiters.get(id)?.({ status: "failed", error });
  }

  // The text of the user's last two messages (two, so that answering "which
  // environment?" with just "staging" still counts as grounded).
  private recentUserText(): string {
    return this.messages
      .filter((m) => m.role === "user")
      .slice(-2)
      .flatMap((m) => m.parts)
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(" ");
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({
      binding: withWorkersAICompat(this.env.AI)
    });
    const deps = {
      store: this.store,
      provider: this.provider,
      provisionResource: (input: {
        type: ResourceType;
        env: Environment;
        owner?: string;
      }) => this.provisionResource(input),
      recentUserText: this.recentUserText()
    };

    const result = streamText({
      model: workersai(MODEL, {
        sessionAffinity: this.sessionAffinity
      }),
      system: SYSTEM_PROMPT,
      // Prune old tool calls and reasoning to save tokens on long conversations
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        createResource: createResourceTool(deps),
        listResources: listResourcesTool(deps),
        deleteResource: deleteResourceTool(deps)
      },
      // LOOP GUARD. After a tool result, Llama calls the tool again, prints its
      // call as JSON, or replies with nothing (details in summarize-step.ts).
      // So the step after a tool round is text-only: the tool exchange is
      // rewritten as a plain note and no tools are offered (`activeTools: []`
      // sends an empty tools array, which Workers AI rejects; the compat shim
      // strips it). One tool round per user message, by design.
      prepareStep: ({ messages }) => {
        const summarized = summarizeToolRound(messages);
        return summarized
          ? { messages: summarized, activeTools: [] }
          : undefined;
      },
      stopWhen: stepCountIs(3),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse({
      // By default the SDK replaces every error with "An error occurred.",
      // which hides why a tool call was refused. Pass the real message through
      // so the user (and the model) can see it. Fine for a demo; a production
      // app would map errors to safe, user-facing text instead.
      onError: (error) => {
        console.error("[chat error]", error);
        return error instanceof Error ? error.message : String(error);
      }
    });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
