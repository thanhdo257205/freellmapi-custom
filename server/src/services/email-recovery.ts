import { getDb } from '../db/index.js';
import { normalizeEmail } from './auth.js';
import { hashPassword } from '../lib/password.js';
import { digest, randomSecret, purgeExpiredAuth } from './auth-security.js';
import { getExternalAuthConfig } from './external-auth-config.js';
import { sendPasswordResetEmail } from './gmail-mailer.js';

const RESET_TTL_MS = 15 * 60 * 1000;
interface RecoveryUser { id: number; email: string; password_hash: string }
const fingerprint = (user: RecoveryUser) => digest(user.email + '\0' + user.password_hash);

export function issueEmailReset(email: string): string | null {
  const db = getDb();
  purgeExpiredAuth();
  return db.transaction(() => {
    const user = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(normalizeEmail(email)) as RecoveryUser | undefined;
    if (!user) return null;
    const token = randomSecret();
    db.prepare('DELETE FROM auth_email_resets WHERE user_id = ?').run(user.id);
    db.prepare('INSERT INTO auth_email_resets (token_hash, user_id, account_fingerprint, expires_at_ms) VALUES (?, ?, ?, ?)')
      .run(digest(token), user.id, fingerprint(user), Date.now() + RESET_TTL_MS);
    return token;
  })();
}

export async function requestEmailReset(email: string): Promise<void> {
  const config = getExternalAuthConfig().gmail;
  if (!config) throw new Error('Email recovery is not configured');
  const normalized = normalizeEmail(email);
  const token = issueEmailReset(normalized);
  if (!token) return;
  try {
    await sendPasswordResetEmail(normalized, config.publicUrl + '/#reset_token=' + encodeURIComponent(token));
  } catch (error) {
    getDb().prepare('DELETE FROM auth_email_resets WHERE token_hash = ?').run(digest(token));
    throw error;
  }
}

export function completeEmailReset(token: string, newPassword: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || newPassword.length < 8 || newPassword.length > 128) return false;
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare(`SELECT u.id, u.email, u.password_hash, r.account_fingerprint FROM auth_email_resets r
      JOIN users u ON u.id = r.user_id WHERE r.token_hash = ? AND r.expires_at_ms > ?`)
      .get(digest(token), Date.now()) as (RecoveryUser & { account_fingerprint: string }) | undefined;
    if (!row || row.account_fingerprint !== fingerprint(row)) return false;
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), row.id);
    db.prepare('DELETE FROM auth_email_resets WHERE user_id = ?').run(row.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    // Pending Google results must not resurrect a revoked session after recovery.
    db.prepare('DELETE FROM auth_google_handoffs WHERE user_id = ?').run(row.id);
    return true;
  })();
}
