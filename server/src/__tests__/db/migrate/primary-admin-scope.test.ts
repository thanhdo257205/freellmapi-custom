import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../db/migrate/runner.js';
import { up, down } from '../../../db/migrations/20261101_190500_custom_primary_admin_scope.js';

// custom_granular_rbac backfilled is_primary from the lowest user id with no
// role filter, which hands a member the wildcard grant plus immunity from
// demotion. This migration repairs that state; the tests below seed the exact
// damage rather than reproducing it through the old migration.

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

async function migratedDb(): Promise<Database.Database> {
  const db = new Database(':memory:');
  dbs.push(db);
  await runMigrations(db, 'up');
  return db;
}

interface FlagRow {
  id: number;
  role: string;
  is_primary: number;
  permissions: string;
}

function flags(db: Database.Database): FlagRow[] {
  return db.prepare('SELECT id, role, is_primary, permissions FROM users ORDER BY id').all() as FlagRow[];
}

function byId(db: Database.Database, id: number): FlagRow {
  return db.prepare('SELECT id, role, is_primary, permissions FROM users WHERE id = ?').get(id) as FlagRow;
}

function insertUser(db: Database.Database, email: string, role: string, isPrimary: number, permissions: string): number {
  return Number(db.prepare(`
    INSERT INTO users (email, password_hash, role, is_primary, permissions) VALUES (?, 'x', ?, ?, ?)
  `).run(email, role, isPrimary, permissions).lastInsertRowid);
}

describe('custom_primary_admin_scope migration', () => {
  it('demotes a member the backfill made primary and hands the flag to the first administrator', async () => {
    const db = await migratedDb();
    // The state an invite-registered install lands in: the member created first,
    // the administrator claimed afterwards.
    const member = insertUser(db, 'first@example.com', 'member', 1, '["*"]');
    const admin = insertUser(db, 'owner@example.com', 'admin', 0, '["*"]');

    up(db);

    expect(byId(db, member)).toMatchObject({ is_primary: 0, permissions: '[]' });
    expect(byId(db, admin)).toMatchObject({ role: 'admin', is_primary: 1 });
  });

  it('keeps exactly one primary when the flag was set on several administrators', async () => {
    const db = await migratedDb();
    const first = insertUser(db, 'a@example.com', 'admin', 1, '["*"]');
    const second = insertUser(db, 'b@example.com', 'admin', 1, '["*"]');

    up(db);

    expect(byId(db, first).is_primary).toBe(1);
    expect(byId(db, second).is_primary).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_primary = 1').get()).toEqual({ n: 1 });
  });

  it('leaves a wildcard an operator granted on purpose alone', async () => {
    const db = await migratedDb();
    const admin = insertUser(db, 'owner@example.com', 'admin', 1, '["*"]');
    // Not backfill damage: a member flagged primary is the only state where '*'
    // is known to have come from the bug, so this grant is the operator's.
    const wildcardMember = insertUser(db, 'delegate@example.com', 'member', 0, '["*"]');
    const granular = insertUser(db, 'keys@example.com', 'member', 0, '["manage_keys"]');

    up(db);

    expect(byId(db, admin).is_primary).toBe(1);
    expect(byId(db, wildcardMember)).toMatchObject({ is_primary: 0, permissions: '["*"]' });
    expect(byId(db, granular)).toMatchObject({ is_primary: 0, permissions: '["manage_keys"]' });
  });

  it('clears the flag when the install has no administrator at all', async () => {
    const db = await migratedDb();
    const member = insertUser(db, 'only@example.com', 'member', 1, '["*"]');

    up(db);

    // Nothing to promote, so the account loses the immunity instead of keeping
    // an unremovable administrator that no repair can hand control back to.
    expect(byId(db, member)).toMatchObject({ role: 'member', is_primary: 0, permissions: '[]' });
  });

  it('is idempotent', async () => {
    const db = await migratedDb();
    const member = insertUser(db, 'first@example.com', 'member', 1, '["*"]');
    const admin = insertUser(db, 'owner@example.com', 'admin', 0, '["*"]');

    up(db);
    const afterFirst = flags(db);
    up(db);

    expect(flags(db)).toEqual(afterFirst);
    expect(byId(db, member).is_primary).toBe(0);
    expect(byId(db, admin).is_primary).toBe(1);
  });

  it('DOWN restores the state it found', async () => {
    const db = await migratedDb();
    const member = insertUser(db, 'first@example.com', 'member', 1, '["*"]');
    const admin = insertUser(db, 'owner@example.com', 'admin', 0, '[]');
    const before = { member: byId(db, member), admin: byId(db, admin) };

    up(db);
    expect(byId(db, member).is_primary).toBe(0);

    down(db);
    expect(byId(db, member)).toEqual(before.member);
    expect(byId(db, admin)).toEqual(before.admin);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'migration_primary_admin_scoped_rows'").get()).toBeUndefined();
  });
});
