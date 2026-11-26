import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(memos)`;
  if (!columns.some((col) => col.name === "attachments_json")) {
    yield* sql`ALTER TABLE memos ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'`;
  }
});
