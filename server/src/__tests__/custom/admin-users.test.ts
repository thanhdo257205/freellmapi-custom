import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import { initDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createUser, createSession } from '../../services/auth.js';
import { mintUserApiKey } from '../../services/user-keys.js';

// Behaviour of the admin user-management surface. The 403-for-members case is
// also covered by surface.test.ts (prefix tripwire); what lives here is what the
// endpoints actually do once an admin reaches them.

let server: Server;
let base: string;
let adminId: number;
let adminToken: string;
let memberId: number;
let memberToken: string;

async function hit(
  path: string,
  method = 'GET',
  body?: unknown,
  token?: string,
) {
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

describe('Admin user management', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    createApp();
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;

    const admin = createUser('owner@example.com', 'OwnerPass123!');
    adminId = admin.userId;
    const member = createUser('guest@example.com', 'GuestPass123!', 'member');
    memberId = member.userId;
    adminToken = createSession(adminId);
    memberToken = createSession(memberId);
  });

  afterAll(() => {
    server?.close();
  });

  it('refuses a member session at the prefix', async () => {
    const res = await hit('/api/admin/users', 'GET', undefined, memberToken);
    expect(res.status).toBe(403);
    expect(res.body?.error?.type).toBe('forbidden');
  });

  it('lists accounts with live key and session counts, flagging the caller', async () => {
    mintUserApiKey(memberId, 'Default Key');
    createSession(memberId); // a second device

    const res = await hit('/api/admin/users', 'GET', undefined, adminToken);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(
      (res.body.users as any[]).map(u => [u.id, u]),
    );

    expect(byId[adminId]).toMatchObject({
      email: 'owner@example.com',
      role: 'admin',
      isSelf: true,
      activeKeys: 0,
    });
    expect(byId[memberId]).toMatchObject({
      email: 'guest@example.com',
      role: 'member',
      isSelf: false,
      activeKeys: 1,
    });
    // The admin has one session of their own; the member now has two.
    expect(byId[adminId].sessions).toBe(1);
    expect(byId[memberId].sessions).toBe(2);
    // No secret material crosses the wire.
    expect(JSON.stringify(res.body)).not.toMatch(/sk-flm-/);
  });

  it('promotes and demotes with the effect visible on the target next request', async () => {
    const promoted = await hit(`/api/admin/users/${memberId}/role`, 'PATCH', { role: 'admin' }, adminToken);
    expect(promoted.status).toBe(200);
    // The member's existing token still works and now reads as admin: role is
    // re-read from the row, so there is nothing to re-issue.
    const asAdmin = await hit('/api/user/session', 'GET', undefined, memberToken);
    expect(asAdmin.body).toMatchObject({ role: 'admin' });

    const demoted = await hit(`/api/admin/users/${memberId}/role`, 'PATCH', { role: 'member' }, adminToken);
    expect(demoted.status).toBe(200);
    const gated = await hit('/api/keys', 'GET', undefined, memberToken);
    expect(gated.status).toBe(403);
  });

  it('will not let the caller change their own role', async () => {
    const res = await hit(`/api/admin/users/${adminId}/role`, 'PATCH', { role: 'member' }, adminToken);
    expect(res.status).toBe(409);
    expect(res.body?.error?.type).toBe('self_role_change');

    const still = await hit('/api/user/session', 'GET', undefined, adminToken);
    expect(still.body).toMatchObject({ role: 'admin' });
  });

  it('rejects a bad id or a bad role before touching the database', async () => {
    expect((await hit('/api/admin/users/not-a-number/role', 'PATCH', { role: 'member' }, adminToken)).status).toBe(400);
    const badRole = await hit(`/api/admin/users/${memberId}/role`, 'PATCH', { role: 'root' }, adminToken);
    expect(badRole.status).toBe(400);
    expect(badRole.body?.error?.type).toBe('invalid_role');
    const missing = await hit('/api/admin/users/999999/role', 'PATCH', { role: 'member' }, adminToken);
    expect(missing.status).toBe(404);
    expect(missing.body?.error?.type).toBe('user_not_found');
  });

  it('ends every session of an account, including the one making the request', async () => {
    mintUserApiKey(memberId, 'Second Key');

    const revoked = await hit(`/api/admin/users/${memberId}/revoke-keys`, 'POST', undefined, adminToken);
    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({ revoked: 2 });

    // Both rows survive as history, marked revoked, and stop authenticating.
    const keys = await hit('/api/user/keys', 'GET', undefined, memberToken);
    expect((keys.body.keys as any[]).every(k => k.revoked)).toBe(true);
    const deadKey = await hit('/api/user/keys', 'GET', undefined, 'sk-flm-does-not-exist');
    expect(deadKey.status).toBe(401);

    const again = await hit(`/api/admin/users/${memberId}/revoke-keys`, 'POST', undefined, adminToken);
    expect(again.body).toEqual({ revoked: 0 });

    const sessions = await hit(`/api/admin/users/${memberId}/revoke-sessions`, 'POST', undefined, adminToken);
    expect(sessions.body).toEqual({ revoked: 2 });
    const after = await hit('/api/user/session', 'GET', undefined, memberToken);
    expect(after.status).toBe(401);

    const missing = await hit('/api/admin/users/999999/revoke-sessions', 'POST', undefined, adminToken);
    expect(missing.status).toBe(404);
  });
});
