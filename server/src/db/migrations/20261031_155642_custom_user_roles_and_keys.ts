// Migration: custom_user_roles_and_keys
// Created: 2026-10-31
//
// Adds role-based access control (role column in users),
// invite_codes table for invite-only registrations,
// and user_api_keys table for dedicated per-user API keys.

import type { Db } from '../types.js';

export function up(db: Db): void {
  // 1. Add role column to users table if it does not already exist
  const columns = db.pragma('table_info(users)') as Array<{ name: string }>;
  const hasRole = columns.some(c => c.name === 'role');
  if (!hasRole) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member';");
  }

  // Ensure the primary/first user has role = 'admin'
  db.exec(`
    UPDATE users 
    SET role = 'admin' 
    WHERE id = (SELECT id FROM users ORDER BY id ASC LIMIT 1);
  `);

  // 2. Create invite_codes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS invite_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at_ms INTEGER,
      note TEXT,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code);
  `);

  // 3. Create user_api_keys table
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Default Key',
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      encrypted_key TEXT,
      rpm_limit INTEGER DEFAULT 60,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_user_api_keys_hash ON user_api_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_user_api_keys_user ON user_api_keys(user_id);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_user_api_keys_user;
    DROP INDEX IF EXISTS idx_user_api_keys_hash;
    DROP TABLE IF EXISTS user_api_keys;

    DROP INDEX IF EXISTS idx_invite_codes_code;
    DROP TABLE IF EXISTS invite_codes;
  `);

  // SQLite 3.35.0+ supports dropping columns
  try {
    db.exec('ALTER TABLE users DROP COLUMN role;');
  } catch {
    // If running on an older SQLite engine where DROP COLUMN is unsupported, ignore
  }
}
