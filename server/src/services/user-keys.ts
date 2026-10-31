import crypto from 'crypto';
import { getDb } from '../db/index.js';

export const USER_KEY_PREFIX = 'sk-flm-';

export interface UserApiKeyRow {
  id: number;
  userId: number;
  name: string;
  keyPrefix: string;
  rpmLimit: number;
  revoked: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ValidatedUserKey {
  userId: number;
  email: string;
  role: 'admin' | 'member';
  rpmLimit: number;
}

function sha256(val: string): string {
  return crypto.createHash('sha256').update(val).digest('hex');
}

/**
 * Mint a new user API key. Returns the plaintext key once (only the SHA-256 hash is persisted for auth).
 */
export function mintUserApiKey(
  userId: number,
  name: string = 'Default Key',
): { id: number; key: string; keyPrefix: string; name: string; createdAt: string } {
  const db = getDb();
  const rawSecret = crypto.randomBytes(24).toString('hex');
  const key = `${USER_KEY_PREFIX}${rawSecret}`;
  const keyHash = sha256(key);
  const keyPrefix = `${key.slice(0, 11)}…${key.slice(-4)}`;

  const result = db.prepare(`
    INSERT INTO user_api_keys (user_id, name, key_hash, key_prefix)
    VALUES (?, ?, ?, ?)
  `).run(userId, name.trim() || 'Default Key', keyHash, keyPrefix);

  const row = db.prepare(`
    SELECT id, name, key_prefix, created_at
    FROM user_api_keys
    WHERE id = ?
  `).get(result.lastInsertRowid) as { id: number; name: string; key_prefix: string; created_at: string };

  return {
    id: row.id,
    key,
    keyPrefix: row.key_prefix,
    name: row.name,
    createdAt: row.created_at,
  };
}

/**
 * List all active/revoked API keys for a given user.
 */
export function listUserApiKeys(userId: number): UserApiKeyRow[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, user_id, name, key_prefix, rpm_limit, revoked, created_at, last_used_at
    FROM user_api_keys
    WHERE user_id = ?
    ORDER BY id DESC
  `).all(userId) as Array<{
    id: number;
    user_id: number;
    name: string;
    key_prefix: string;
    rpm_limit: number;
    revoked: number;
    created_at: string;
    last_used_at: string | null;
  }>;

  return rows.map(r => ({
    id: r.id,
    userId: r.user_id,
    name: r.name,
    keyPrefix: r.key_prefix,
    rpmLimit: r.rpm_limit,
    revoked: Boolean(r.revoked),
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}

/**
 * Revoke an API key belonging to a specific user.
 */
export function revokeUserApiKey(userId: number, keyId: number): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE user_api_keys
    SET revoked = 1
    WHERE id = ? AND user_id = ? AND revoked = 0
  `).run(keyId, userId);
  return result.changes > 0;
}

/**
 * Validate an incoming user API key (used by /v1 inference routing).
 */
export function validateUserApiKey(token: string | undefined): ValidatedUserKey | null {
  if (!token || !token.startsWith(USER_KEY_PREFIX)) return null;

  const db = getDb();
  const keyHash = sha256(token);

  const row = db.prepare(`
    SELECT k.id as key_id, k.user_id, k.rpm_limit, k.revoked, u.email, u.role
    FROM user_api_keys k
    JOIN users u ON u.id = k.user_id
    WHERE k.key_hash = ?
  `).get(keyHash) as {
    key_id: number;
    user_id: number;
    rpm_limit: number;
    revoked: number;
    email: string;
    role: string;
  } | undefined;

  if (!row || row.revoked) return null;

  // Touch last_used_at asynchronously/best effort
  try {
    db.prepare("UPDATE user_api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.key_id);
  } catch {
    // Ignore concurrency/lock errors on read path
  }

  return {
    userId: row.user_id,
    email: row.email,
    role: row.role === 'admin' ? 'admin' : 'member',
    rpmLimit: row.rpm_limit || 60,
  };
}
