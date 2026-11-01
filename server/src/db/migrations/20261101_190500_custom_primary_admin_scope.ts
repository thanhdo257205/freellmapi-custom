// Migration: scope the primary-admin flag to administrators
// Created: 2026-11-01
//
// DOWN: reversible (the rows it edits are recorded in settings)
//
// custom_granular_rbac backfilled `is_primary` from the lowest user id with no
// role filter, so the first *account* became the primary admin even when it was
// not one. An install whose first row arrived through invite registration ends
// up with a member holding `permissions = '["*"]'` plus an `is_primary` flag that
// makes the account immune to demotion and to session or key revocation.
// `createUser()` had the same assumption (`isPrimary = isFirst`), so it kept
// producing that state after the migration ran.
//
// A member holding '*' is not an account with a stray flag — it is an
// administrator nobody can remove. This repairs the rows the backfill damaged and
// restores the invariant: exactly one primary, and it is an administrator.

import type { Db } from '../types.js';

const SETTING_KEY = 'migration_primary_admin_scoped_rows';

interface UserRow {
  id: number;
  role: string;
  is_primary: number;
  permissions: string | null;
}

/** The state a row had before this migration touched it. */
interface PriorState {
  id: number;
  is_primary: number;
  permissions: string | null;
}

/**
 * The account that should hold the single primary flag: an administrator already
 * flagged primary, otherwise the first administrator by id. `undefined` when the
 * install has no administrator at all.
 */
function expectedPrimaryId(rows: UserRow[]): number | undefined {
  const admins = rows.filter(r => r.role === 'admin').sort((a, b) => a.id - b.id);
  return admins.find(r => r.is_primary === 1)?.id ?? admins[0]?.id;
}

export function up(db: Db): void {
  const columns = db.pragma('table_info(users)') as Array<{ name: string }>;
  if (!columns.some(c => c.name === 'is_primary')) return;

  const rows = db.prepare('SELECT id, role, is_primary, permissions FROM users').all() as UserRow[];
  const primaryId = expectedPrimaryId(rows);

  const changed: PriorState[] = [];
  const write = db.prepare('UPDATE users SET is_primary = ?, permissions = ? WHERE id = ?');

  for (const row of rows) {
    const isAdmin = row.role === 'admin';
    const next: PriorState = {
      id: row.id,
      // Exactly one primary, and only administrators qualify.
      is_primary: isAdmin && row.id === primaryId ? 1 : 0,
      // A member's '*' can only have come from the un-filtered backfill, so the
      // repair fails closed and takes it away. Everything else — an admin's
      // grant, a member's granular list — is the operator's, not ours to touch.
      permissions: !isAdmin && row.is_primary === 1 ? '[]' : row.permissions,
    };

    if (next.is_primary === row.is_primary && next.permissions === row.permissions) continue;
    changed.push({ id: row.id, is_primary: row.is_primary, permissions: row.permissions });
    write.run(next.is_primary, next.permissions, row.id);
  }

  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(SETTING_KEY, JSON.stringify(changed));
}

export function down(db: Db): void {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_KEY) as { value: string } | undefined;
  if (!row) return;

  const restore = db.prepare('UPDATE users SET is_primary = ?, permissions = ? WHERE id = ?');
  for (const prior of JSON.parse(row.value) as PriorState[]) {
    restore.run(prior.is_primary, prior.permissions, prior.id);
  }
  db.prepare('DELETE FROM settings WHERE key = ?').run(SETTING_KEY);
}
