import { test, expect } from "bun:test";
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
