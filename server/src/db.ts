import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import type { SourceInput } from "./fetchers/types";

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

export type Status =
  | "submitted"
  | "sourced"
  | "scripted"
  | "verified"
  | "synthesizing"
  | "ready"
  | "failed";

// Statuses the pipeline worker may claim and advance (non-terminal, non-ready).
export const CLAIMABLE_STATUSES = ["submitted", "sourced", "scripted", "verified"] as const;
export type ClaimableStatus = (typeof CLAIMABLE_STATUSES)[number];

export interface EpisodeRow {
  id: string;
  source_json: string;
  title: string;
  status: Status;
  error_json: string | null;
  dossier_json: string | null;
  script_json: string | null;
  factcheck_json: string | null;
  audio_path: string | null;
  duration_ms: number | null;
  attempts: number;
  next_attempt_at: number;
  created_at: number;
  updated_at: number;
}

export interface ChatRow {
  id: string;
  episode_id: string;
  role: "user" | "assistant";
  text: string;
  position_ms: number | null;
  created_at: number;
}

// Only these columns may be written by a stage transition. Whitelisted so a
// caller can never smuggle raw SQL through the patch object.
const PATCH_COLUMNS = [
  "title",
  "dossier_json",
  "script_json",
  "factcheck_json",
  "audio_path",
  "duration_ms",
] as const;
export type StagePatch = Partial<Record<(typeof PATCH_COLUMNS)[number], string | number | null>>;

export function createDb(path: string): Database {
  const database = new Database(path, { create: true });
  database.run(SCHEMA_SQL);
  return database;
}

// All SQL lives here. Accessors are bound to a specific Database so tests can
// use an isolated in-memory db while boot uses the on-disk file.
export function createAccessors(database: Database) {
  function insertEpisode(input: SourceInput, now: number): EpisodeRow {
    const id = Bun.randomUUIDv7();
    database
      .query(
        `INSERT INTO episodes (id, source_json, status, created_at, updated_at)
         VALUES (?, ?, 'submitted', ?, ?)`,
      )
      .run(id, JSON.stringify(input), now, now);
    return getEpisode(id)!;
  }

  function getEpisode(id: string): EpisodeRow | null {
    return (
      database.query<EpisodeRow, [string]>("SELECT * FROM episodes WHERE id = ?").get(id) ?? null
    );
  }

  function listEpisodes(): EpisodeRow[] {
    return database
      .query<EpisodeRow, []>("SELECT * FROM episodes ORDER BY created_at DESC")
      .all();
  }

  // Oldest claimable episode whose backoff has elapsed. Concurrency is 1 (the
  // single worker loop), so a plain select IS the claim.
  function claimNextPipelineEpisode(now: number): EpisodeRow | null {
    return (
      database
        .query<EpisodeRow, [number]>(
          `SELECT * FROM episodes
           WHERE status IN ('submitted','sourced','scripted','verified')
             AND next_attempt_at <= ?
           ORDER BY created_at ASC
           LIMIT 1`,
        )
        .get(now) ?? null
    );
  }

  // Advance a stage. Asserts the current status equals expectedPrior via a
  // conditional UPDATE; a mismatch (backwards write, double-run, wrong prior)
  // changes zero rows and throws — the guard is never removed.
  function updateEpisodeStage(
    id: string,
    expectedPrior: Status,
    next: Status,
    patch: StagePatch,
    now: number,
  ): void {
    const sets: string[] = ["status = ?", "updated_at = ?"];
    const values: (string | number | null)[] = [next, now];
    for (const col of PATCH_COLUMNS) {
      if (col in patch) {
        sets.push(`${col} = ?`);
        values.push(patch[col] ?? null);
      }
    }
    const result = database
      .query(`UPDATE episodes SET ${sets.join(", ")} WHERE id = ? AND status = ?`)
      .run(...values, id, expectedPrior);
    if (result.changes === 0) {
      const actual = getEpisode(id)?.status ?? "<missing>";
      throw new Error(
        `refusing status write for ${id}: expected prior '${expectedPrior}' to reach '${next}', but current is '${actual}'`,
      );
    }
  }

  function failEpisode(id: string, stage: string, message: string, now: number): void {
    database
      .query("UPDATE episodes SET status = 'failed', error_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify({ stage, message }), now, id);
  }

  // Status-agnostic backoff bump used by the worker's retry path.
  function scheduleRetry(id: string, attempts: number, nextAttemptAt: number, now: number): void {
    database
      .query("UPDATE episodes SET attempts = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?")
      .run(attempts, nextAttemptAt, now, id);
  }

  // Boot recovery: an episode stuck in 'synthesizing' (crash mid-render) goes
  // back to 'verified' to be re-rendered from scratch (GPU time is free).
  function resetStuckSynthesizing(now: number): number {
    return database
      .query(
        `UPDATE episodes SET status = 'verified', attempts = attempts + 1, updated_at = ?
         WHERE status = 'synthesizing'`,
      )
      .run(now).changes as number;
  }

  function insertChat(
    episodeId: string,
    role: "user" | "assistant",
    text: string,
    positionMs: number | null,
    now: number,
  ): ChatRow {
    const id = Bun.randomUUIDv7();
    database
      .query(
        `INSERT INTO chats (id, episode_id, role, text, position_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, episodeId, role, text, positionMs, now);
    return database.query<ChatRow, [string]>("SELECT * FROM chats WHERE id = ?").get(id)!;
  }

  function listChats(episodeId: string): ChatRow[] {
    return database
      .query<ChatRow, [string]>(
        "SELECT * FROM chats WHERE episode_id = ? ORDER BY created_at ASC",
      )
      .all(episodeId);
  }

  return {
    insertEpisode,
    getEpisode,
    listEpisodes,
    claimNextPipelineEpisode,
    updateEpisodeStage,
    failEpisode,
    scheduleRetry,
    resetStuckSynthesizing,
    insertChat,
    listChats,
  };
}

export type Accessors = ReturnType<typeof createAccessors>;

function ensureDataDir(): void {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(join(config.dataDir, "episodes"), { recursive: true });
}

ensureDataDir();

export const db = createDb(join(config.dataDir, "learn.db"));
export const accessors = createAccessors(db);
