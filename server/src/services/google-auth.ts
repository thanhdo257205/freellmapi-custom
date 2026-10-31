import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import { normalizeEmail, createUser, createSession } from './auth.js';
import { validateInviteCode, claimInviteCode } from './invites.js';
import { mintUserApiKey } from './user-keys.js';
import { digest, randomSecret, seal, unseal, purgeExpiredAuth } from './auth-security.js';
import { getExternalAuthConfig, type GoogleAuthConfig } from './external-auth-config.js';

const HANDOFF_TTL_MS = 5 * 60 * 1000;
const ATTEMPT_TTL_MS = 10 * 60 * 1000;

export interface GoogleVerifiedIdentity {
  email: string;
  subject: string;
  authoritative: boolean;
}

export interface GoogleHandoffResult {
  token: string;
  email: string;
  role: 'admin' | 'member';
  apiKey?: string;
}

export function finishGoogleLogin(identity: GoogleVerifiedIdentity, inviteCode?: string): string {
  if (!identity.authoritative) {
    throw new Error('Non-authoritative Google email identity cannot be used');
  }

  const email = normalizeEmail(identity.email);
  const db = getDb();
  purgeExpiredAuth();

  return db.transaction(() => {
    let userRow = db.prepare(`
      SELECT u.id, u.email, u.role FROM auth_google_identities g
      JOIN users u ON u.id = g.user_id
      WHERE g.subject = ?
    `).get(identity.subject) as { id: number; email: string; role: 'admin' | 'member' } | undefined;

    let initialApiKey: string | undefined;

    if (!userRow) {
      // Check if user exists by email
      const existingUser = db.prepare('SELECT id, email, role FROM users WHERE email = ?').get(email) as { id: number; email: string; role: 'admin' | 'member' } | undefined;

      if (existingUser) {
        // Ensure this user isn't already bound to a different Google subject
        const existingBinding = db.prepare('SELECT subject FROM auth_google_identities WHERE user_id = ?').get(existingUser.id) as { subject: string } | undefined;
        if (existingBinding && existingBinding.subject !== identity.subject) {
          throw new Error('Account is already linked to a different Google account');
        }
        if (!existingBinding) {
          db.prepare('INSERT INTO auth_google_identities (subject, user_id) VALUES (?, ?)').run(identity.subject, existingUser.id);
        }
        userRow = existingUser;
      } else {
        // New account registration requires valid invite code
        if (!inviteCode) {
          throw new Error('Invite code is required for registration');
        }
        const validation = validateInviteCode(inviteCode);
        if (!validation.valid) {
          throw new Error(`Invalid invite code: ${validation.reason}`);
        }

        const randomPassword = crypto.randomBytes(32).toString('hex') + 'A1!';
        const created = createUser(email, randomPassword, 'member');
        claimInviteCode(inviteCode);

        db.prepare('INSERT INTO auth_google_identities (subject, user_id) VALUES (?, ?)').run(identity.subject, created.userId);

        const minted = mintUserApiKey(created.userId, 'Default Key');
        initialApiKey = minted.key;

        userRow = { id: created.userId, email: created.email, role: 'member' };
      }
    }

    const sessionToken = createSession(userRow.id);
    const ticket = randomSecret();
    const payload: GoogleHandoffResult = {
      token: sessionToken,
      email: userRow.email,
      role: userRow.role,
      apiKey: initialApiKey,
    };

    db.prepare(`
      INSERT INTO auth_google_handoffs (ticket_hash, user_id, payload, expires_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(digest(ticket), userRow.id, seal(payload), Date.now() + HANDOFF_TTL_MS);

    return ticket;
  })();
}

export function consumeGoogleHandoff(ticket: string): GoogleHandoffResult | null {
  if (!ticket || typeof ticket !== 'string') return null;
  const db = getDb();
  purgeExpiredAuth();

  return db.transaction(() => {
    const ticketHash = digest(ticket);
    const row = db.prepare(`
      SELECT payload FROM auth_google_handoffs
      WHERE ticket_hash = ? AND expires_at_ms > ?
    `).get(ticketHash, Date.now()) as { payload: string } | undefined;

    if (!row) return null;

    db.prepare('DELETE FROM auth_google_handoffs WHERE ticket_hash = ?').run(ticketHash);

    try {
      return unseal(row.payload) as GoogleHandoffResult;
    } catch {
      return null;
    }
  })();
}

export interface GoogleAttemptData {
  verifier: string;
  inviteCode?: string;
}

export function startGoogleFlow(config: GoogleAuthConfig, inviteCode?: string): { url: string; cookie: string } {
  const state = randomSecret();
  const verifier = randomSecret();
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  const db = getDb();
  purgeExpiredAuth();
  db.prepare(`
    INSERT INTO auth_google_attempts (state_hash, expires_at_ms)
    VALUES (?, ?)
  `).run(digest(state), Date.now() + ATTEMPT_TTL_MS);

  const attemptData = { state, verifier, inviteCode: inviteCode?.trim() || null };
  const cookie = seal(attemptData);

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    prompt: 'select_account',
  });

  return {
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    cookie,
  };
}

export function takeGoogleAttempt(cookieVal: string, state: string): GoogleAttemptData {
  let attemptData: { state: string; verifier: string; inviteCode: string | null };
  try {
    attemptData = unseal(cookieVal) as any;
  } catch {
    throw new Error('Invalid or expired authentication attempt');
  }

  if (!attemptData || attemptData.state !== state) {
    throw new Error('State mismatch');
  }

  const db = getDb();
  const stateHash = digest(state);
  const deleted = db.prepare('DELETE FROM auth_google_attempts WHERE state_hash = ? AND expires_at_ms > ?').run(stateHash, Date.now());
  if (deleted.changes === 0) {
    throw new Error('Authentication attempt has expired or already been used');
  }

  return {
    verifier: attemptData.verifier,
    inviteCode: attemptData.inviteCode || undefined,
  };
}

export async function exchangeGoogleCode(code: string, attempt: GoogleAttemptData, config: GoogleAuthConfig): Promise<GoogleVerifiedIdentity> {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: attempt.verifier,
      grant_type: 'authorization_code',
      redirect_uri: config.redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    throw new Error('Failed to exchange Google authorization code');
  }

  const tokens = await tokenRes.json() as { id_token?: string; access_token?: string };
  if (!tokens.id_token) {
    throw new Error('Missing ID token from Google');
  }

  const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokens.id_token)}`, {
    signal: AbortSignal.timeout(10000),
  });

  if (!infoRes.ok) {
    throw new Error('Failed to verify Google ID token');
  }

  const payload = await infoRes.json() as {
    aud: string;
    sub: string;
    email: string;
    email_verified: string | boolean;
  };

  if (payload.aud !== config.clientId) {
    throw new Error('Invalid token audience');
  }

  const isVerified = payload.email_verified === true || payload.email_verified === 'true';
  const authoritative = isVerified && payload.email.endsWith('@gmail.com');

  return {
    email: payload.email,
    subject: payload.sub,
    authoritative,
  };
}

export function createGoogleAuthAttempt(inviteCode?: string): { url: string; stateCookie: string } {
  const config = getExternalAuthConfig().google;
  if (!config) {
    throw new Error('Google authentication is not configured');
  }
  const flow = startGoogleFlow(config, inviteCode);
  return {
    url: flow.url,
    stateCookie: flow.cookie,
  };
}

export async function verifyGoogleAuthCode(code: string, state: string, stateCookie: string): Promise<string> {
  const config = getExternalAuthConfig().google;
  if (!config) throw new Error('Google authentication is not configured');
  const attempt = takeGoogleAttempt(stateCookie, state);
  const identity = await exchangeGoogleCode(code, attempt, config);
  return finishGoogleLogin(identity, attempt.inviteCode);
}
