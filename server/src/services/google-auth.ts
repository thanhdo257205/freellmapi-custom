import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import type { ExternalAuthResult } from '@freellmapi/shared/external-auth.js';
import { getDb } from '../db/index.js';
import {
  createUser,
  createSession,
  normalizeEmail,
  userCount,
  validateSession,
} from './auth.js';
import { claimInviteCode } from './invites.js';
import { mintUserApiKey } from './user-keys.js';
import {
  digest,
  randomSecret,
  safeEqual,
  seal,
  unseal,
  purgeExpiredAuth,
} from './auth-security.js';
import type { GoogleAuthConfig } from './external-auth-config.js';

const googleKeys = createRemoteJWKSet(
  new URL('https://www.googleapis.com/oauth2/v3/certs'),
);
const attemptSchema = z.object({
  state: z.string().length(43),
  nonce: z.string().length(43),
  verifier: z.string().length(43),
  inviteCode: z.string().max(128).optional(),
  expiresAt: z.number(),
});
export type GoogleAttempt = z.infer<typeof attemptSchema>;
export interface GoogleIdentity {
  subject: string;
  email: string;
  authoritative: boolean;
}

export function startGoogleFlow(config: GoogleAuthConfig, inviteCode?: string) {
  if (userCount() === 0)
    throw new Error('Complete account setup before Google sign-in');
  purgeExpiredAuth();
  const attempt: GoogleAttempt = {
    state: randomSecret(),
    nonce: randomSecret(),
    verifier: randomSecret(),
    inviteCode,
    expiresAt: Date.now() + 10 * 60 * 1000,
  };
  getDb()
    .prepare(
      'INSERT INTO auth_google_attempts (state_hash, expires_at_ms) VALUES (?, ?)',
    )
    .run(digest(attempt.state), attempt.expiresAt);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'openid email',
    state: attempt.state,
    nonce: attempt.nonce,
    code_challenge: crypto
      .createHash('sha256')
      .update(attempt.verifier)
      .digest('base64url'),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return { url: url.href, cookie: seal(attempt) };
}

export function takeGoogleAttempt(
  cookie: string,
  state: string,
): GoogleAttempt {
  if (!cookie) {
    console.error('[google-auth] takeGoogleAttempt: attempt cookie missing in request headers');
    throw new Error('missing_attempt_cookie');
  }
  let attempt: GoogleAttempt;
  try {
    attempt = attemptSchema.parse(unseal(cookie));
  } catch (err) {
    console.error('[google-auth] takeGoogleAttempt: failed to unseal cookie:', err);
    throw new Error('invalid_attempt_cookie');
  }
  if (!safeEqual(attempt.state, state) || attempt.expiresAt <= Date.now()) {
    console.error('[google-auth] takeGoogleAttempt: state mismatch or attempt expired');
    throw new Error('Invalid Google callback');
  }
  const result = getDb()
    .prepare(
      'DELETE FROM auth_google_attempts WHERE state_hash = ? AND expires_at_ms > ?',
    )
    .run(digest(state), Date.now());
  if (result.changes !== 1) {
    console.error('[google-auth] takeGoogleAttempt: state hash not found in db or already consumed');
    throw new Error('Invalid Google callback');
  }
  return attempt;
}

// jose gives exp, nbf and maxTokenAge one shared clockTolerance. Two minutes of
// skew is what the iat/nbf claims need, but exp is what limits how long a
// captured token can be replayed, so it is re-checked against a margin of its own.
const CLOCK_TOLERANCE_SECONDS = 120;
const EXPIRY_TOLERANCE_SECONDS = 5;

