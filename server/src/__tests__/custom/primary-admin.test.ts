import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { createUser, createSession, validateSession } from '../../services/auth.js';

// `is_primary` is the strongest flag in the fork's RBAC: it implies every
// permission and protects the account from demotion, session revoke, and key
// revoke. It has to follow the role, not the row order — an install whose first
// account came from invite registration must not end up with a member nobody can
// remove.

function row(userId: number): { role: string; is_primary: number; permissions: string } {
  return getDb().prepare('SELECT role, is_primary, permissions FROM users WHERE id = ?').get(userId) as any;
}

describe('primary admin assignment', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM sessions').run();
    getDb().prepare('DELETE FROM users').run();
  });

  it('does not make a member created into an empty database the primary admin', () => {
    const member = createUser('guest@example.com', 'GuestPass123!', 'member');

    expect(member).toMatchObject({ role: 'member', isPrimary: false, permissions: [] });
    expect(row(member.userId)).toMatchObject({ role: 'member', is_primary: 0, permissions: '[]' });

    // The session the account authenticates with carries no administrative
    // access, which is what the route gates read.
    const session = validateSession(createSession(member.userId));
    expect(session).toMatchObject({ isPrimary: false, permissions: [] });
  });

  it('still makes the first unclaimed account an administrator when no role is asked for', () => {
    const owner = createUser('owner@example.com', 'OwnerPass123!');

    expect(owner).toMatchObject({ role: 'admin', isPrimary: true, permissions: ['*'] });
    expect(row(owner.userId)).toMatchObject({ role: 'admin', is_primary: 1, permissions: '["*"]' });
  });

  it('leaves the primary flag with the administrator once one exists', () => {
    const owner = createUser('owner@example.com', 'OwnerPass123!');
    const guest = createUser('guest@example.com', 'GuestPass123!', 'member');

    expect(guest.isPrimary).toBe(false);
    expect(row(guest.userId)).toMatchObject({ is_primary: 0, permissions: '[]' });
    expect(row(owner.userId).is_primary).toBe(1);

    const primaries = getDb().prepare('SELECT COUNT(*) AS n FROM users WHERE is_primary = 1').get() as { n: number };
    expect(primaries.n).toBe(1);
  });
});
