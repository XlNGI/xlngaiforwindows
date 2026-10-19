/** Message sequence and immutable task input boundaries; old generations remain legacy branches. */
export const MIGRATION_V51 = `
CREATE TABLE IF NOT EXISTS conversation_message_sequences (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE REFERENCES chat_messages(id) ON DELETE CASCADE
);
INSERT OR IGNORE INTO conversation_message_sequences(message_id)
  SELECT id FROM chat_messages ORDER BY created_at,id;
CREATE TRIGGER IF NOT EXISTS conversation_message_sequence_insert AFTER INSERT ON chat_messages
BEGIN INSERT INTO conversation_message_sequences(message_id) VALUES(NEW.id); END;
CREATE TABLE IF NOT EXISTS generation_branches (
  generation_id TEXT PRIMARY KEY REFERENCES llm_generations(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL UNIQUE,
  input_message_id TEXT NOT NULL REFERENCES chat_messages(id),
  history_cutoff INTEGER NOT NULL CHECK(history_cutoff>=0),
  excluded_generation_ids_json TEXT NOT NULL CHECK(json_valid(excluded_generation_ids_json)),
  execution TEXT NOT NULL CHECK(execution IN ('ordered','parallel','legacy')),
  dependency_generation_id TEXT REFERENCES llm_generations(id),
  dependency_snapshot_json TEXT CHECK(dependency_snapshot_json IS NULL OR json_valid(dependency_snapshot_json)),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS generation_supplements (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES generation_branches(generation_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE REFERENCES chat_messages(id),
  content TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
`;
