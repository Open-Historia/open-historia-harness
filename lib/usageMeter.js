// Reading what a provider call actually cost, off the wire.
//
// The game has its own telemetry.js that records tokens per generation, but it
// is only wired into main.jsx on the AI-architecture branches — a pre-revamp
// target records nothing. Measuring here instead means BOTH sides of a branch
// comparison are measured by the same instrument, which is the only way the
// numbers can be put beside each other.
//
// It reads a CLONE and never blocks the response on its way back to the engine:
// the game streams (`:streamGenerateContent?alt=sse`), and awaiting the body
// here would serialise generation behind measurement and corrupt every latency
// figure the run reports.

const asCount = (value) => {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.round(count) : null;
};

/**
 * Usage out of one provider payload, in the shape usageStats.js normalizes to.
 * Gemini repeats a cumulative `usageMetadata` on later SSE chunks, so the LAST
 * block wins rather than the sum — adding them would multiply the prompt by the
 * chunk count.
 */
export const usageFromPayload = (data) => {
  if (!data || typeof data !== "object") return null;
  const gemini = data.usageMetadata;
  if (gemini && typeof gemini === "object") {
    const answer = asCount(gemini.candidatesTokenCount) ?? 0;
    const thoughts = asCount(gemini.thoughtsTokenCount) ?? 0;
    return {
      promptTokens: asCount(gemini.promptTokenCount),
      outputTokens: answer + thoughts > 0 ? answer + thoughts : null,
      thinkingTokens: thoughts > 0 ? thoughts : null,
      cachedTokens: asCount(gemini.cachedContentTokenCount),
      totalTokens: asCount(gemini.totalTokenCount),
    };
  }
  const usage = data.usage;
  if (!usage || typeof usage !== "object") return null;
  if (usage.input_tokens !== undefined || usage.output_tokens !== undefined) {
    const input = asCount(usage.input_tokens) ?? 0;
    const cacheRead = asCount(usage.cache_read_input_tokens) ?? 0;
    const cacheWrite = asCount(usage.cache_creation_input_tokens) ?? 0;
    const output = asCount(usage.output_tokens);
    return {
      promptTokens: input + cacheRead + cacheWrite,
      outputTokens: output,
      thinkingTokens: null,
      cachedTokens: cacheRead || null,
      totalTokens: input + cacheRead + cacheWrite + (output ?? 0),
    };
  }
  return {
    promptTokens: asCount(usage.prompt_tokens),
    outputTokens: asCount(usage.completion_tokens),
    thinkingTokens: null,
    cachedTokens: asCount(usage.prompt_tokens_details?.cached_tokens),
    totalTokens: asCount(usage.total_tokens),
  };
};

/**
 * Pull every JSON payload out of a body that may be SSE or may be one object.
 * A proxy that ignores `alt=sse` answers plain JSON, and main.jsx already
 * tolerates that, so this has to as well.
 */
export const payloadsFrom = (text) => {
  const body = String(text ?? "");
  if (!body.trim()) return [];
  if (!/^\s*(data:|event:)/m.test(body)) {
    try {
      const parsed = JSON.parse(body);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  }
  const payloads = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const chunk = line.slice(5).trim();
    if (!chunk || chunk === "[DONE]") continue;
    try {
      payloads.push(JSON.parse(chunk));
    } catch {
      // A chunk split across a read boundary; the next complete one still counts.
    }
  }
  return payloads;
};

// Structured mode answers with a functionCall, not prose, so its args ARE the
// answer. Counting only `text` reported a 0-character reply for every tool-mode
// call, which read as the model saying nothing.
const textOf = (payload) => {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    return parts
      .map((part) => {
        if (part?.functionCall) {
          try {
            return JSON.stringify(part.functionCall.args ?? {});
          } catch {
            return "";
          }
        }
        return String(part?.text ?? "");
      })
      .join("");
  }
  const choice = payload?.choices?.[0];
  const toolCalls = choice?.delta?.tool_calls ?? choice?.message?.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length) {
    return toolCalls.map((call) => String(call?.function?.arguments ?? "")).join("");
  }
  return String(choice?.delta?.content ?? choice?.message?.content ?? "");
};

const functionCallsIn = (payload) => {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) return parts.filter((part) => part?.functionCall).length;
  const choice = payload?.choices?.[0];
  const toolCalls = choice?.delta?.tool_calls ?? choice?.message?.tool_calls;
  return Array.isArray(toolCalls) ? toolCalls.length : 0;
};

/** The names the model called back with — a lookup round names its lookups. */
const calledNamesIn = (payload) => {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    return parts.filter((part) => part?.functionCall).map((part) => String(part.functionCall.name ?? ""));
  }
  const choice = payload?.choices?.[0];
  const toolCalls = choice?.delta?.tool_calls ?? choice?.message?.tool_calls;
  return Array.isArray(toolCalls) ? toolCalls.map((call) => String(call?.function?.name ?? "")).filter(Boolean) : [];
};

/**
 * What the request DECLARED it wanted back, and how big its instructions were.
 *
 * The harness attributes a call to the verb it wrapped, which is the right unit
 * for a player action but hides what the engine did inside one: a jump that
 * spends five requests spends them on five different jobs. The output function
 * the request declares — `submit_timeline_jump`, `submit_turn_review`,
 * `submit_projects_ops` — names the job exactly, in the game's own vocabulary,
 * and it is present on both branches without either of them being instrumented.
 */
