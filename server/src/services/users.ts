import { getDb } from '../db/index.js';
import type { UserRole } from './auth.js';
import type { AdminUser as AdminUserRow, Permission } from '@freellmapi/shared/user-access.js';

// Admin-side account management. Deliberately its own service file so upstream's
// services/auth.ts stays the self-scoped authentication path it has always been.

/** Every account with the counts an operator needs to decide what to do with it. */
export function listUsers(actorUserId: number): AdminUserRow[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT u.id, u.email, u.role, u.is_primary, u.permissions, u.created_at,
           (SELECT COUNT(*) FROM user_api_keys k
             WHERE k.user_id = u.id AND k.revoked = 0) AS active_keys,
           (SELECT COUNT(*) FROM sessions s
             WHERE s.user_id = u.id AND s.expires_at_ms > ?) AS sessions
    FROM users u
    ORDER BY u.id ASC
  `).all(Date.now()) as Array<{
    id: number;
    email: string;
    role: string;
    is_primary: number;
    permissions: string | null;
    created_at: string;
    active_keys: number;
    sessions: number;
  }>;

  return rows.map(r => {
    const isPrimary = Boolean(r.is_primary);
    let permissions: Permission[] = [];
    try {
      permissions = isPrimary || r.role === 'admin' ? ['*'] : JSON.parse(r.permissions || '[]');
    } catch {
      permissions = isPrimary || r.role === 'admin' ? ['*'] : [];
    }

    return {
      id: r.id,
      email: r.email,
      role: r.role === 'admin' ? 'admin' as const : 'member' as const,
      isPrimary,
      permissions,
      createdAt: r.created_at,
      activeKeys: r.active_keys,
      sessions: r.sessions,
      isSelf: r.id === actorUserId,
    };
  });
}

/**
 * Promote or demote an account. Role is re-read from the row on every session
 * validation, so a demotion bites on the target's next request without having
 * to touch their sessions.
 *
 * Throws `{ code }`: 'self_role_change' | 'user_not_found' | 'primary_admin_protected'.
 */
export function setUserRole(userId: number, role: UserRole, actorUserId: number): void {
  // Changing your own role is the self-lockout path
  if (userId === actorUserId) {
    const err = new Error('You cannot change your own role') as any;
    err.code = 'self_role_change';
    throw err;
  }

  const db = getDb();
  const target = db.prepare('SELECT id, is_primary FROM users WHERE id = ?').get(userId) as { id: number; is_primary: number } | undefined;
  if (!target) {
    const err = new Error('No such account') as any;
    err.code = 'user_not_found';
    throw err;
  }

  if (target.is_primary) {
    const err = new Error('The primary admin account is protected and cannot be modified') as any;
    err.code = 'primary_admin_protected';
    throw err;
  }

  if (role === 'admin') {
    db.prepare('UPDATE users SET role = ?, permissions = ? WHERE id = ?').run(role, '["*"]', userId);
  } else {
    db.prepare('UPDATE users SET role = ?, permissions = ? WHERE id = ?').run(role, '[]', userId);
  }
}

/**
 * Update granular permissions for a user.
 * Primary admin permissions cannot be altered.
 */
export function setUserPermissions(userId: number, permissions: Permission[]): void {
  const db = getDb();
  const target = db.prepare('SELECT id, is_primary FROM users WHERE id = ?').get(userId) as { id: number; is_primary: number } | undefined;
  if (!target) {
    const err = new Error('No such account') as any;
    err.code = 'user_not_found';
    throw err;
  }

  if (target.is_primary) {
    const err = new Error('The primary admin account is protected and cannot be modified') as any;
    err.code = 'primary_admin_protected';
    throw err;
  }

  db.prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(permissions), userId);
}

/** Ends every dashboard session an account holds, including other devices' tabs. */
export function revokeSessionsForUser(userId: number, actorUserId?: number): number {
  const db = getDb();
  if (actorUserId && actorUserId !== userId) {
    const target = db.prepare('SELECT is_primary FROM users WHERE id = ?').get(userId) as { is_primary: number } | undefined;
    if (target?.is_primary) {
      const err = new Error('Cannot revoke sessions for the primary admin') as any;
      err.code = 'primary_admin_protected';
      throw err;
    }
  }
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}

/** Revokes every still-valid personal key of an account. Plaintext was never stored, so nothing to un-revoke. */
export function revokeApiKeysForUser(userId: number, actorUserId?: number): number {
  const db = getDb();
  if (actorUserId && actorUserId !== userId) {
    const target = db.prepare('SELECT is_primary FROM users WHERE id = ?').get(userId) as { is_primary: number } | undefined;
    if (target?.is_primary) {
      const err = new Error('Cannot revoke keys for the primary admin') as any;
      err.code = 'primary_admin_protected';
      throw err;
    }
  }
  return db.prepare('UPDATE user_api_keys SET revoked = 1 WHERE user_id = ? AND revoked = 0')
    .run(userId).changes;
}

/** Lets a revoke route answer 404 instead of a misleading `{ revoked: 0 }`. */
export function userExists(userId: number): boolean {
  return Boolean(getDb().prepare('SELECT id FROM users WHERE id = ?').get(userId));
}

export function isPrimaryAdmin(userId: number): boolean {
  const row = getDb().prepare('SELECT is_primary FROM users WHERE id = ?').get(userId) as { is_primary: number } | undefined;
  return Boolean(row?.is_primary);
}
