import { Ollama, type Message, type Tool } from "ollama";
import { z } from "zod";
import { config } from "./config";

// Single LLM seam: Ollama Cloud. All script / fact-check / research / Q&A calls
// go through here. Structured outputs use Ollama's `format` (a JSON schema we
// derive from the zod schema, then validate the reply). Web search/fetch use
// Ollama's hosted endpoints, exposed to the model as function tools.
export const MODEL = config.ollamaModel;

export const ollama = new Ollama({
  host: config.ollamaHost,
  headers: { Authorization: `Bearer ${config.ollamaApiKey}` },
});

// Applied to every call. `num_ctx` must hold dossier + full script (+ revised
// script for fact-check); `num_predict` (Ollama Cloud's max_tokens, positive)
// must be large enough for a full deep-dive output. The old unset defaults
// truncated large calls, which surfaced as invalid JSON.
export const LLM_OPTIONS = { num_ctx: config.ollamaNumCtx, num_predict: config.ollamaNumPredict };

// Function-tool declarations for the web-search agent loop (research + topic
// fact-check evidence gathering). Execution is server-side via the endpoints
// below; the model only emits tool_calls.
export const WEB_TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web. Returns a list of results, each with title, url, and content.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "The search query" },
          max_results: { type: "number", description: "Max results (1-10, default 8)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch the readable content of a single URL. Returns title, content, and links.",
      parameters: {
        type: "object",
        required: ["url"],
        properties: { url: { type: "string", description: "The URL to fetch" } },
      },
    },
  },
];

export interface WebResult {
  title: string;
  url: string;
  content: string;
}

// Verified REST contract: POST https://ollama.com/api/web_search {query, max_results}.
export async function webSearch(query: string, maxResults = 8): Promise<WebResult[]> {
  const resp = await fetch(`${config.ollamaHost}/api/web_search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.ollamaApiKey}` },
    body: JSON.stringify({ query, max_results: maxResults }),
  });
  if (!resp.ok) throw new Error(`web_search HTTP ${resp.status}`);
  const json = (await resp.json()) as { results?: WebResult[] };
  return json.results ?? [];
}

export async function webFetch(url: string): Promise<{ title: string; content: string; links: string[] }> {
  const resp = await fetch(`${config.ollamaHost}/api/web_fetch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.ollamaApiKey}` },
    body: JSON.stringify({ url }),
  });
  if (!resp.ok) throw new Error(`web_fetch HTTP ${resp.status}`);
  return (await resp.json()) as { title: string; content: string; links: string[] };
}

// Structured chat. gpt-oss on Ollama Cloud ignores schema-constrained `format`
// (VERIFIED 2026-07-25: it returns markdown prose), but honors JSON mode
// (`format: "json"`) plus the JSON schema embedded in the prompt — reasoning
// goes to `message.thinking`, clean JSON to `message.content`. We then
// zod-validate; a mismatch throws → the caller's stage error → worker retry.
// Extract the JSON object/array from the model's content, tolerating an
// occasional prose preface or ``` fence (gpt-oss does this on long prompts even
// in JSON mode). zod still validates the shape afterwards.
function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1]! : trimmed).trim();
  if (body.startsWith("{") || body.startsWith("[")) return body;
  const start = body.search(/[{[]/);
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  return start !== -1 && end > start ? body.slice(start, end + 1) : body;
}

export async function chatJSON<T>(schema: z.ZodType<T>, system: string, userContent: string): Promise<T> {
  const jsonSchema = JSON.stringify(z.toJSONSchema(schema));
  const response = await ollama.chat({
    model: MODEL,
    stream: false,
    format: "json",
    options: LLM_OPTIONS,
    messages: [
      {
        role: "system",
        content:
          `${system}\n\nRespond with ONLY a single JSON object that conforms to this JSON Schema. ` +
          `No markdown, no code fences, no commentary.\nJSON Schema:\n${jsonSchema}`,
      },
      { role: "user", content: userContent },
    ],
  });
  return schema.parse(JSON.parse(extractJson(response.message.content)));
}

// Plain-text chat over an explicit message list (answers → straight to TTS).
export async function chatText(messages: Message[]): Promise<string> {
  const response = await ollama.chat({ model: MODEL, stream: false, options: LLM_OPTIONS, messages });
  return response.message.content.trim();
}
