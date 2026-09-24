# PROMPTS.md

A running log of the prompts used to build this project with Claude Code, most
recent last. Each entry: what I asked, what came back, and what I changed.

## 1. Kick-off: read the starter, then plan P0

**Prompt:** Full project brief for `cf_ai_infra_ops_agent`: a conversational
infrastructure agent on Cloudflare (Llama 3.3 on Workers AI, Durable Object
SQLite state, human-in-the-loop delete, later a provisioning Workflow). All
infrastructure mocked behind an `InfrastructureProvider` interface. Start from
`cloudflare/agents-starter`. P0 = provider + three tools + persistence +
delete approval; P1 = Workflow + policy checks. Constraints: Zod-validate every
tool argument, handle listed failure paths, small commented files. Asked for a
read of the starter and a P0 plan before any code.

**Result:** Read the starter (server.ts, app.tsx, wrangler config, package.json)
and reported what it already provides. Checked the installed `agents` and `ai`
packages for the APIs I intended to rely on (`this.sql`, `needsApproval`,
workflow callbacks, invalid-tool-call handling) instead of assuming them.
Produced a P0 plan. No application code written yet.

**My change:** _(to fill in as I go)_

## 2. Steps 0-2: scaffold, Llama 3.3 swap, provider + mock

**Prompt:** "go ahead" on the P0 plan (scaffold the starter, swap the model,
strip the demo/MCP code, add the `InfrastructureProvider` + `MockProvider`).

**Result:** Starter scaffolded and renamed (`InfraAgent`, worker
`cf-ai-infra-ops-agent`). Model set to `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
MCP panel and weather/calculate/timezone demo code removed; scheduling kept.
Added `src/infra/` (Zod enums, `Resource` type, provider interface, stateless
mock). `tsc` passes and the mock ran under Node 22.

**My change:** _(fill in)_ Where Claude got it wrong, for the record: (a) a
blanket find-and-replace `ChatAgent` -> `InfraAgent` also renamed the SDK's
`AIChatAgent`, caught by `tsc`; (b) a PowerShell `Get-Content`/`Set-Content`
pass silently corrupted non-ASCII characters in `app.tsx`/`env.d.ts`, caught
by looking at the output and fixed by restoring from the starter; (c) an
earlier copy step overwrote `.git` with the starter's and had to be reset.

## 3. Debug: Llama replies doubled ("TheThe provided provided") and tool calls fail

**Prompt:** Pasted the chat output after typing "hi": an unrequested
`getScheduledTasks` call followed by every word doubled.

**Result:** Claude reproduced it outside the browser with a small WebSocket
client and showed the server stream itself was doubled, so it was not a UI bug.
Logging the raw Workers AI stream showed each chunk carries every fragment
twice, in OpenAI format (`choices[0].delta`) and legacy format (top-level
`response` / `tool_calls`); `workers-ai-provider@3.3.1` reads both without
deduplicating. Doubled tool-argument fragments also corrupt the JSON, which is
why tool calls failed. Fix: `src/workers-ai-dedupe.ts`, a wrapper on the AI
binding that drops a legacy field only when the OpenAI-format twin is present.
A newer provider (4.0.0) needs `ai@7`, which the starter doesn't support, so it
was not used.

**My change:** _(fill in)_ Note for the interview: this is a workaround for a
library/model-format mismatch; the right long-term fix is upgrading the provider
once the starter moves to `ai@7`. Also open: with tools attached, Llama still
answers "hi" oddly; to be tested again once the real infra prompt and tools
are in.

## 4. Step 3: store, three tools, delete approval, and making Llama safe

**Prompt:** Build the SQLite store, `createResource` / `listResources` /
`deleteResource` with Zod schemas, the delete approval card and the infra
system prompt (and remove the unused scheduling tools after they made Llama
answer "hi" with scheduling refusals).

**Result:** Store, tools and approval card built. Testing against real Llama
through a WebSocket script (not just typechecking) exposed problems the
prompt could not fix, so they were fixed in code:

1. One "create redis" made two resources: after a tool result Llama calls the
   tool again. Fix: `src/summarize-step.ts`, so the step after a tool round is
   text-only, with the tool exchange rewritten as a plain note.
2. "mysql in qa" was silently rewritten by the model to postgres/dev and looped
   10 times; "create a postgres database" created one in every environment.
   Zod alone can't catch this (the values were valid, just not what the user
   said). Fix: a grounding check in `createResource`: type and env must appear in
   the user's last two messages.
3. Workers AI rejects `tools: []`, and Llama prints its tool call as JSON when
   `toolChoice: "none"`, or returns empty text with no tools declared. Fixes in
   `src/workers-ai-compat.ts` and `summarize-step.ts` (see comments there).
4. Errors were masked as "An error occurred." Fixed with `onError`.
   Verified: create x2 gives redis-dev-01/-02; list + env filter; invalid type/env
   and missing env refused with a helpful message; delete cancel leaves state
   untouched, confirm removes it; unknown id reports not found.

**My change:** _(fill in)_ Where Claude got it wrong: it first tried
`activeTools: []` and `toolChoice: "none"` as the loop guard; both failed
against the real model and were only caught by running it. Still to verify by
hand in the browser: the assistant text after clicking Delete/Cancel, and
persistence across a dev-server restart.

## 5. Deploy P0

**Prompt:** "deploy"

**Result:** `npx vite build` then `npx wrangler deploy` to
`https://cf-ai-infra-ops-agent.zubermohommed.workers.dev` (Durable Object
`InfraAgent` + `AI` binding). Re-ran the create / refuse / cancel / confirm
scenarios against the live URL over its WebSocket; behaviour matched local.

