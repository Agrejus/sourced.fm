import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { createDb } from "../src/db";

test("createDb applies the frozen schema on a fresh database", () => {
  const db = createDb(":memory:");
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  expect(tables).toContain("episodes");
  expect(tables).toContain("chats");
});

test("createDb adds listened_at to a database created before the column existed", () => {
  const path = join(tmpdir(), `learn-migrate-${Bun.randomUUIDv7()}.db`);
  // An "old" database: the frozen DDL minus listened_at.
  const old = new Database(path, { create: true });
  old.run(`CREATE TABLE episodes (
    id TEXT PRIMARY KEY, source_json TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'submitted', error_json TEXT, dossier_json TEXT,
    script_json TEXT, factcheck_json TEXT, audio_path TEXT, duration_ms INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  old.run("INSERT INTO episodes (id, source_json, created_at, updated_at) VALUES ('e1', '{}', 1, 1)");
  old.close();

  // Boot twice — the migration must be idempotent.
  createDb(path).close();
  const db = createDb(path);
  const columns = db
    .query<{ name: string }, []>("PRAGMA table_info(episodes)")
    .all()
    .map((r) => r.name);
  expect(columns).toContain("listened_at");
  // The existing row is preserved and defaults to unlistened.
  const row = db.query<{ listened_at: number | null }, []>("SELECT listened_at FROM episodes WHERE id='e1'").get()!;
  expect(row.listened_at).toBeNull();
  db.close();
  unlinkSync(path);
});
