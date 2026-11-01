import express from 'express';
import type { Server } from 'node:http';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { createUser, validateSession } from '../../services/auth.js';
import { issueEmailReset } from '../../services/email-recovery.js';
import { sendPasswordResetEmail } from '../../services/gmail-mailer.js';
import { externalAuthRouter } from '../../routes/external-auth.js';
import * as googleAuth from '../../services/google-auth.js';

vi.mock('../../services/gmail-mailer.js', () => ({
  sendPasswordResetEmail: vi.fn(async () => {}),
}));
let server: Server;
let base: string;
beforeEach(async () => {
  for (const [key, value] of Object.entries({
    ENCRYPTION_KEY: '0'.repeat(64),
    PUBLIC_APP_URL: 'https://app.example.com',
    GOOGLE_CLIENT_ID: 'login-client',
    GOOGLE_CLIENT_SECRET: 'login-secret',
    GMAIL_CLIENT_ID: 'mailer-client',
    GMAIL_CLIENT_SECRET: 'mailer-secret',
    GMAIL_REFRESH_TOKEN: 'mailer-refresh',
    GMAIL_SENDER: 'sender@gmail.com',
  }))
    vi.stubEnv(key, value);
  initDb(':memory:');
  vi.mocked(sendPasswordResetEmail).mockClear();
  const app = express();
  app.use(express.json());
  app.use('/api/auth', externalAuthRouter);
  app.post('/api/auth/forgot-password', (_req, res) =>
    res.json({ legacy: true }),
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  getDb().close?.();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const hit = (path: string, body?: unknown, cookies?: string, origin?: string) =>
  fetch(base + '/api/auth' + path, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'manual',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookies ? { Cookie: cookies } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

it('publishes only feature flags, gates hosted console reset and preserves local recovery', async () => {
  const methods = await hit('/methods');
  expect(await methods.json()).toEqual({
    googleEnabled: true,
    emailResetEnabled: true,
    legacyResetAllowed: false,
  });
  expect(methods.headers.get('cache-control')).toBe('no-store');
  expect((await hit('/forgot-password', {})).status).toBe(410);
  vi.stubEnv('PUBLIC_APP_URL', '');
  expect(await (await hit('/forgot-password', {})).json()).toEqual({
    legacy: true,
  });
});

it('requires callback cookies, redirects without credentials, rejects cross-origin completion and replay', async () => {
  const user = createUser('owner@gmail.com', 'OwnerPassword!');
  const exchange = vi
    .spyOn(googleAuth, 'exchangeGoogleCode')
    .mockResolvedValue({
      subject: 'google-sub',
      email: user.email,
      authoritative: true,
    });
  const start = await hit('/google/start', {});
  const attemptCookie = start.headers.getSetCookie()[0].split(';')[0];
  expect(start.headers.getSetCookie()[0]).toContain('HttpOnly');
  expect(start.headers.getSetCookie()[0]).toContain('Secure');
  const state = new URL((await start.json()).url).searchParams.get('state');
  const callbackPath = '/google/callback?state=' + state + '&code=google-code';
  const missing = await hit(callbackPath);
  expect(missing.headers.get('location')).toBe(
    'https://app.example.com/?auth_error=google_failed',
  );
  expect(exchange).not.toHaveBeenCalled();
  const callback = await hit(callbackPath, undefined, attemptCookie);
  expect(callback.headers.get('location')).toBe(
    'https://app.example.com/?auth=google',
  );
  const resultCookie = callback.headers
    .getSetCookie()
    .find((value) => value.startsWith('flm_google_result='))!
    .split(';')[0];
  expect(
    (
      await hit(
        '/google/complete',
        {},
        resultCookie,
        'https://attacker.example',
      )
    ).status,
  ).toBe(403);
  const complete = await hit('/google/complete', {}, resultCookie);
  expect(validateSession((await complete.json()).token)?.userId).toBe(
    user.userId,
  );
  expect((await hit('/google/complete', {}, resultCookie)).status).toBe(400);
  expect(
    (await hit(callbackPath, undefined, attemptCookie)).headers.get('location'),
  ).toContain('auth_error=');
  expect(exchange).toHaveBeenCalledTimes(1);
});

it('returns the same recovery acknowledgement, limits mail, and requires a single-use token', async () => {
  const user = createUser('member@gmail.com', 'MemberPassword!');
  const first = await hit('/email/forgot-password', { email: user.email });
  const second = await hit('/email/forgot-password', {
    email: 'missing@gmail.com',
  });
  expect(await first.json()).toEqual(await second.json());
  for (let i = 0; i < 4; i++)
    await hit('/email/forgot-password', { email: user.email });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sendPasswordResetEmail).toHaveBeenCalledTimes(3);
  const token = issueEmailReset(user.email)!;
  expect(
    await (
      await hit('/email/reset-password', {
        token,
        newPassword: 'ReplacementPassword!',
      })
    ).json(),
  ).toEqual({ success: true });
  expect(
    (
      await hit('/email/reset-password', {
        token,
        newPassword: 'ReplacementPassword!',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await hit(
        '/email/forgot-password',
        { email: user.email },
        undefined,
        'https://attacker.example',
      )
    ).status,
  ).toBe(403);
});
