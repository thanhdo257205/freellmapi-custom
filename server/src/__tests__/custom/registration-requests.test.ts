import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import { initDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import {
  createUser,
  createSession,
  verifyCredentials,
} from '../../services/auth.js';
import {
  createRegistrationRequest,
  listRegistrationRequests,
  approveRegistrationRequest,
  rejectRegistrationRequest,
  isRegistrationPending,
} from '../../services/registration-requests.js';

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

describe('Registration Requests & Admin Approval Flow', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        base = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    // Seed admin and member
    const admin = createUser('admin@example.com', 'AdminPass123!', 'admin');
    adminId = admin.userId;
    adminToken = createSession(adminId);

    const member = createUser('member@example.com', 'MemberPass123!', 'member');
    memberId = member.userId;
    memberToken = createSession(memberId);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('creates a registration request via service and hashes password', () => {
    const req = createRegistrationRequest('student@example.com', 'StudentPass123!', 'Need for university AI course');
    expect(req.id).toBeGreaterThan(0);
    expect(req.email).toBe('student@example.com');
    expect(req.status).toBe('pending');

    // Pending check
    expect(isRegistrationPending('student@example.com', 'StudentPass123!')).toBe(true);
    expect(isRegistrationPending('student@example.com', 'WrongPass')).toBe(false);
  });

  it('submits a registration request via POST /api/auth/request-access', async () => {
    const res = await hit('/api/auth/request-access', 'POST', {
      email: 'newbie@example.com',
      password: 'NewbiePassword123!',
      note: 'Looking forward to using FreeLLMAPI',
    });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.email).toBe('newbie@example.com');
  });

  it('blocks pending users on POST /api/auth/login with 403 registration_pending', async () => {
    const res = await hit('/api/auth/login', 'POST', {
      email: 'newbie@example.com',
      password: 'NewbiePassword123!',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.type).toBe('registration_pending');
  });

  it('rejects duplicate pending requests with 409', async () => {
    const res = await hit('/api/auth/request-access', 'POST', {
      email: 'newbie@example.com',
      password: 'NewbiePassword123!',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.type).toBe('request_already_pending');
  });

  it('enforces admin-only access on /api/admin/registration-requests', async () => {
    // Unauthenticated
    const unauthed = await hit('/api/admin/registration-requests', 'GET');
    expect(unauthed.status).toBe(401);

    // Member session
    const memberRes = await hit('/api/admin/registration-requests', 'GET', undefined, memberToken);
    expect(memberRes.status).toBe(403);

    // Admin session
    const adminRes = await hit('/api/admin/registration-requests', 'GET', undefined, adminToken);
    expect(adminRes.status).toBe(200);
    expect(Array.isArray(adminRes.body.requests)).toBe(true);
    expect(adminRes.body.requests.some((r: any) => r.email === 'newbie@example.com')).toBe(true);
  });

  it('allows admin to approve a pending request and creates a usable member account', async () => {
    const pending = listRegistrationRequests('pending');
    const target = pending.find(r => r.email === 'newbie@example.com')!;
    expect(target).toBeDefined();

    const approveRes = await hit(`/api/admin/registration-requests/${target.id}/approve`, 'POST', undefined, adminToken);
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.success).toBe(true);
    expect(approveRes.body.user.email).toBe('newbie@example.com');
    expect(approveRes.body.user.role).toBe('member');

    // The approved user can now successfully log in
    const loginRes = await hit('/api/auth/login', 'POST', {
      email: 'newbie@example.com',
      password: 'NewbiePassword123!',
    });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.token).toBeDefined();
    expect(loginRes.body.email).toBe('newbie@example.com');
  });

  it('allows admin to reject a pending request and lets user resubmit', async () => {
    const req = createRegistrationRequest('spammer@example.com', 'SpamPassword123!', 'free api pls');

    const rejectRes = await hit(`/api/admin/registration-requests/${req.id}/reject`, 'POST', undefined, adminToken);
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.success).toBe(true);

    // Cannot log in
    const loginRes = await hit('/api/auth/login', 'POST', {
      email: 'spammer@example.com',
      password: 'SpamPassword123!',
    });
    expect(loginRes.status).toBe(401);

    // Resubmission is allowed
    const resubmitRes = await hit('/api/auth/request-access', 'POST', {
      email: 'spammer@example.com',
      password: 'BetterPassword123!',
      note: 'I am actually a developer',
    });
    expect(resubmitRes.status).toBe(201);
  });
});
