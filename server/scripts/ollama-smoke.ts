// M3 pre-flight: one Ollama Cloud chat with a JSON-schema `format`, to verify
// the believed-current surface (host/auth, structured outputs, response shape)
// before relying on it in the stages. Also probes the web_search endpoint.
// Run: OLLAMA_API_KEY=... [OLLAMA_MODEL=...] bun run scripts/ollama-smoke.ts
import { Ollama } from "ollama";
import { z } from "zod";

const HOST = process.env.OLLAMA_HOST || "https://ollama.com";
const MODEL = process.env.OLLAMA_MODEL || "glm-5.2";
const KEY = process.env.OLLAMA_API_KEY;
if (!KEY) {
  console.error("FAIL: OLLAMA_API_KEY not set");
  process.exit(1);
}

const client = new Ollama({ host: HOST, headers: { Authorization: `Bearer ${KEY}` } });

const Schema = z.object({ city: z.string(), country: z.string() });

const response = await client.chat({
  model: MODEL,
  stream: false,
  format: "json", // JSON mode + schema-in-prompt (gpt-oss ignores schema-constrained format)
  messages: [
    {
      role: "system",
      content:
        "Respond with ONLY one JSON object conforming to this JSON Schema; no markdown, no prose:\n" +
        JSON.stringify(z.toJSONSchema(Schema)),
    },
    { role: "user", content: "What is the capital of France? Give city and country." },
  ],
});
const parsed = Schema.parse(JSON.parse(response.message.content));
console.log("structured output:", JSON.stringify(parsed));

// Probe the hosted web search endpoint used for topic mode.
const search = await fetch(`${HOST}/api/web_search`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ query: "what is ollama", max_results: 2 }),
});
const searchJson = (await search.json()) as { results?: { title: string; url: string }[] };
console.log("web_search results:", (searchJson.results ?? []).length);

console.log("SMOKE OK");
