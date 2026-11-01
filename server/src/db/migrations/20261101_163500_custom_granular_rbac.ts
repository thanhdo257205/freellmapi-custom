// Migration: custom_granular_rbac
// Created: 2026-11-01
//
// Adds is_primary column to identify the protected primary admin account,
// and permissions column to support granular access control (manage_keys, manage_users, etc).

import type { Db } from '../types.js';

export function up(db: Db): void {
  const columns = db.pragma('table_info(users)') as Array<{ name: string }>;
  const hasIsPrimary = columns.some(c => c.name === 'is_primary');
  if (!hasIsPrimary) {
    db.exec("ALTER TABLE users ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0;");
  }

  const hasPermissions = columns.some(c => c.name === 'permissions');
  if (!hasPermissions) {
    db.exec("ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '[]';");
  }

  // Ensure the first user is marked as primary admin with all permissions
  db.exec(`
    UPDATE users 
    SET is_primary = 1, permissions = '["*"]'
    WHERE id = (SELECT id FROM users ORDER BY id ASC LIMIT 1);
  `);

  // Existing admins receive wildcard permissions by default
  db.exec(`
    UPDATE users 
    SET permissions = '["*"]'
    WHERE role = 'admin' AND (permissions IS NULL OR permissions = '[]');
  `);
}

export function down(db: Db): void {
  try {
    db.exec('ALTER TABLE users DROP COLUMN permissions;');
    db.exec('ALTER TABLE users DROP COLUMN is_primary;');
  } catch {
    // If older SQLite does not support DROP COLUMN, ignore
  }
}

