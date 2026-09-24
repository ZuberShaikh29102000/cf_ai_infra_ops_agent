import type { ModelMessage } from "ai";

// WHY THIS EXISTS. Llama 3.3 handles the step right after a tool result badly:
// with tools on offer it calls the tool AGAIN (duplicate resources), with
// tool_choice "none" it prints its tool call as JSON text, and with no tools
// declared it returns an empty reply. So for that step we don't show it the
// tool exchange at all. The finished round
//     user -> assistant(tool call) -> tool(result)
// is rewritten as
//     user -> user(note containing the result)
// and no tools are offered (see the prepareStep in server.ts). The model then
// only has to write a sentence, which it does reliably.
//
// Returns undefined when the latest message is not a tool result, i.e. when
// this is a normal step that should be left alone.

const NOTE_PREFIX =
  "(Automatic note, not written by the user.) The action you requested has finished.";
const NOTE_SUFFIX =
  "Reply to the user in one or two short sentences saying what happened. If it failed or was cancelled, say so plainly and, if relevant, list the valid options (types: redis, postgres, worker, bucket; environments: dev, staging, prod). Do not output JSON and do not call tools.";

export function summarizeToolRound(
  messages: ModelMessage[]
): ModelMessage[] | undefined {
  if (messages.at(-1)?.role !== "tool") return undefined;

  // Everything after the last real user message is the tool round.
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  const round = messages.slice(lastUser + 1);

  const results = round.flatMap((m) =>
    m.role === "tool"
      ? m.content.flatMap((part) =>
          part.type === "tool-result"
            ? [{ tool: part.toolName, output: part.output }]
            : []
        )
      : []
  );

  return [
    ...messages.slice(0, lastUser + 1),
    {
      role: "user",
      content: `${NOTE_PREFIX} Result: ${JSON.stringify(results)}\n${NOTE_SUFFIX}`
    }
  ];
}
