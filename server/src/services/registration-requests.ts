import { getDb } from '../db/index.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { mintUserApiKey } from './user-keys.js';
import { notifyAdminNewRegistration, notifyUserRegistrationApproved } from './notification-mailer.js';
import type { RegistrationRequest } from '@freellmapi/shared/user-access.js';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createRegistrationRequest(
  email: string,
  password: string,
  note?: string,
): { id: number; email: string; status: 'pending'; createdAt: string } {
  const db = getDb();
  const normalized = normalizeEmail(email);

  if (!normalized || !normalized.includes('@')) {
    const err = new Error('A valid email is required') as any;
    err.code = 'invalid_email';
    throw err;
  }

  if (!password || password.length < 8) {
    const err = new Error('Password must be at least 8 characters') as any;
    err.code = 'invalid_password';
    throw err;
  }

  // 1. Check if user already exists in users table
  const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(normalized);
  if (existingUser) {
    const err = new Error('An account with that email already exists.') as any;
    err.code = 'email_taken';
    throw err;
  }

  // 2. Check existing registration requests
  const existingReq = db.prepare('SELECT id, status FROM registration_requests WHERE email = ?').get(normalized) as
    | { id: number; status: string }
    | undefined;

  if (existingReq) {
    if (existingReq.status === 'pending') {
      const err = new Error('A registration request for this email is already pending approval.') as any;
      err.code = 'request_already_pending';
      throw err;
    }
    if (existingReq.status === 'approved') {
      const err = new Error('An account with that email already exists.') as any;
      err.code = 'email_taken';
      throw err;
    }
    // If previously rejected, allow submitting again
    const hashed = hashPassword(password);
    db.prepare(`
      UPDATE registration_requests
      SET password_hash = ?, note = ?, status = 'pending', created_at = datetime('now'), reviewed_at = NULL, reviewed_by = NULL
      WHERE id = ?
    `).run(hashed, note?.trim() || null, existingReq.id);

    return {
      id: existingReq.id,
      email: normalized,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
  }

  // 3. Insert fresh request
  const hashed = hashPassword(password);
  const result = db.prepare(`
    INSERT INTO registration_requests (email, password_hash, note, status)
    VALUES (?, ?, ?, 'pending')
  `).run(normalized, hashed, note?.trim() || null);

  // Send admin notification asynchronously (non-blocking)
  notifyAdminNewRegistration(normalized, note ?? null).catch(() => {});

  return {
    id: Number(result.lastInsertRowid),
    email: normalized,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
}

export function listRegistrationRequests(status: 'pending' | 'approved' | 'rejected' = 'pending'): RegistrationRequest[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT 
      id,
      email,
      note,
      status,
      created_at AS createdAt,
      reviewed_at AS reviewedAt
    FROM registration_requests
    WHERE status = ?
    ORDER BY id DESC
  `).all(status) as Array<{
    id: number;
    email: string;
    note: string | null;
    status: 'pending' | 'approved' | 'rejected';
    createdAt: string;
    reviewedAt: string | null;
  }>;

  return rows;
}

export function approveRegistrationRequest(
  requestId: number,
  adminUserId: number,
): { userId: number; email: string; role: 'member' } {
  const db = getDb();
  const req = db.prepare('SELECT id, email, password_hash, status FROM registration_requests WHERE id = ?').get(requestId) as
    | { id: number; email: string; password_hash: string; status: string }
    | undefined;

  if (!req) {
    const err = new Error('Registration request not found') as any;
    err.code = 'not_found';
    throw err;
  }

  if (req.status !== 'pending') {
    const err = new Error('Only pending requests can be approved') as any;
    err.code = 'invalid_status';
    throw err;
  }

  // Check if an account was already created with this email
  const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(req.email) as { id: number } | undefined;
  if (existingUser) {
    db.prepare(`UPDATE registration_requests SET status = 'approved', reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?`)
      .run(adminUserId, req.id);
    const err = new Error('An account with that email already exists.') as any;
    err.code = 'email_taken';
    throw err;
  }

  // Insert into users
  const insertUser = db.prepare('INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)')
    .run(req.email, req.password_hash, 'member');
  const userId = Number(insertUser.lastInsertRowid);

  // Mint personal API key for the newly approved member
  mintUserApiKey(userId, 'Default Key');

  // Mark request as approved
  db.prepare(`UPDATE registration_requests SET status = 'approved', reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?`)
    .run(adminUserId, req.id);

  // Send approval email notification asynchronously (non-blocking)
  notifyUserRegistrationApproved(req.email).catch(() => {});

  return { userId, email: req.email, role: 'member' };
}

export function rejectRegistrationRequest(
  requestId: number,
  adminUserId: number,
): { success: boolean } {
  const db = getDb();
  const req = db.prepare('SELECT id, status FROM registration_requests WHERE id = ?').get(requestId) as
    | { id: number; status: string }
    | undefined;

  if (!req) {
    const err = new Error('Registration request not found') as any;
    err.code = 'not_found';
    throw err;
  }

  db.prepare(`UPDATE registration_requests SET status = 'rejected', reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?`)
    .run(adminUserId, req.id);

  return { success: true };
}

export function isRegistrationPending(email: string, password?: string): boolean {
  const db = getDb();
  const normalized = normalizeEmail(email);
  const row = db.prepare('SELECT id, password_hash, status FROM registration_requests WHERE email = ? AND status = ?')
    .get(normalized, 'pending') as { id: number; password_hash: string; status: string } | undefined;

  if (!row) return false;
  if (password !== undefined) {
    return verifyPassword(password, row.password_hash);
  }
  return true;
}