**My change:** _(fill in)_

## 6. P1: provisioning Workflow, retry, policy, live panel

**Prompt:** "P1" (after a plan: read the SDK's Workflow types first, then build
in five verifiable steps; decisions confirmed: the tool waits for the Workflow,
add a small resource panel, ground `owner` like type/env).

**Result:** `ProvisionWorkflow` (validatePolicy, provision, verifyHealth, record;
each its own `step.do` with retries). `createResource` reserves an id, starts it
via `runWorkflow`, waits for the result. `verifyHealth` fails on `ctx.attempt === 1`
so the retry is deterministic. Policy in a pure function (`policy.ts`): prod needs
an owner, an env holding 5 cannot take a 6th; rejection is a normal Workflow result,
so it reaches the chat as a clear message. Owner is grounded in what the user said,
so the model can't invent one to pass the prod rule. Panel shows the resource list
and a Workflow activity feed. Verified locally and on the deployed URL over
WebSocket: retry timeline (attempt 1 fails, attempt 2 succeeds, earlier steps not
re-run), prod without owner rejected, six staging creates -> sixth rejected and
its reserved id released.

**My change:** _(fill in)_ Things Claude got wrong or had to check: it assumed the
Workflow's return value reaches the agent; reading the SDK source showed only
errors are auto-reported, so completion needs an explicit `step.reportComplete`.
Not verified by Claude: how the panel actually looks in a browser.

## 7. README

**Prompt:** "yes" (write the README after a status check showed the repo still had
the starter's README, no commits, and unfinished PROMPTS.md).

**Result:** README.md with the assignment-mapping table, architecture diagram,
primitives and why, the mocked/pluggable-provider statement, starter-vs-built,
the Llama 3.3 failure/fix table, setup, deploy, a 13-step demo script,
limitations and next steps. Facts were checked against the repo first; one finding
went straight into the limitations: the UI connects to a single shared `default`
Durable Object, so all visitors share one chat and one resource list.

**My change:** _(fill in)_ Claude first wrote that the UI panel and delete flow had
been "checked by hand". That was false (only WebSocket-level checks had been done);
the sentence was corrected. Re-read every claim in the README before submitting.

---

## Reflection

_(to write at the end: where AI sped things up, where it didn't)_
