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

// Deliberately duplicated from PERMISSION_GATES rather than imported: if a
// merge or an edit shrinks the real list, this copy still demands the 403 and
// the test fails.
const FULL_METHOD_GATES: Array<[string, string]> = [
  ['/api/keys', 'manage_keys'],
  ['/api/client-profiles', 'manage_settings'],
  ['/api/settings', 'manage_settings'],
  ['/api/update', 'manage_settings'],
  ['/api/backups', 'manage_backups'],
  ['/api/logs', 'view_logs'],
  ['/api/analytics', 'view_logs'],
  ['/api/health', 'manage_keys'],
  ['/api/free-tier', 'manage_keys'],
  ['/api/fallback/rate-limit-usage', 'manage_keys'],
  ['/api/fallback/token-usage', 'view_logs'],
  ['/api/fallback/quota-forecast', 'view_logs'],
  ['/api/invites', 'manage_invites'],
  ['/api/admin/users', 'manage_users'],
  ['/api/admin/registration-requests', 'manage_requests'],
];

// Shared configuration and credential-minting surfaces: reads stay open because
// the member-facing dashboard renders them, writes do not.
const WRITE_METHOD_GATES: Array<[string, 'POST' | 'PUT' | 'PATCH' | 'DELETE', string]> = [
  ['/api/profiles', 'POST', 'manage_settings'],
  ['/api/profiles/active', 'PUT', 'manage_settings'],
  ['/api/models', 'POST', 'manage_settings'],
  ['/api/models/1', 'PATCH', 'manage_settings'],
  ['/api/fallback', 'PUT', 'manage_settings'],
  ['/api/fallback/routing', 'PUT', 'manage_settings'],
  ['/api/cache/config', 'PUT', 'manage_settings'],
  ['/api/compression/preview', 'POST', 'manage_settings'],
  ['/api/premium/key', 'POST', 'manage_settings'],
  ['/api/embeddings/custom', 'POST', 'manage_keys'],
  ['/api/media/1', 'PUT', 'manage_keys'],
  ['/api/search/engines/1', 'PATCH', 'manage_keys'],
  ['/api/decisions/models/1', 'PATCH', 'manage_keys'],
];

// The exact member-facing reads that must keep working; a gate that breaks these
// turns the Playground into a wall of 403s.
const MEMBER_READABLE = [
  '/api/models',
  '/api/profiles',
  '/api/fallback',
  '/api/search/engines',
  '/api/media',
  '/api/embeddings',
  '/api/decisions/models',
  '/api/premium',
  '/api/user/keys',
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
    for (const [path, permission] of FULL_METHOD_GATES) {
      const res = await hit(path, 'GET', undefined, memberToken);
      expect(res.status, `${path} must stay gated`).toBe(403);
      expect(res.body?.error?.type, `${path} error shape`).toBe('forbidden');
      expect(res.body?.error?.message, `${path} names the missing permission`).toContain(permission);
    }
  });

  // A permission that only covers reads is no control at all: these are the
  // writes that rewrite server-wide routing, catalog, cache, or credentials.
  it('rejects a member session with 403 on every shared-configuration write', async () => {
    for (const [path, method, permission] of WRITE_METHOD_GATES) {
      const res = await hit(path, method, {}, memberToken);
      expect(res.status, `${method} ${path} must be gated`).toBe(403);
      expect(res.body?.error?.type, `${method} ${path} error shape`).toBe('forbidden');
      expect(res.body?.error?.message, `${method} ${path} names the missing permission`).toContain(permission);
    }
  });

  // The other half of the same rule: the member Playground and model tabs read
  // these lists, so a gate that swallows them is a regression, not a hardening.
  it('keeps member-facing configuration reads available', async () => {
    for (const path of MEMBER_READABLE) {
      const res = await hit(path, 'GET', undefined, memberToken);
      expect(res.status, `${path} must not be gated from a member`).not.toBe(403);
      expect(res.status, `${path} must not fall through to 401`).not.toBe(401);
    }
  });

  it('keeps admin sessions and the untouched upstream auth routes working', async () => {
    for (const path of FULL_METHOD_GATES.map(([p]) => p)) {
      const res = await hit(path, 'GET', undefined, adminToken);
      expect(res.status, `${path} must not be gated away from admins`).not.toBe(403);
      expect(res.status, `${path} must not fall through to 401`).not.toBe(401);
    }
    for (const [path, method] of WRITE_METHOD_GATES) {
      const res = await hit(path, method, {}, adminToken);
      expect(res.status, `${method} ${path} must not be gated away from admins`).not.toBe(403);
      expect(res.status, `${method} ${path} must not fall through to 401`).not.toBe(401);
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
