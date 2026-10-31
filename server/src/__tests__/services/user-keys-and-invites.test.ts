import { describe, expect, it, beforeAll } from 'vitest';
import type { Express } from 'express';
import { initDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import {
  createInviteCode,
  listInviteCodes,
  validateInviteCode,
  revokeInviteCode,
  claimInviteCode,
} from '../../services/invites.js';
import {
  mintUserApiKey,
  listUserApiKeys,
  revokeUserApiKey,
  validateUserApiKey,
} from '../../services/user-keys.js';
import {
  createUser,
  verifyCredentials,
  createSession,
  validateSession,
} from '../../services/auth.js';
import { resolveAuth } from '../../lib/system-prompt.js';

async function call(app: Express, method: string, path: string, body?: any, token?: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Custom Multi-User & Invite System', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  it('assigns role "admin" to first user, and "member" to subsequent users', () => {
    const admin = createUser('admin@example.com', 'AdminPass123!');
    expect(admin.role).toBe('admin');

    const member = createUser('member@example.com', 'MemberPass123!', 'member');
    expect(member.role).toBe('member');

    const verifiedAdmin = verifyCredentials('admin@example.com', 'AdminPass123!');
    expect(verifiedAdmin?.role).toBe('admin');

    const verifiedMember = verifyCredentials('member@example.com', 'MemberPass123!');
    expect(verifiedMember?.role).toBe('member');

    const session = createSession(member.userId);
    const valid = validateSession(session);
    expect(valid?.role).toBe('member');
  });

  it('handles invite codes lifecycle (create, validate, claim, revoke)', () => {
    const admin = verifyCredentials('admin@example.com', 'AdminPass123!')!;
    const invite = createInviteCode(admin.userId, {
      code: 'TEST-INV-1',
      maxUses: 2,
      note: 'Test invite for 2 uses',
    });

    expect(invite.code).toBe('TEST-INV-1');
    expect(invite.maxUses).toBe(2);

    // Initial validation
    let validation = validateInviteCode('TEST-INV-1');
    expect(validation.valid).toBe(true);

    // First claim
    expect(claimInviteCode('TEST-INV-1')).toBe(true);
    validation = validateInviteCode('TEST-INV-1');
    expect(validation.valid).toBe(true);
    expect(validation.usedCount).toBe(1);

    // Second claim (exhausted)
    expect(claimInviteCode('TEST-INV-1')).toBe(true);
    validation = validateInviteCode('TEST-INV-1');
    expect(validation.valid).toBe(false);
    expect(validation.reason).toBe('exhausted');

    // Claim when exhausted fails
    expect(claimInviteCode('TEST-INV-1')).toBe(false);

    // Test revocation
    const invite2 = createInviteCode(admin.userId, { code: 'REVOKE-ME' });
    expect(revokeInviteCode(invite2.id)).toBe(true);
    const validation2 = validateInviteCode('REVOKE-ME');
    expect(validation2.valid).toBe(false);
    expect(validation2.reason).toBe('revoked');
  });

  it('mints, lists, validates and revokes personal user API keys', () => {
    const user = createUser('coder@example.com', 'Secret12345!', 'member');

    // Mint key
    const minted = mintUserApiKey(user.userId, 'Cursor Key');
    expect(minted.key).toMatch(/^sk-flm-/);
    expect(minted.name).toBe('Cursor Key');

    // List keys
    const list = listUserApiKeys(user.userId);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Cursor Key');
    expect(list[0].revoked).toBe(false);

    // Validate key
    const validated = validateUserApiKey(minted.key);
    expect(validated).not.toBeNull();
    expect(validated?.userId).toBe(user.userId);
    expect(validated?.email).toBe('coder@example.com');
    expect(validated?.role).toBe('member');

    // Inference resolveAuth recognizes the key
    const resolved = resolveAuth(minted.key);
    expect(resolved).toEqual({
      kind: 'user',
      userId: user.userId,
      email: 'coder@example.com',
      systemPrompt: null,
    });

    // Revoke key
    expect(revokeUserApiKey(user.userId, minted.id)).toBe(true);
    const validatedAfter = validateUserApiKey(minted.key);
    expect(validatedAfter).toBeNull();
    expect(resolveAuth(minted.key)).toBeNull();
  });

  it('supports invite-based registration and enforces RBAC on admin endpoints', async () => {
    const admin = verifyCredentials('admin@example.com', 'AdminPass123!')!;
    const adminSession = createSession(admin.userId);

    // 1. Admin generates an invite code
    const invite = createInviteCode(admin.userId, { code: 'JOIN-US-2026', maxUses: 1 });
    expect(invite.code).toBe('JOIN-US-2026');

    // 2. Guest registers with invalid invite code -> 400
    const failReg = await call(app, 'POST', '/api/auth/register', {
      email: 'newbie@example.com',
      password: 'password123',
      inviteCode: 'WRONG-CODE',
    });
    expect(failReg.status).toBe(400);

    // 3. Guest registers with valid invite code -> 201
    const successReg = await call(app, 'POST', '/api/auth/register', {
      email: 'newbie@example.com',
      password: 'password123',
      inviteCode: 'JOIN-US-2026',
    });
    expect(successReg.status).toBe(201);
    expect(successReg.body.role).toBe('member');
    expect(successReg.body.apiKey).toMatch(/^sk-flm-/);
    const memberSession = successReg.body.token;

    // 4. Member cannot access Admin-only endpoints -> 403 Forbidden
    const keysAttempt = await call(app, 'GET', '/api/keys', undefined, memberSession);
    expect(keysAttempt.status).toBe(403);
    expect(keysAttempt.body.error.type).toBe('forbidden');

    const settingsAttempt = await call(app, 'GET', '/api/settings', undefined, memberSession);
    expect(settingsAttempt.status).toBe(403);

    const invitesAttempt = await call(app, 'GET', '/api/invites', undefined, memberSession);
    expect(invitesAttempt.status).toBe(403);

    // 5. Admin can access Admin endpoints -> 200 OK
    const adminInvites = await call(app, 'GET', '/api/invites', undefined, adminSession);
    expect(adminInvites.status).toBe(200);

    // 6. Member can access their own personal keys -> 200 OK
    const memberKeys = await call(app, 'GET', '/api/user/keys', undefined, memberSession);
    expect(memberKeys.status).toBe(200);
    expect(memberKeys.body.keys).toHaveLength(1);
  });
});
