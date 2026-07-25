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
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  firecrawlApiUrl: required("FIRECRAWL_API_URL"),
  firecrawlApiKey: required("FIRECRAWL_API_KEY"),
  speechUrl: required("SPEECH_URL"),
  speechProvider: speechProvider(),
});

export type Config = typeof config;
