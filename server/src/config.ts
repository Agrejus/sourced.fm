// Environment is parsed exactly once, here, at import time. A missing required
// variable throws immediately (naming the variable) so the process dies at boot
// rather than mid-episode. Nothing else in the server may read process.env.

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function port(): number {
  const raw = optional("PORT", "7900");
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`Invalid PORT: ${raw}`);
  }
  return value;
}

function posInt(name: string, fallback: string): number {
  const raw = optional(name, fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}: ${raw} (expected a positive integer)`);
  }
  return value;
}

function speechProvider(): "local" | "elevenlabs" {
  const value = optional("SPEECH_PROVIDER", "local");
  if (value !== "local" && value !== "elevenlabs") {
    throw new Error(`Invalid SPEECH_PROVIDER: ${value} (expected "local" | "elevenlabs")`);
  }
  return value;
}

export const config = Object.freeze({
  port: port(),
  dataDir: optional("DATA_DIR", "/data"),
  ollamaApiKey: required("OLLAMA_API_KEY"),
  ollamaHost: optional("OLLAMA_HOST", "https://ollama.com"),
  ollamaModel: optional("OLLAMA_MODEL", "glm-5.2"),
  // Context window for every model call. Must comfortably hold the dossier +
  // a full deep-dive script + (for fact-check) the revised script. Tunable so
  // it can track the hosted model's real ceiling without a code change.
  ollamaNumCtx: posInt("OLLAMA_NUM_CTX", "65536"),
  // Max output tokens per call (maps to Ollama Cloud's max_tokens — must be a
  // positive int). Big enough for a long deep-dive script and the fact-check
  // stage's full revised script; the low default silently truncated JSON.
  ollamaNumPredict: posInt("OLLAMA_NUM_PREDICT", "32768"),
  firecrawlApiUrl: required("FIRECRAWL_API_URL"),
  firecrawlApiKey: required("FIRECRAWL_API_KEY"),
  speechUrl: required("SPEECH_URL"),
  speechProvider: speechProvider(),
});

export type Config = typeof config;
