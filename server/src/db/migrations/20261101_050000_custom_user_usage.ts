// Migration: custom_user_usage
// Created: 2026-11-01
//
// Tracks monthly request and token usage per user for quota enforcement and analytics.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_monthly_usage (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      month TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, month)
    );

    CREATE INDEX IF NOT EXISTS idx_user_monthly_usage_month ON user_monthly_usage(month);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_user_monthly_usage_month;
    DROP TABLE IF EXISTS user_monthly_usage;
  `);
}
