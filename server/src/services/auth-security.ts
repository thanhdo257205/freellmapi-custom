import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import { encrypt, decrypt } from '../lib/crypto.js';

export const randomSecret = () => crypto.randomBytes(32).toString('base64url');
export const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
export function seal(value: unknown): string {
  return Buffer.from(JSON.stringify(encrypt(JSON.stringify(value)))).toString('base64url');
}
export function unseal(value: string): unknown {
  if (value.length > 6000) throw new Error('Invalid encrypted payload');
  const data = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  return JSON.parse(decrypt(data.encrypted, data.iv, data.authTag));
}
export function purgeExpiredAuth(now = Date.now()): void {
  const db = getDb();
  for (const table of ['auth_google_attempts', 'auth_google_handoffs', 'auth_email_resets']) {
    db.prepare(`DELETE FROM ${table} WHERE expires_at_ms <= ?`).run(now);
  }
}
/** Durable fixed windows. Addresses/IPs are hashed; the table is bounded. */
export function allowAuthRequest(bucket: string, limit: number, now = Date.now()): boolean {
  const db = getDb();
  const windowMs = 15 * 60 * 1000;
  db.prepare('DELETE FROM auth_request_limits WHERE started_at_ms <= ?').run(now - windowMs);
  const size = db.prepare('SELECT COUNT(*) AS n FROM auth_request_limits').get() as { n: number };
  const key = digest(bucket);
  if (size.n >= 10000 && !db.prepare('SELECT 1 FROM auth_request_limits WHERE bucket_hash = ?').get(key)) return false;
  db.prepare(`INSERT INTO auth_request_limits (bucket_hash, started_at_ms, attempts) VALUES (?, ?, 1)
    ON CONFLICT(bucket_hash) DO UPDATE SET attempts = attempts + 1`).run(key, now);
  const row = db.prepare('SELECT attempts FROM auth_request_limits WHERE bucket_hash = ?').get(key) as { attempts: number };
  return row.attempts <= limit;
}
