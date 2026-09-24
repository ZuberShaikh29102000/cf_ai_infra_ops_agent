// Compatibility shims at the Workers AI binding boundary. Two quirks, both
// worked around here so the rest of the app can use the AI SDK normally.
// (Newer workers-ai-provider 4.x would need `ai@7`, which the starter's
// `agents` / `@cloudflare/ai-chat` packages don't support yet.)
//
// 1) DUPLICATED STREAM FIELDS. For Llama 3.3, every streamed chunk carries each
//    fragment TWICE: in OpenAI format (`choices[0].delta.content` /
//    `.delta.tool_calls`) and again in the legacy format (top-level `response` /
//    `tool_calls`). workers-ai-provider@3.3.1 reads both without deduplicating,
//    so text arrives as "TheThe answer answer" and tool-call arguments are
//    corrupted into invalid JSON. We drop a legacy field ONLY when the
//    OpenAI-format field carrying the same data is present, so nothing that
//    isn't a duplicate is ever removed.
//
// 2) EMPTY `tools` ARRAY. Workers AI rejects `tools: []` ("must not be an empty
//    array"). The AI SDK sends exactly that when we set `activeTools: []` to
//    stop the model calling tools on a follow-up step. We omit the field.

// Only the fields we inspect; everything else in the chunk passes through.
interface StreamChunk {
  response?: unknown;
  tool_calls?: unknown;
  choices?: { delta?: { content?: unknown; tool_calls?: unknown } }[];
}

function stripDuplicates(chunk: StreamChunk): void {
  const delta = chunk.choices?.[0]?.delta;
  if (!delta) return;
  if (typeof delta.content === "string") delete chunk.response;
  if (Array.isArray(delta.tool_calls)) delete chunk.tool_calls;
}

// Rewrites each `data: {...}` line of the SSE stream; passes everything else
// (blank lines, `data: [DONE]`, unparseable lines) through untouched.
function dedupeSSE(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = ""; // a partial line carried over between network chunks

  const rewrite = (line: string): string => {
    if (!line.startsWith("data:")) return line;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return line;
    try {
      const chunk = JSON.parse(payload) as StreamChunk;
      stripDuplicates(chunk);
      return `data: ${JSON.stringify(chunk)}`;
    } catch {
      return line;
    }
  };

  return new TransformStream({
    transform(bytes, controller) {
      pending += decoder.decode(bytes, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        controller.enqueue(encoder.encode(rewrite(line) + "\n"));
      }
    },
    flush(controller) {
      if (pending) controller.enqueue(encoder.encode(rewrite(pending)));
    }
  });
}

type RunFn = (...args: unknown[]) => Promise<unknown>;

// Removes `tools` (and `tool_choice`) from the request when there are no tools.
function omitEmptyTools(inputs: unknown): unknown {
  if (typeof inputs !== "object" || inputs === null) return inputs;
  const req = inputs as Record<string, unknown>;
  if (!Array.isArray(req.tools) || req.tools.length > 0) return inputs;
  const { tools: _tools, tool_choice: _choice, ...rest } = req;
  return rest;
}

export function withWorkersAICompat(ai: Ai): Ai {
  return new Proxy(ai, {
    get(target, prop, receiver) {
      if (prop !== "run") return Reflect.get(target, prop, receiver);
      return async (model: unknown, inputs: unknown, ...rest: unknown[]) => {
        const result = await (target.run as RunFn)(
          model,
          omitEmptyTools(inputs),
          ...rest
        );
        // Non-streaming calls return an object, not a stream: leave them alone.
        return result instanceof ReadableStream
          ? result.pipeThrough(dedupeSSE())
          : result;
      };
    }
  });
}
