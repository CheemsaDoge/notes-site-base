-- Cross-device study progress & notebook sync schema (Cloudflare D1)
-- Raw passphrases are NEVER stored: space_id = SHA-256("<syncHashPrefix>" + normalizedCode).

CREATE TABLE IF NOT EXISTS sync_spaces (
  space_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1,
  progress_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notebook_notes (
  space_id TEXT NOT NULL,
  id TEXT NOT NULL,
  page_slug TEXT NOT NULL,
  page_title TEXT NOT NULL DEFAULT '',
  heading_id TEXT NOT NULL DEFAULT '',
  heading_text TEXT NOT NULL DEFAULT '',
  quote_text TEXT NOT NULL DEFAULT '',
  quote_html TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  tag TEXT NOT NULL DEFAULT '摘录',
  concept_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (space_id, id),
  FOREIGN KEY (space_id) REFERENCES sync_spaces(space_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notebook_notes_space_updated
  ON notebook_notes (space_id, updated_at DESC);
