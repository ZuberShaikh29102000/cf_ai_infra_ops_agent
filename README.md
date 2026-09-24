# cf_ai_infra_ops_agent

A chat agent that manages (mocked) cloud infrastructure on Cloudflare: Llama 3.3 on Workers AI decides which tool to call, a Cloudflare Workflow provisions resources, and a Durable Object remembers them.

**Live demo:** https://cf-ai-infra-ops-agent.zubermohommed.workers.dev (one shared instance, no login; see [Limitations](#limitations))

## What it does

A developer types requests like "create a redis instance for dev", "what's running in staging?" or "delete redis-dev-01". Llama 3.3 turns each request into a tool call, the app validates the arguments, and provisioning runs as a four-step Cloudflare Workflow whose retries you can watch in the UI. Deletes pause for an explicit confirmation, and everything the agent creates is stored in the Durable Object's SQLite database, so it survives refreshes and reconnects.

> **Everything here is mocked.** No real cloud resources are created, changed or deleted, anywhere. All infrastructure calls go through an `InfrastructureProvider` interface implemented by a `MockProvider`. A real provider (Terraform, a cloud SDK) could replace it without touching the agent, tools or Workflow. See [Mocked infrastructure](#mocked-infrastructure-and-the-pluggable-provider).

## Assignment mapping

| Cloudflare requirement                                                | How it is met                                                                                                                                                                                                                                                                                                                                  | Where                                                                                |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **1. LLM**: Llama 3.3 on Workers AI                                   | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` through the `AI` binding and `workers-ai-provider`, streamed with the AI SDK's `streamText`. It chooses tools and writes the replies.                                                                                                                                                               | [src/server.ts](src/server.ts), [src/workers-ai-compat.ts](src/workers-ai-compat.ts) |
| **2. Workflow / coordination**: Workflows, Workers or Durable Objects | All three. A **Workflow** (`ProvisionWorkflow`) runs `validatePolicy` -> `provision` -> `verifyHealth` -> `record`, each step retried independently. A **Durable Object** (`InfraAgent`) coordinates: it reserves ids, starts the Workflow, waits for it, and is called back by it over RPC. A **Worker** serves the UI and routes WebSockets. | [src/workflows/](src/workflows/), [src/server.ts](src/server.ts)                     |
| **3. User input**: chat or voice                                      | Chat UI over a WebSocket (streaming replies, tool cards, a Confirm/Cancel card for deletes, a live resource and workflow panel).                                                                                                                                                                                                               | [src/app.tsx](src/app.tsx), [src/resources-panel.tsx](src/resources-panel.tsx)       |
| **4. Memory or state**                                                | Resources live in a `resources` table in the agent's **Durable Object SQLite** (read fresh on every call, no in-memory cache). Chat history persists in the same database via the Agents SDK.                                                                                                                                                  | [src/infra/store.ts](src/infra/store.ts)                                             |

## Architecture

```
Browser (React + Kumo UI)
   |  WebSocket  /agents/infra-agent/default
   v
Worker (src/server.ts: routeAgentRequest + static assets)
   |
   v
InfraAgent = Durable Object (AIChatAgent from the Agents SDK)
   |  SQLite: chat messages (SDK) + `resources` table (ResourceStore)
   |
   |-- streamText ---------> Workers AI: Llama 3.3 70B
   |     tools, each validated with Zod:
   |       listResources(env?)
   |       deleteResource(id)                 needsApproval -> Confirm/Cancel in the UI
   |       createResource(type, env, owner?)
   |             |
   |             |  reserve id, runWorkflow(), wait (max 45 s)
   |             v
   |       ProvisionWorkflow (Cloudflare Workflows)
   |         1. validatePolicy   prod needs an owner; max 5 per environment
   |         2. provision        --> InfrastructureProvider
   |         3. verifyHealth     fails on attempt 1 on purpose, retried on its own
   |         4. record           --> this.agent.markResourceRunning()   (RPC)
   |             |
   |<------------+  progress + completion callbacks
   |
   |-- broadcast "provision-progress" / "resources-changed" --> browser panel

InfrastructureProvider (interface)  <--  MockProvider  (the only mock; swappable)
```

**Creating a resource.** The tool checks that the model's arguments were really stated by the user, reserves an id such as `redis-dev-01` in SQLite as `provisioning`, starts the Workflow and waits (up to 45 s). The Workflow's steps report progress to the agent, which broadcasts it to the browser. When the Workflow finishes, the tool returns `running`, `rejected` (with the policy reason) or `failed`, and Llama tells the user what happened.

**Deleting a resource.** `deleteResource` is marked `needsApproval`. The SDK pauses the tool call and streams an approval request; the UI shows "This will delete redis-dev-01. Confirm?" with Delete and Cancel. The tool's `execute()` only runs after Delete. Cancel leaves state untouched.

## Cloudflare primitives, and why each one

| Primitive                                              | Used for                                                                  | Why this and not something else                                                                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workers AI** (Llama 3.3 70B)                         | Intent parsing, tool selection, replies                                   | Runs on the same platform with no API key, and the model is the required one.                                                                                                            |
| **Durable Objects** (via the Agents SDK `AIChatAgent`) | The agent: WebSocket sessions, chat history, resource state, coordination | One addressable, single-threaded instance per agent gives consistent state and id allocation without a lock or an external database.                                                     |
| **DO SQLite storage**                                  | The `resources` table and chat history                                    | Transactional storage colocated with the agent, and it survives eviction and restarts.                                                                                                   |
| **Workflows**                                          | The provisioning pipeline                                                 | Provisioning is a multi-step process where individual steps can fail. Workflows checkpoint each step and retry only the failed one (here, `verifyHealth`) without redoing earlier steps. |
| **Workers + static assets**                            | Serves the React app, routes `/agents/*` to the Durable Object            | One deployable unit (`wrangler deploy`).                                                                                                                                                 |
| **Vite plugin for Workers**                            | Local dev (`npm run dev`) and the production build                        | Comes with the starter; runs the Worker, Durable Object and Workflow locally.                                                                                                            |

## Mocked infrastructure and the pluggable provider

Nothing is provisioned anywhere. `MockProvider` ([src/infra/mock-provider.ts](src/infra/mock-provider.ts)) waits a few hundred milliseconds and returns fake data (`mock://redis/redis-dev-01`).

The seam is one interface ([src/infra/provider.ts](src/infra/provider.ts)):

```ts
interface InfrastructureProvider {
  readonly name: string;
  provision(req: ProvisionRequest): Promise<ProvisionResult>;
  checkHealth(id: string): Promise<HealthResult>;
  deprovision(id: string): Promise<void>;
}
```

To use a real backend, implement this interface and change one line in [src/infra/index.ts](src/infra/index.ts) (`createProvider()`). It is deliberately **stateless**: it is given an id and remembers nothing, because the Workflow runs in a different isolate from the agent and an in-memory list inside a provider would silently diverge from the agent's own records. The agent's SQLite table is the only record of what exists.

## What the starter provided vs. what I built

Started from `cloudflare/agents-starter` (commit `4ea6a72`). It already includes the chat UI, the streaming tool-calling loop, the human-in-the-loop approval mechanism (`needsApproval`, and Approve/Reject buttons), Durable Object message persistence, and scheduling tools. It was already on Workers AI, with a Kimi model.

| Provided by the starter                                                               | Built or changed by me                                                   |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Chat UI, streaming, dark/light theme                                                  | Model swap to Llama 3.3; infra-ops system prompt                         |
| `streamText` tool loop and `needsApproval` mechanism                                  | The three infra tools, Zod schemas, the delete confirmation card wording |
| Durable Object + SQLite chat persistence                                              | `ResourceStore` and the `resources` table                                |
| Scheduling tools (removed: unused, and they confused Llama)                           | `InfrastructureProvider` + `MockProvider`                                |
| MCP client panel (removed)                                                            | `ProvisionWorkflow`, policy rules, deterministic retry demo              |
| Image attachments (still in the UI; Llama 3.3 is text-only so they do nothing useful) | Resource + workflow-activity panel; live progress broadcasts             |
|                                                                                       | Guards for Llama's tool-calling behaviour (next section)                 |

## Working with Llama 3.3: what broke and how it is handled

Most of the engineering effort went into making a model's tool calls safe. These are real failures I observed against the live model, each fixed in code rather than by hoping the prompt would work.

| Observed problem                                                                                                                                                                                                                            | Fix                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every streamed token and every tool-argument fragment arrived **twice**, which also corrupted tool-call JSON. The raw Workers AI stream carries each fragment in both OpenAI and legacy format, and `workers-ai-provider@3.3.1` reads both. | [src/workers-ai-compat.ts](src/workers-ai-compat.ts) removes a legacy field only when its OpenAI-format twin is present. (A newer provider needs `ai@7`, which the starter's packages don't support yet.)                                                                      |
| After a tool result, Llama **called the tool again** (one "create redis" made two resources).                                                                                                                                               | [src/summarize-step.ts](src/summarize-step.ts): the step after a tool round is text-only, with the tool exchange rewritten as a plain note. `toolChoice: "none"` made Llama print its call as JSON, and an empty tools array is rejected by Workers AI, so neither was usable. |
| Llama **silently rewrote invalid input**: "mysql in qa" became postgres/dev. Zod can't catch this, because the values it produced were valid.                                                                                               | A grounding check in [create-resource.ts](src/tools/create-resource.ts): the type, env and owner must appear in the user's last two messages.                                                                                                                                  |
| "create a postgres database" (no environment) **created one in every environment**.                                                                                                                                                         | Same grounding check; the model is told to ask for the missing value.                                                                                                                                                                                                          |
| Llama could **invent an owner** to get past the "prod needs an owner" rule.                                                                                                                                                                 | Owner is grounded in what the user said.                                                                                                                                                                                                                                       |
| The SDK hid all tool errors behind "An error occurred."                                                                                                                                                                                     | `onError` passes the real message through (fine for a demo).                                                                                                                                                                                                                   |

Every tool argument is also validated with Zod before any tool code runs. The AI SDK rejects invalid, missing or malformed arguments (and unknown tool names) as a tool error instead of calling `execute()`, and the model relays it. Deleting an id that doesn't exist returns "not found" with no confirmation prompt.

## Setup (local development)

You need:

- **Node 22.18 or newer** (24.11+ also works). Older Node fails in Vite, Wrangler and Babel 8. Tested on 22.23.
- A **Cloudflare account** with a `workers.dev` subdomain registered (dashboard > Workers & Pages). Workers AI has no local simulator, so `npm run dev` talks to the real service and uses your free-tier allowance.

```bash
npm install
npx wrangler login      # once; opens a browser
npm run dev             # http://localhost:5173
```

Other scripts: `npm run check` (format check, lint, type-check), `npm run types` (regenerate `env.d.ts` after changing `wrangler.jsonc`).

## Deploy

```bash
npm run deploy
```

That runs `vite build && wrangler deploy`. Because the project uses the Vite plugin, the app must be built before Wrangler deploys it, so a bare `npx wrangler deploy` works only after `npx vite build`. The worker is named `cf-ai-infra-ops-agent` (Worker names can't contain underscores); change `name` in `wrangler.jsonc` to rename it.

## How to demo it

Type these in order. Llama is not deterministic, so wording varies; the behaviour should not. The instance is shared and persistent, so start with "what's running?" and delete leftovers if you need a clean slate.

| #   | Type                                                            | What you should see                                                                                                                                                              |
| --- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `hi`                                                            | A short greeting, no tool call.                                                                                                                                                  |
| 2   | `create a redis instance for dev`                               | The **Provisioning workflow** card shows `verifyHealth failed on attempt 1... Retrying...`, then `succeeded on attempt 2` (about 5 s). Result: `redis-dev-01`, status `running`. |
| 3   | `create a redis instance for dev`                               | `redis-dev-02` (ids are readable and sequential).                                                                                                                                |
| 4   | `what's running in dev?`                                        | Both listed.                                                                                                                                                                     |
| 5   | Refresh the page, then `what's running?`                        | Still there: state lives in the Durable Object's SQLite, not the browser.                                                                                                        |
| 6   | `delete redis-dev-01`, click **Cancel**, then `what's running?` | The card reads "This will delete redis-dev-01. Confirm?". After Cancel it still exists.                                                                                          |
| 7   | `delete redis-dev-01`, click **Delete**                         | It is removed; the resource list updates.                                                                                                                                        |
| 8   | `delete redis-dev-99`                                           | "No resource with that id". No confirmation card, since there is nothing to confirm.                                                                                             |
| 9   | `create a mysql instance for qa`                                | Refused, with the valid types and environments listed. Nothing is created.                                                                                                       |
| 10  | `create a postgres database`                                    | Asks for the missing environment. Nothing is created.                                                                                                                            |
| 11  | `create a bucket for prod`                                      | **Rejected by policy**: production resources need an owner (shown in the workflow card).                                                                                         |
| 12  | `create a bucket for prod, owner is team-payments`              | Succeeds; the resource shows `owner: team-payments`.                                                                                                                             |
| 13  | `create a worker for staging`, six times                        | The first five succeed; the sixth is rejected (a maximum of 5 resources per environment).                                                                                        |

## Verification

I tested these scenarios by driving the agent over its WebSocket against both the local dev server and the deployed Worker, checking the streamed tool calls, results and state: create (ids `-01`, `-02`), list and env filter, invalid and missing arguments, delete cancel/confirm/unknown id, the retry timeline, both policy rules, and that a rejected request's reserved id is released. There is **no automated test suite** in this repo, and the React UI (including the resource panel and the delete confirmation card) has no automated tests. The shipped code passes `npm run check` (format, lint, type-check).

## Limitations

- **Infrastructure is mocked** (see above). Health checks always pass, apart from the deliberate first-attempt failure.
- **One shared instance, no auth.** The UI connects to a single Durable Object named `default`, so everyone who opens the site sees the same chat and resources. There is no login or per-user isolation, and anyone with the URL spends the deployer's Workers AI quota.
- **The retry is staged.** `verifyHealth` fails on its first attempt of every run on purpose, so the retry is visible. Set `SIMULATE_FLAKY_HEALTH_CHECK` to `false` in [provision-workflow.ts](src/workflows/provision-workflow.ts) to turn it off. It adds about 2 s to every create.
- **Llama 3.3 is non-deterministic.** The guards above stop the failures I saw, but replies can still be oddly worded or occasionally wrong.
- **One tool round per message.** Multi-step requests such as "delete the redis in staging" make the model list first and ask you for the id.
- **The grounding check is a heuristic.** It is a substring match over the last two user messages, so unusual phrasing ("pg", "stage") can be refused, and a value mentioned earlier in that window can be reused.
- **Ids can be reused.** Deleting the highest-numbered resource frees its number.
- **Image attachments are still in the UI** although Llama 3.3 cannot read images.
- **The compat shim is a workaround** for a provider/model mismatch and should be removed when the provider can be upgraded.

## What I'd build next

- **A real provider** implementing `InfrastructureProvider` (Terraform or a cloud SDK), with the mock kept for tests.
- **Auth and per-user agents**, with an instance name derived from the signed-in user, plus rate limiting.
- **Automated tests**: unit tests for policy and grounding, and a recorded end-to-end scenario suite (the manual scripts I used, made repeatable).
- **Upgrade the AI SDK and provider** to drop the compat shim and the summarizer workaround, or evaluate a model with more reliable tool calling.
- **Drift detection** between the recorded state and the provider's, and richer policies (per-type quotas, cost limits).
- **Streaming Workflow progress into the chat itself** rather than the side panel only.
- **Remove the unused image attachment UI.**

## Project structure

```
src/
  server.ts                 Worker entry + InfraAgent (Durable Object): tools, Workflow start/callbacks
  prompt.ts                 System prompt
  summarize-step.ts         Text-only step after a tool result (Llama loop guard)
  workers-ai-compat.ts      Workers AI stream/tools compatibility shim
  infra/
    types.ts                Zod enums + Resource type
    provider.ts             InfrastructureProvider interface
    mock-provider.ts        MockProvider
    index.ts                createProvider(): the one place the mock is named
    store.ts                ResourceStore: SQLite table in the Durable Object
  tools/                    createResource, listResources, deleteResource (+ deps)
  workflows/
    provision-workflow.ts   validatePolicy -> provision -> verifyHealth -> record
    policy.ts               Pure policy rules
    types.ts                Types shared by the agent and the Workflow
  app.tsx                   Chat UI (from the starter, modified)
  resources-panel.tsx       Resource list + workflow activity feed
  use-provisioning.ts       Hook that receives progress broadcasts
PROMPTS.md                  Prompt history for this project
```

## License

MIT, inherited from the starter template (`LICENSE`).
