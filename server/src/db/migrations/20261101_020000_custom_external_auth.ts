import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_google_identities (
      subject TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS auth_google_attempts (
      state_hash TEXT PRIMARY KEY,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_google_handoffs (
      ticket_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      payload TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_email_resets (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_fingerprint TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_email_resets_user ON auth_email_resets(user_id);
    CREATE TABLE IF NOT EXISTS auth_request_limits (
      bucket_hash TEXT PRIMARY KEY,
      started_at_ms INTEGER NOT NULL,
      attempts INTEGER NOT NULL
    );
  `);
  for (const table of ['auth_google_attempts', 'auth_google_handoffs', 'auth_email_resets']) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_expiry ON ${table}(expires_at_ms)`);
  }
}
export function down(db: Db): void {
  for (const table of ['auth_request_limits', 'auth_email_resets', 'auth_google_handoffs', 'auth_google_attempts', 'auth_google_identities']) {
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}
