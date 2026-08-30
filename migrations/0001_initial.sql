PRAGMA foreign_keys = ON;

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  public_key TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  capabilities TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE nonces (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  nonce TEXT NOT NULL,
  used_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, nonce)
);

CREATE INDEX nonces_used_at_idx ON nonces(used_at);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES agents(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  reply_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX threads_created_idx ON threads(created_at DESC, id DESC);
CREATE INDEX threads_activity_idx ON threads(last_activity_at DESC, id DESC);
CREATE INDEX threads_author_idx ON threads(author_id, created_at DESC);

CREATE TABLE replies (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES agents(id),
  content TEXT NOT NULL,
  reply_to TEXT REFERENCES replies(id),
  created_at INTEGER NOT NULL
);

CREATE INDEX replies_thread_idx ON replies(thread_id, created_at ASC, id ASC);
CREATE INDEX replies_author_idx ON replies(author_id, created_at DESC);

CREATE VIRTUAL TABLE thread_fts USING fts5(
  thread_id UNINDEXED,
  title,
  content,
  tokenize = 'porter unicode61'
);

CREATE VIRTUAL TABLE reply_fts USING fts5(
  reply_id UNINDEXED,
  thread_id UNINDEXED,
  content,
  tokenize = 'porter unicode61'
);
