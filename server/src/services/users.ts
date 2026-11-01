import { getDb } from '../db/index.js';
import type { UserRole } from './auth.js';
import type { AdminUser as AdminUserRow, Permission } from '@freellmapi/shared/user-access.js';

// Admin-side account management. Deliberately its own service file so upstream's
// services/auth.ts stays the self-scoped authentication path it has always been.

interface PermissionRow {
  role: string;
  is_primary: number;
  permissions: string | null;
}

/**
 * The permission set a row holds. `['*']` is full administrative access, and an
 * admin or primary account holds it whether or not the column says so. Corrupt
 * JSON fails closed: an unknown grant is treated as no grant.
 */
function grantedPermissions(row: PermissionRow): Permission[] {
  if (row.is_primary || row.role === 'admin') return ['*'];
  try {
    const parsed: unknown = JSON.parse(row.permissions || '[]');
    return Array.isArray(parsed) ? (parsed as Permission[]) : [];
  } catch {
    return [];
  }
}

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
    const permissions = grantedPermissions({ role: r.role, is_primary: r.is_primary, permissions: r.permissions });

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

  // Actor check: Only full administrators can change user roles
  const actor = db.prepare('SELECT id, role, is_primary FROM users WHERE id = ?').get(actorUserId) as { id: number; role: string; is_primary: number } | undefined;
  if (!actor || (actor.role !== 'admin' && !actor.is_primary)) {
    const err = new Error('Only administrators can change account roles') as any;
    err.code = 'insufficient_privileges';
    throw err;
  }

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
 * Update granular permissions for an account.
 *
 * Two rules keep this from being the way out of the permission model:
 *
 * 1. Nobody edits their own grant. Widening it is self-escalation; narrowing it
 *    is self-lockout. Same reasoning as `setUserRole`.
 * 2. An actor can only ever write a list of permissions it holds itself. A
 *    `manage_users` holder therefore cannot hand out `manage_settings` or
 *    `manage_backups` it does not have, which is how a delegate would otherwise
 *    collect the whole admin surface one victim at a time.
 *
 * Throws `{ code }`: 'self_permission_change' | 'user_not_found' |
 * 'primary_admin_protected' | 'insufficient_privileges'.
 */
export function setUserPermissions(userId: number, permissions: Permission[], actorUserId: number): void {
  if (userId === actorUserId) {
    const err = new Error('You cannot change your own permissions') as any;
    err.code = 'self_permission_change';
    throw err;
  }

  const db = getDb();
  const save = (): void => {
    db.prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(permissions), userId);
  };

  const target = db.prepare('SELECT id, role, is_primary FROM users WHERE id = ?').get(userId) as { id: number; role: string; is_primary: number } | undefined;
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

  const actor = db.prepare('SELECT id, role, is_primary, permissions FROM users WHERE id = ?').get(actorUserId) as PermissionRow | undefined;
  if (!actor) {
    const err = new Error('Only administrators can change account permissions') as any;
    err.code = 'insufficient_privileges';
    throw err;
  }

  const actorHolds = grantedPermissions(actor);
  if (actorHolds.includes('*')) {
    save();
    return;
  }

  // A delegate cannot rewrite an administrator's access, and cannot mint
  // full administrative access for anyone.
  if (target.role === 'admin') {
    const err = new Error('Only administrators can modify administrator permissions') as any;
    err.code = 'insufficient_privileges';
    throw err;
  }
  if (permissions.includes('*')) {
    const err = new Error('Non-administrators cannot grant full administrative access') as any;
    err.code = 'insufficient_privileges';
    throw err;
  }
  const beyond = permissions.filter(p => !actorHolds.includes(p));
  if (beyond.length > 0) {
    const err = new Error(`Cannot grant permissions you do not hold: ${beyond.join(', ')}`) as any;
    err.code = 'insufficient_privileges';
    throw err;
  }

  save();
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
