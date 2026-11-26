import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Sticky notes outlive their thread link: deleting a thread keeps the memo, only its binding clears.
  yield* sql`
    CREATE TABLE IF NOT EXISTS memos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo',
      color TEXT NOT NULL DEFAULT 'amber',
      source TEXT NOT NULL DEFAULT 'manual',
      thread_id TEXT,
      thread_title TEXT,
      project_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_memos_status_updated ON memos (status, updated_at)
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_memos_thread_id ON memos (thread_id)`;
});
