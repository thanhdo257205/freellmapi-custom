import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { initDb, getDb } from '../../db/index.js';
import { createUser, updatePassword } from '../../services/auth.js';
import { getExternalAuthConfig } from '../../services/external-auth-config.js';
import {
  startGoogleFlow,
  takeGoogleAttempt,
  verifyGoogleIdToken,
  finishGoogleLogin,
  consumeGoogleHandoff,
} from '../../services/google-auth.js';

beforeEach(() => {
  vi.stubEnv('ENCRYPTION_KEY', '0'.repeat(64));
  vi.stubEnv('PUBLIC_APP_URL', 'https://app.example.com');
  vi.stubEnv('GOOGLE_CLIENT_ID', 'login-client');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'login-secret');
  initDb(':memory:');
});
afterEach(() => {
  getDb().close?.();
  vi.unstubAllEnvs();
});

describe('Google token verification and browser binding', () => {
  it('uses PKCE, nonce and minimal scopes, and consumes browser-bound state once', () => {
    createUser('owner@gmail.com', 'OwnerPassword!');
    const flow = startGoogleFlow(
      getExternalAuthConfig().google!,
      'TEAM-INVITE',
    );
    const url = new URL(flow.url);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('scope')).toBe('openid email');
    expect(url.searchParams.get('nonce')).toHaveLength(43);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const state = url.searchParams.get('state')!;
    expect(flow.cookie).not.toContain('TEAM-INVITE');
    expect(() => takeGoogleAttempt(flow.cookie, 'x'.repeat(43))).toThrow();
    expect(() => takeGoogleAttempt('different-browser', state)).toThrow();
    expect(takeGoogleAttempt(flow.cookie, state).inviteCode).toBe(
      'TEAM-INVITE',
    );
    expect(() => takeGoogleAttempt(flow.cookie, state)).toThrow();
    const expired = startGoogleFlow(getExternalAuthConfig().google!);
    getDb().prepare('UPDATE auth_google_attempts SET expires_at_ms = 1').run();
    expect(() =>
      takeGoogleAttempt(
        expired.cookie,
        new URL(expired.url).searchParams.get('state')!,
      ),
    ).toThrow();
  });

  it('verifies signed tokens and rejects bad issuer, audience, nonce, expiry, signature and claims', async () => {
    const keys = await generateKeyPair('RS256');
    const now = Math.floor(Date.now() / 1000);
    const config = getExternalAuthConfig().google!;
    const base = {
      iss: 'https://accounts.google.com',
      aud: config.clientId,
      sub: 'google-sub',
      iat: now,
      exp: now + 600,
      email: 'owner@gmail.com',
      email_verified: true,
      nonce: 'expected-nonce',
    };
    const sign = (claims: Record<string, unknown>) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256' })
        .sign(keys.privateKey);
    const resolver = async () => keys.publicKey;
    const valid = await sign(base);
    expect(
      await verifyGoogleIdToken(valid, 'expected-nonce', config, resolver),
    ).toEqual({ email: base.email, subject: base.sub, authoritative: true });
    for (const change of [
      { iss: 'https://attacker.example' },
      { aud: 'wrong-client' },
      { nonce: 'wrong' },
      { exp: now - 60 },
      { email_verified: false },
      { azp: 'other-client' },
      { sub: '' },
    ]) {
      await expect(
        verifyGoogleIdToken(
          await sign({ ...base, ...change }),
          'expected-nonce',
          config,
          resolver,
        ),
      ).rejects.toThrow();
    }
    const parts = valid.split('.');
    parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
    await expect(
      verifyGoogleIdToken(parts.join('.'), 'expected-nonce', config, resolver),
    ).rejects.toThrow();
    const workspace = await sign({
      ...base,
      email: 'owner@company.example',
      hd: 'company.example',
    });
    expect(
      (await verifyGoogleIdToken(workspace, 'expected-nonce', config, resolver))
        .authoritative,
    ).toBe(true);
    const external = await sign({ ...base, email: 'owner@external.example' });
    expect(
      (await verifyGoogleIdToken(external, 'expected-nonce', config, resolver))
        .authoritative,
    ).toBe(false);
  });

  it('rejects handoffs after expiry or password revocation', () => {
    const user = createUser('owner@gmail.com', 'OwnerPassword!');
    const identity = { subject: 'sub', email: user.email, authoritative: true };
    const expired = finishGoogleLogin(identity);
    getDb().prepare('UPDATE auth_google_handoffs SET expires_at_ms = 1').run();
    expect(consumeGoogleHandoff(expired)).toBeNull();
    const revoked = finishGoogleLogin(identity);
    updatePassword(user.userId, 'OwnerPassword!', 'ChangedPassword!');
    expect(consumeGoogleHandoff(revoked)).toBeNull();
  });
});
