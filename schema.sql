-- ToolMaster — D1 (SQLite) schema
-- Apply in the Cloudflare dashboard: Storage & databases → D1 → toolmaster-db → Console.
-- Note: src/worker.js also runs these CREATE TABLE IF NOT EXISTS statements
-- automatically on its first request, so applying this file is optional —
-- it is kept as the canonical schema reference and for manual setup.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'user',
  suspended INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credits (
  user_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0,
  total_earned INTEGER NOT NULL DEFAULT 0,
  total_used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS credit_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  description TEXT NOT NULL,
  reference_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- code stores the SHA-256 hex of the 6-digit code (same as server.js codeHash).
CREATE TABLE IF NOT EXISTS auth_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tool_costs (
  tool TEXT PRIMARY KEY,
  cost INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Default tool costs and the signup bonus (granted exactly once per account).
INSERT OR IGNORE INTO tool_costs (tool, cost) VALUES ('seo-title', 2);
INSERT OR IGNORE INTO tool_costs (tool, cost) VALUES ('hashtag', 2);
INSERT OR IGNORE INTO tool_costs (tool, cost) VALUES ('caption', 2);
INSERT OR IGNORE INTO tool_costs (tool, cost) VALUES ('youtube-description', 3);
INSERT OR IGNORE INTO tool_costs (tool, cost) VALUES ('content-idea', 3);
INSERT OR IGNORE INTO tool_costs (tool, cost) VALUES ('ai-bio', 2);
INSERT OR IGNORE INTO tool_costs (tool, cost) VALUES ('meta-description', 2);
INSERT OR IGNORE INTO settings (key, value) VALUES ('signupBonus', '100');
