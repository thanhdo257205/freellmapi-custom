import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { createUser, createSession, validateSession, verifyCredentials, updatePassword } from '../../services/auth.js';
import { createInviteCode } from '../../services/invites.js';
import { issueEmailReset, completeEmailReset, requestEmailReset } from '../../services/email-recovery.js';
import { finishGoogleLogin, consumeGoogleHandoff } from '../../services/google-auth.js';
import { sendPasswordResetEmail } from '../../services/gmail-mailer.js';
import { getExternalAuthConfig } from '../../services/external-auth-config.js';

vi.mock('../../services/gmail-mailer.js', () => ({ sendPasswordResetEmail: vi.fn(async () => {}) }));

beforeEach(() => {
  vi.stubEnv('ENCRYPTION_KEY', '0'.repeat(64));
  vi.stubEnv('PUBLIC_APP_URL', 'https://app.example.com');
  vi.stubEnv('GOOGLE_CLIENT_ID', 'login-client');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'login-secret');
  vi.stubEnv('GMAIL_CLIENT_ID', 'mailer-client');
  vi.stubEnv('GMAIL_CLIENT_SECRET', 'mailer-secret');
  vi.stubEnv('GMAIL_REFRESH_TOKEN', 'mailer-refresh');
  vi.stubEnv('GMAIL_SENDER', 'sender@gmail.com');
  initDb(':memory:');
  vi.mocked(sendPasswordResetEmail).mockClear();
});
afterEach(() => { getDb().close?.(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const identity = (email: string, subject = 'google-subject') => ({ email, subject, authoritative: true });

describe('account-specific email recovery', () => {
  it('changes only the owner, invalidates their sessions and rejects reuse', () => {
    const admin = createUser('admin@gmail.com', 'AdminPass123!');
    const member = createUser('member@gmail.com', 'MemberPass123!', 'member');
    const adminSession = createSession(admin.userId);
    const memberSession = createSession(member.userId);
    const token = issueEmailReset(member.email)!;
    expect(completeEmailReset(token, 'NewMemberPass123!')).toBe(true);
    expect(verifyCredentials(member.email, 'NewMemberPass123!')?.userId).toBe(member.userId);
    expect(verifyCredentials(admin.email, 'AdminPass123!')?.role).toBe('admin');
    expect(validateSession(adminSession)?.userId).toBe(admin.userId);
    expect(validateSession(memberSession)).toBeNull();
    expect(completeEmailReset(token, 'DifferentPassword!')).toBe(false);
    expect(JSON.stringify(getDb().prepare('SELECT * FROM auth_email_resets').all())).not.toContain(token);
  });
  it('rejects expired, superseded and account-changed links', () => {
    const user = createUser('owner@gmail.com', 'OriginalPassword!');
    const first = issueEmailReset(user.email)!;
    const second = issueEmailReset(user.email)!;
    expect(completeEmailReset(first, 'NewPassword123!')).toBe(false);
    getDb().prepare('UPDATE auth_email_resets SET expires_at_ms = 1').run();
    expect(completeEmailReset(second, 'NewPassword123!')).toBe(false);
    const third = issueEmailReset(user.email)!;
    updatePassword(user.userId, 'OriginalPassword!', 'ChangedPassword!');
    expect(completeEmailReset(third, 'NewPassword123!')).toBe(false);
  });
  it('sends a fragment-only link, never mails unknown accounts, and cleans up delivery failures', async () => {
    const user = createUser('owner@gmail.com', 'OriginalPassword!');
    await requestEmailReset('missing@gmail.com');
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    await requestEmailReset(user.email);
    expect(sendPasswordResetEmail).toHaveBeenCalledWith(user.email, expect.stringMatching(/^https:\/\/app.example.com\/#reset_token=/));
    vi.mocked(sendPasswordResetEmail).mockRejectedValueOnce(new Error('delivery failed'));
    await expect(requestEmailReset(user.email)).rejects.toThrow('delivery failed');
    expect(getDb().prepare('SELECT * FROM auth_email_resets').all()).toHaveLength(0);
  });
});

describe('Google identity and invite isolation', () => {
  it('links an authoritative existing admin without changing role and consumes handoff once', () => {
    const user = createUser('admin@gmail.com', 'AdminPassword!');
    const ticket = finishGoogleLogin(identity(user.email));
    const result = consumeGoogleHandoff(ticket)!;
    expect(result.role).toBe('admin');
    expect(validateSession(result.token)?.userId).toBe(user.userId);
    expect(result.apiKey).toBeUndefined();
    expect(consumeGoogleHandoff(ticket)).toBeNull();
  });
  it('requires an invite for new identities and creates only member accounts', () => {
    const admin = createUser('admin@gmail.com', 'AdminPassword!');
    expect(() => finishGoogleLogin(identity('new@gmail.com'))).toThrow();
    const invite = createInviteCode(admin.userId, { maxUses: 1 });
    const ticket = finishGoogleLogin(identity('new@gmail.com'), invite.code);
    const result = consumeGoogleHandoff(ticket)!;
    expect(result.role).toBe('member');
    expect(result.apiKey).toMatch(/^sk-flm-/);
    expect(getDb().prepare('SELECT used_count FROM invite_codes WHERE id = ?').get(invite.id)).toEqual({ used_count: 1 });
    expect(() => finishGoogleLogin(identity('other@gmail.com', 'other-sub'), invite.code)).toThrow();
  });
  it('never links a non-authoritative email or replaces another Google subject', () => {
    const user = createUser('owner@external.example', 'OwnerPassword!');
    expect(() => finishGoogleLogin({ ...identity(user.email), authoritative: false })).toThrow();
    consumeGoogleHandoff(finishGoogleLogin(identity(user.email)));
    expect(() => finishGoogleLogin(identity(user.email, 'different-subject'))).toThrow();
    const saved = JSON.stringify(getDb().prepare('SELECT * FROM auth_google_handoffs').all());
    expect(saved).not.toContain('token');
  });
  it('keeps integrations off for missing or unsafe configuration', () => {
    expect(getExternalAuthConfig().google).not.toBeNull();
    vi.stubEnv('PUBLIC_APP_URL', 'http://evil.example');
    expect(getExternalAuthConfig().google).toBeNull();
    expect(getExternalAuthConfig().gmail).toBeNull();
  });
});