export async function verifyGoogleIdToken(
  token: string,
  nonce: string,
  config: GoogleAuthConfig,
  keys: JWTVerifyGetKey = googleKeys,
): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(token, keys, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: config.clientId,
    algorithms: ['RS256'],
    requiredClaims: ['exp', 'iat', 'sub', 'email', 'email_verified', 'nonce'],
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
    maxTokenAge: '10m',
  });
  if (
    payload.exp === undefined ||
    payload.exp + EXPIRY_TOLERANCE_SECONDS <= Math.floor(Date.now() / 1000) ||
    typeof payload.nonce !== 'string' ||
    !safeEqual(payload.nonce, nonce) ||
    payload.email_verified !== true ||
    (payload.azp !== undefined && payload.azp !== config.clientId)
  )
    throw new Error('Invalid Google identity');
  const email = z.string().email().max(254).parse(payload.email);
  const subject = z.string().min(1).max(255).parse(payload.sub);
  const normalized = normalizeEmail(email);
  return {
    subject,
    email: normalized,
    authoritative:
      normalized.endsWith('@gmail.com') ||
      (typeof payload.hd === 'string' && payload.hd.length > 0),
  };
}

export async function exchangeGoogleCode(
  code: string,
  attempt: GoogleAttempt,
  config: GoogleAuthConfig,
): Promise<GoogleIdentity> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: attempt.verifier,
    }),
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    console.error('[google-auth] Google token exchange HTTP', response.status, errorBody);
    throw new Error(`Google token exchange failed (${response.status}): ${errorBody}`);
  }
  const data = (await response.json()) as { id_token?: string };
  if (!data.id_token) {
    console.error('[google-auth] Google token response missing id_token');
    throw new Error('Google sign-in failed');
  }
  return verifyGoogleIdToken(data.id_token, attempt.nonce, config);
}

/** Account creation, invite claim, key minting and result storage succeed together. */
export function finishGoogleLogin(
  identity: GoogleIdentity,
  inviteCode?: string,
): string {
  const db = getDb();
  purgeExpiredAuth();
  return db.transaction(() => {
    if (userCount() === 0) throw new Error('Account setup required');
    let user = db
      .prepare(
        `SELECT u.id, u.email, u.role FROM users u JOIN auth_google_identities i ON i.user_id = u.id
      WHERE i.subject = ?`,
      )
      .get(identity.subject) as
      | { id: number; email: string; role: 'admin' | 'member' }
      | undefined;
    let apiKey: string | undefined;
    if (!user) {
      user = db
        .prepare('SELECT id, email, role FROM users WHERE email = ?')
        .get(normalizeEmail(identity.email)) as
        | { id: number; email: string; role: 'admin' | 'member' }
        | undefined;
      if (user) {
        if (
          !identity.authoritative ||
          db
            .prepare('SELECT 1 FROM auth_google_identities WHERE user_id = ?')
            .get(user.id)
        ) {
          throw new Error(
            'Existing account cannot be linked by this Google email',
          );
        }
      } else {
        if (!inviteCode || !claimInviteCode(inviteCode))
          throw new Error('A valid invitation is required');
        const created = createUser(identity.email, randomSecret(), 'member');
        user = { id: created.userId, email: created.email, role: 'member' };
        apiKey = mintUserApiKey(user.id, 'Default Key').key;
      }
      db.prepare(
        'INSERT INTO auth_google_identities (subject, user_id) VALUES (?, ?)',
      ).run(identity.subject, user.id);
    }
    const result: ExternalAuthResult = {
      token: createSession(user.id),
      email: user.email,
      role: user.role,
      ...(apiKey ? { apiKey } : {}),
    };
    const ticket = randomSecret();
    db.prepare(
      'INSERT INTO auth_google_handoffs (ticket_hash, user_id, payload, expires_at_ms) VALUES (?, ?, ?, ?)',
    ).run(digest(ticket), user.id, seal(result), Date.now() + 2 * 60 * 1000);
    return ticket;
  })();
}

export function consumeGoogleHandoff(
  ticket: string,
): ExternalAuthResult | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
  const db = getDb();
  return db.transaction(() => {
    const row = db
      .prepare(
        'SELECT payload FROM auth_google_handoffs WHERE ticket_hash = ? AND expires_at_ms > ?',
      )
      .get(digest(ticket), Date.now()) as { payload: string } | undefined;
    if (!row) return null;
    db.prepare('DELETE FROM auth_google_handoffs WHERE ticket_hash = ?').run(
      digest(ticket),
    );
    const payload = unseal(row.payload) as ExternalAuthResult;
    const user = validateSession(payload.token);
    return user ? { ...payload, email: user.email, role: user.role } : null;
  })();
}
