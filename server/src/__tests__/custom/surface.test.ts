import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import { initDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_MIGRATIONS,
  CUSTOM_USER_ROLES_AND_KEYS_FILENAME,
  LEGACY_BASELINE_FILENAME,
} from '../../db/migrate/defaults.js';
import { createUser, createSession } from '../../services/auth.js';
import { createInviteCode } from '../../services/invites.js';

// Tripwire for the fork's customization surface. Each assertion fails if a
// future `git merge upstream/main` drops a custom mount, the admin gate, or the
// custom migration registration — the failure mode where RBAC silently stops
// existing while the app still boots and serves traffic.

// Deliberately duplicated from ADMIN_ONLY_PREFIXES rather than imported: if a
// merge or an edit shrinks the real list, this copy still demands the 403 and
// the test fails.
const ADMIN_ONLY = [
  '/api/keys',
  '/api/client-profiles',
  '/api/logs',
  '/api/settings',
  '/api/backups',
  '/api/update',
  '/api/invites',
  '/api/admin/users',
  '/api/admin/registration-requests',
];

let server: Server;
let base: string;
let adminId: number;
let adminToken: string;
let memberToken: string;

async function hit(path: string, method = 'GET', body?: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

describe('Customization surface', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    // createApp() twice on purpose: the gate must live on the app it builds,
    // not on module state that a second app would inherit or double-apply.
    const app = createApp();
    createApp();
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;

    const admin = createUser('owner@example.com', 'OwnerPass123!');
    adminId = admin.userId;
    memberToken = createSession(createUser('guest@example.com', 'GuestPass123!', 'member').userId);
    adminToken = createSession(adminId);
  });

  afterAll(() => {
    server?.close();
  });

  it('keeps the custom migration registered in the default set', () => {
    const filenames = DEFAULT_MIGRATIONS.map(m => m.filename);
    expect(filenames).toContain(CUSTOM_USER_ROLES_AND_KEYS_FILENAME);
    // It must run after the baseline that creates `users`, which is the only
    // ordering it depends on. Upstream appends its own migrations each release,
    // so asserting "last" here would cry wolf on every sync.
    expect(filenames.indexOf(CUSTOM_USER_ROLES_AND_KEYS_FILENAME))
      .toBeGreaterThan(filenames.indexOf(LEGACY_BASELINE_FILENAME));
    const custom = DEFAULT_MIGRATIONS.find(m => m.filename === CUSTOM_USER_ROLES_AND_KEYS_FILENAME);
    expect(typeof custom?.module.up).toBe('function');
    expect(typeof custom?.module.down).toBe('function');
  });

  it('rejects a member session with 403 on every admin-gated surface', async () => {
    for (const path of ADMIN_ONLY) {
      const res = await hit(path, 'GET', undefined, memberToken);
      expect(res.status, `${path} must stay admin-only`).toBe(403);
      expect(res.body?.error?.type, `${path} error shape`).toBe('forbidden');
    }
  });

  it('keeps admin sessions and the untouched upstream auth routes working', async () => {
    for (const path of ADMIN_ONLY) {
      const res = await hit(path, 'GET', undefined, adminToken);
      expect(res.status, `${path} must not be gated away from admins`).not.toBe(403);
      expect(res.status, `${path} must not fall through to 401`).not.toBe(401);
    }
    const status = await hit('/api/auth/status');
    expect(status.status).toBe(200);
    // Upstream's response shape, with no `role`: the fork reads it from
    // /api/user/session instead of editing routes/auth.ts.
    expect(status.body).toHaveProperty('needsSetup');
    expect(status.body).not.toHaveProperty('role');
    expect((await hit('/api/ping')).status).toBe(200);
  });

  it('serves the custom routes from the fork, not from upstream auth routes', async () => {
    const session = await hit('/api/user/session', 'GET', undefined, memberToken);
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ email: 'guest@example.com', role: 'member' });

    const invalid = await hit('/api/auth/validate-invite?code=NOPE');
    expect(invalid.status).toBe(200);
    expect(invalid.body).toEqual({ valid: false, reason: 'not_found' });

    const badRegister = await hit('/api/auth/register', 'POST', {
      email: 'late@example.com',
      password: 'GuestPass123!',
      inviteCode: 'NOPE',
    });
    expect(badRegister.status).toBe(400);
    expect(badRegister.body?.error?.type).toBe('invalid_invite_code');

    createInviteCode(adminId, { code: 'TRIPWIRE-2026', maxUses: 1 });
    // Codes are matched case-insensitively.
    const okRegister = await hit('/api/auth/register', 'POST', {
      email: 'late@example.com',
      password: 'GuestPass123!',
      inviteCode: 'tripwire-2026',
    });
    expect(okRegister.status).toBe(201);
    expect(okRegister.body?.role).toBe('member');
    expect(okRegister.body?.apiKey).toMatch(/^sk-flm-/);

    // A personal key authenticates /v1 inference only — never the dashboard API.
    const keysWithUserKey = await fetch(`${base}/api/user/keys`, {
      headers: { Authorization: `Bearer ${okRegister.body.apiKey}` },
    }).then(r => r.status);
    expect(keysWithUserKey).toBe(401);
  });

  it('consumes exactly one invite slot per registration', async () => {
    const list = await hit('/api/invites', 'GET', undefined, adminToken);
    const code = list.body.invites.find((i: { code: string }) => i.code === 'TRIPWIRE-2026');
    expect(code.usedCount).toBe(1);
    expect(code.status).toBe('exhausted');

    const second = await hit('/api/auth/register', 'POST', {
      email: 'late2@example.com',
      password: 'GuestPass123!',
      inviteCode: 'TRIPWIRE-2026',
    });
    expect(second.status).toBe(400);
    expect(second.body?.error?.message).toMatch(/maximum uses/);
  });
});
