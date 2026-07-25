// Test preload: give config.ts a valid environment so importing any server
// module (which parses env once at import) does not crash the suite. Real
// external calls are always stubbed in the tests themselves.
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OLLAMA_API_KEY ??= "test-key";
process.env.FIRECRAWL_API_URL ??= "http://firecrawl-api:3002";
process.env.FIRECRAWL_API_KEY ??= "test-key";
process.env.SPEECH_URL ??= "http://speech:7910";
process.env.SPEECH_PROVIDER ??= "local";
process.env.DATA_DIR ??= join(tmpdir(), "learn-test-data");