export const describeRequest = (body) => {
  const out = { tools: [], systemChars: 0, historyTurns: 0, lookupTools: 0, model: "" };
  let parsed = null;
  try {
    parsed = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;

  const system = parsed.systemInstruction ?? parsed.system_instruction;
  const systemText = Array.isArray(system?.parts)
    ? system.parts.map((part) => String(part?.text ?? "")).join("")
    : String(system?.text ?? (typeof system === "string" ? system : ""));
  out.systemChars = systemText.length;
  out.historyTurns = Array.isArray(parsed.contents) ? parsed.contents.length : 0;

  // The model, when the body names it: an OpenAI-shaped request carries it
  // there rather than in the URL, so a gateway run would otherwise report none.
  if (parsed.model) out.model = String(parsed.model);

  const declarations = [];
  for (const tool of Array.isArray(parsed.tools) ? parsed.tools : []) {
    // Gemini: tools[].functionDeclarations[]. OpenAI-shaped (NVIDIA, OpenRouter,
    // Groq, Ollama, LM Studio): tools[] = { type: "function", function: {name} }.
    for (const declaration of tool?.functionDeclarations ?? tool?.function_declarations ?? []) {
      declarations.push(String(declaration?.name ?? ""));
    }
    if (tool?.function?.name) declarations.push(String(tool.function.name));
  }
  // An OpenAI-shaped body has no systemInstruction; its system turn is the first
  // message, and its history is the rest.
  if (!out.systemChars && Array.isArray(parsed.messages)) {
    const system = parsed.messages.find((message) => message?.role === "system");
    out.systemChars = String(system?.content ?? "").length;
    out.historyTurns = parsed.messages.length;
  }
  // A submit_* declaration is the answer the task wants; everything else beside
  // it is a lookup function the model MAY call on the way.
  out.tools = declarations.filter((name) => name.startsWith("submit_"));
  out.lookupTools = declarations.length - out.tools.length;
  return out;
};

/** Byte length of whatever a fetch init carried as its body. */
export const requestBytes = (body) => {
  if (!body) return 0;
  if (typeof body === "string") return Buffer.byteLength(body);
  if (body instanceof Uint8Array) return body.byteLength;
  try {
    return Buffer.byteLength(JSON.stringify(body));
  } catch {
    return 0;
  }
};

/** The model a Gemini URL names, for a run where a Save can change it mid-flight. */
export const modelFromUrl = (url) => {
  const match = /\/models\/([^:/?]+)[:?]/.exec(String(url ?? ""));
  return match ? decodeURIComponent(match[1]) : null;
};

/**
 * Measure a response without delaying it.
 *
 * Returns immediately; `emit` is called once the body has finished arriving,
 * with tokens, time to first byte, wall time and the sizes either side.
 */
export const meterResponse = ({ response, init, url, task, model, startedAt, emit }) => {
  let clone;
  try {
    clone = response.clone();
  } catch {
    return; // Body already claimed; measuring is never worth breaking a turn for.
  }

  const described = describeRequest(init?.body);
  const record = {
    task: task ?? null,
    // The engine's own name for this job, from the output function it declared.
    job: described.tools.join("+") || null,
    lookupToolsOffered: described.lookupTools,
    systemChars: described.systemChars,
    historyTurns: described.historyTurns,
    model: model || described.model || modelFromUrl(url),
    status: response.status,
    requestBytes: requestBytes(init?.body),
    responseBytes: 0,
    ttfbMs: null,
    wireMs: null,
    chunks: 0,
    functionCalls: 0,
    called: [],
    answerChars: 0,
    finishReason: null,
    promptTokens: null,
    outputTokens: null,
    thinkingTokens: null,
    cachedTokens: null,
    totalTokens: null,
  };

  (async () => {
    const decoder = new TextDecoder();
    let text = "";
    try {
      const body = clone.body;
      if (body?.getReader) {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (record.ttfbMs === null) record.ttfbMs = Date.now() - startedAt;
          record.chunks += 1;
          record.responseBytes += value?.byteLength ?? 0;
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } else {
        text = await clone.text();
        record.responseBytes = Buffer.byteLength(text);
        record.ttfbMs = Date.now() - startedAt;
      }
    } catch (error) {
      record.error = error.message;
    }
    record.wireMs = Date.now() - startedAt;

    let answer = "";
    for (const payload of payloadsFrom(text)) {
      const usage = usageFromPayload(payload);
      if (usage) {
        for (const [key, value] of Object.entries(usage)) {
          if (value !== null && value !== undefined) record[key] = value;
        }
      }
      answer += textOf(payload);
      record.functionCalls += functionCallsIn(payload);
      for (const name of calledNamesIn(payload)) {
        if (!record.called.includes(name)) record.called.push(name);
      }
      const finish = payload?.candidates?.[0]?.finishReason ?? payload?.choices?.[0]?.finish_reason;
      if (finish) record.finishReason = String(finish);
    }
    record.answerChars = answer.length;
    emit?.(record);
  })();
};
