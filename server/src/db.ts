import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";

// Frozen DDL (Appendix A). Migrations are CREATE TABLE IF NOT EXISTS — on boot
// we open the file and ensure the schema; there is no separate migration step.
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS episodes (
  id              TEXT PRIMARY KEY,
  source_json     TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'submitted'
                  CHECK (status IN ('submitted','sourced','scripted','verified','synthesizing','ready','failed')),
  error_json      TEXT,
  dossier_json    TEXT,
  script_json     TEXT,
  factcheck_json  TEXT,
  audio_path      TEXT,
  duration_ms     INTEGER,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodes_pipeline ON episodes(status, next_attempt_at);
CREATE TABLE IF NOT EXISTS chats (
  id          TEXT PRIMARY KEY,
  episode_id  TEXT NOT NULL REFERENCES episodes(id),
  role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text        TEXT NOT NULL,
  position_ms INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chats_episode ON chats(episode_id, created_at);
`;

// Open a database at `path`, put it in WAL mode, and apply the schema.
// Callers pass ":memory:" in tests; boot passes the on-disk file.
export function createDb(path: string): Database {
  const database = new Database(path, { create: true });
  database.run(SCHEMA_SQL);
  return database;
}

function ensureDataDir(): void {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(join(config.dataDir, "episodes"), { recursive: true });
}

ensureDataDir();

export const db = createDb(join(config.dataDir, "learn.db"));
