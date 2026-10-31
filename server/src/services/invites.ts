import crypto from 'crypto';
import { getDb } from '../db/index.js';

export interface InviteCodeRow {
  id: number;
  code: string;
  createdBy: number;
  creatorEmail: string;
  maxUses: number;
  usedCount: number;
  expiresAtMs: number | null;
  note: string | null;
  revoked: boolean;
  status: 'active' | 'exhausted' | 'expired' | 'revoked';
  createdAt: string;
}

export interface CreateInviteOptions {
  code?: string;
  maxUses?: number;
  expiresInDays?: number | null;
  note?: string;
}

export interface ValidateInviteResult {
  valid: boolean;
  reason?: 'not_found' | 'revoked' | 'expired' | 'exhausted';
  inviteId?: number;
  maxUses?: number;
  usedCount?: number;
}

function generateRandomInviteCode(): string {
  const segment1 = crypto.randomBytes(3).toString('hex').toUpperCase();
  const segment2 = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `FLM-${segment1}-${segment2}`;
}

export function createInviteCode(
  adminUserId: number,
  options: CreateInviteOptions = {},
): InviteCodeRow {
  const db = getDb();
  const code = (options.code?.trim() || generateRandomInviteCode()).toUpperCase();
  const maxUses = options.maxUses && options.maxUses > 0 ? Math.floor(options.maxUses) : 1;
  const expiresAtMs = options.expiresInDays && options.expiresInDays > 0
    ? Date.now() + options.expiresInDays * 24 * 60 * 60 * 1000
    : null;
  const note = options.note?.trim() || null;

  const existing = db.prepare('SELECT id FROM invite_codes WHERE code = ?').get(code);
  if (existing) {
    const err = new Error(`Invite code '${code}' already exists`) as any;
    err.code = 'invite_code_exists';
    throw err;
  }

  const result = db.prepare(`
    INSERT INTO invite_codes (code, created_by, max_uses, expires_at_ms, note)
    VALUES (?, ?, ?, ?, ?)
  `).run(code, adminUserId, maxUses, expiresAtMs, note);

  const row = db.prepare(`
    SELECT i.*, u.email as creator_email
    FROM invite_codes i
    JOIN users u ON u.id = i.created_by
    WHERE i.id = ?
  `).get(result.lastInsertRowid) as any;

  return {
    id: row.id,
    code: row.code,
    createdBy: row.created_by,
    creatorEmail: row.creator_email,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    expiresAtMs: row.expires_at_ms,
    note: row.note,
    revoked: Boolean(row.revoked),
    status: 'active',
    createdAt: row.created_at,
  };
}

export function listInviteCodes(): InviteCodeRow[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT i.id, i.code, i.created_by, u.email as creator_email,
           i.max_uses, i.used_count, i.expires_at_ms, i.note,
           i.revoked, i.created_at
    FROM invite_codes i
    JOIN users u ON u.id = i.created_by
    ORDER BY i.id DESC
  `).all() as Array<{
    id: number;
    code: string;
    created_by: number;
    creator_email: string;
    max_uses: number;
    used_count: number;
    expires_at_ms: number | null;
    note: string | null;
    revoked: number;
    created_at: string;
  }>;

  const now = Date.now();
  return rows.map(r => {
    let status: 'active' | 'exhausted' | 'expired' | 'revoked' = 'active';
    if (r.revoked) {
      status = 'revoked';
    } else if (r.expires_at_ms && r.expires_at_ms < now) {
      status = 'expired';
    } else if (r.used_count >= r.max_uses) {
      status = 'exhausted';
    }

    return {
      id: r.id,
      code: r.code,
      createdBy: r.created_by,
      creatorEmail: r.creator_email,
      maxUses: r.max_uses,
      usedCount: r.used_count,
      expiresAtMs: r.expires_at_ms,
      note: r.note,
      revoked: Boolean(r.revoked),
      status,
      createdAt: r.created_at,
    };
  });
}

export function revokeInviteCode(id: number): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE invite_codes
    SET revoked = 1
    WHERE id = ? AND revoked = 0
  `).run(id);
  return result.changes > 0;
}

export function validateInviteCode(code: string | undefined): ValidateInviteResult {
  if (!code || typeof code !== 'string') return { valid: false, reason: 'not_found' };
  const normalized = code.trim().toUpperCase();

  const db = getDb();
  const row = db.prepare(`
    SELECT id, max_uses, used_count, expires_at_ms, revoked
    FROM invite_codes
    WHERE code = ?
  `).get(normalized) as {
    id: number;
    max_uses: number;
    used_count: number;
    expires_at_ms: number | null;
    revoked: number;
  } | undefined;

  if (!row) return { valid: false, reason: 'not_found' };
  if (row.revoked) return { valid: false, reason: 'revoked' };
  if (row.expires_at_ms && row.expires_at_ms < Date.now()) return { valid: false, reason: 'expired' };
  if (row.used_count >= row.max_uses) return { valid: false, reason: 'exhausted' };

  return {
    valid: true,
    inviteId: row.id,
    maxUses: row.max_uses,
    usedCount: row.used_count,
  };
}

/**
 * Atomically claim and increment an invite code.
 */
export function claimInviteCode(code: string): boolean {
  const normalized = code.trim().toUpperCase();
  const db = getDb();

  const result = db.prepare(`
    UPDATE invite_codes
    SET used_count = used_count + 1
    WHERE code = ?
      AND revoked = 0
      AND used_count < max_uses
      AND (expires_at_ms IS NULL OR expires_at_ms > ?)
  `).run(normalized, Date.now());

  return result.changes > 0;
}
