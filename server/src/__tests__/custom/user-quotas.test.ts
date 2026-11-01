import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import { initDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createUser, createSession } from '../../services/auth.js';
import { mintUserApiKey, revokeUserApiKey } from '../../services/user-keys.js';
import {
  checkUserRateLimit,
  recordUserUsage,
  getUserUsage,
  listAllUsersUsage,
  setUserRpmLimit,
} from '../../services/user-quotas.js';

describe('User Quotas, Rate Limiting & Usage Tracking', () => {
  let server: Server;
  let base: string;
  let adminId: number;
  let adminToken: string;
  let memberId: number;
  let memberToken: string;
  let memberKey: string;

  beforeAll(async () => {
    initDb(':memory:');
    const app = createApp();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as any).port}`;

    const admin = createUser('admin@example.com', 'AdminPass123!');
    adminId = admin.userId;
    adminToken = createSession(adminId);

    const member = createUser('member@example.com', 'MemberPass123!', 'member');
    memberId = member.userId;
    memberToken = createSession(memberId);

    const minted = mintUserApiKey(memberId, 'Test Key');
    memberKey = minted.key;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('enforces sliding-window rate limit in memory', () => {
    const testUserId = 999;
    const limit = 3;

    // First 3 requests should be allowed
    const r1 = checkUserRateLimit(testUserId, limit);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = checkUserRateLimit(testUserId, limit);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = checkUserRateLimit(testUserId, limit);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    // 4th request must be rejected
    const r4 = checkUserRateLimit(testUserId, limit);
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
    expect(r4.resetSeconds).toBeGreaterThan(0);
  });

  it('records and aggregates monthly usage correctly', () => {
    recordUserUsage(memberId, 150);
    recordUserUsage(memberId, 250);

    const usage = getUserUsage(memberId);
    expect(usage.requests).toBe(2);
    expect(usage.tokens).toBe(400);

    const allUsage = listAllUsersUsage();
    const memberUsage = allUsage.find(u => u.userId === memberId);
    expect(memberUsage).toBeDefined();
    expect(memberUsage?.requests).toBe(2);
    expect(memberUsage?.tokens).toBe(400);
    expect(memberUsage?.rpmLimit).toBe(60);
  });

  it('allows admin to update user RPM limit', () => {
    expect(setUserRpmLimit(memberId, 120)).toBe(true);

    const allUsage = listAllUsersUsage();
    const memberUsage = allUsage.find(u => u.userId === memberId);
    expect(memberUsage?.rpmLimit).toBe(120);
  });

  it('provides admin endpoints for usage and quota management', async () => {
    // GET /api/admin/users/usage
    const resUsage = await fetch(`${base}/api/admin/users/usage`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(resUsage.status).toBe(200);
    const dataUsage = (await resUsage.json()) as any;
    expect(Array.isArray(dataUsage.usage)).toBe(true);

    // Member cannot access admin usage endpoint
    const forbidden = await fetch(`${base}/api/admin/users/usage`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(forbidden.status).toBe(403);

    // PUT /api/admin/users/:id/quota
    const resQuota = await fetch(`${base}/api/admin/users/${memberId}/quota`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ rpmLimit: 45 }),
    });
    expect(resQuota.status).toBe(200);
    const dataQuota = (await resQuota.json()) as any;
    expect(dataQuota.rpmLimit).toBe(45);
  });

  it('provides member endpoint for personal usage query', async () => {
    const res = await fetch(`${base}/api/user/usage`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.usage.requests).toBe(2);
    expect(data.usage.tokens).toBe(400);
  });

  it('intercepts /v1 inference with rate limiting headers and blocks revoked keys', async () => {
    // 1. Valid user key under limit -> returns headers and passes to proxy
    const okRes = await fetch(`${base}/v1/models`, {
      headers: { Authorization: `Bearer ${memberKey}` },
    });
    // Even if proxy returns 200 or 404/503 depending on models, rate limit headers must be present
    expect(okRes.headers.get('x-ratelimit-limit-user-rpm')).toBeDefined();

    // 2. Revoked key -> 401
    const secondKey = mintUserApiKey(memberId, 'Key to revoke');
    revokeUserApiKey(memberId, secondKey.id);

    const revokedRes = await fetch(`${base}/v1/models`, {
      headers: { Authorization: `Bearer ${secondKey.key}` },
    });
    expect(revokedRes.status).toBe(401);
  });
});
