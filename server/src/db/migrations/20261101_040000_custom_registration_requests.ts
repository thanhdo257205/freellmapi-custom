// Migration: custom_registration_requests
// Created: 2026-11-01
//
// Adds registration_requests table for user access request & admin approval flow.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS registration_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT,
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_registration_requests_email ON registration_requests(email);
    CREATE INDEX IF NOT EXISTS idx_registration_requests_status ON registration_requests(status);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_registration_requests_status;
    DROP INDEX IF EXISTS idx_registration_requests_email;
    DROP TABLE IF EXISTS registration_requests;
  `);
}
