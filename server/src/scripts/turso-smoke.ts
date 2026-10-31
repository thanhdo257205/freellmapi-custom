import '../env.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { connectDb, initDb, setSetting, getSetting } from '../db/index.js';
import { tursoEnabled } from '../db/turso.js';
import { createUser, createSession, validateSession, verifyCredentials } from '../services/auth.js';
import { createInviteCode, validateInviteCode } from '../services/invites.js';
import { mintUserApiKey, validateUserApiKey } from '../services/user-keys.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { installLogRedaction } from '../lib/log-redaction.js';

installLogRedaction();

if (!tursoEnabled() || !process.argv.includes('--disposable')) {
  throw new Error('Set Turso env variables and pass --disposable for a dedicated trial database only.');
}

let db = connectDb();
let open = true;
let initialized = false;
let userId: number | undefined;
const suffix = crypto.randomUUID();
const setting = `turso_smoke_${suffix}`;
try {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (table) {
    const count = db.prepare('SELECT count(*) AS n FROM users').get() as { n: number };
    assert.equal(count.n, 0, 'Refusing a database with existing users; use a dedicated empty trial.');
  }
  db.close?.();
  open = false;
  const startup = performance.now();
  db = initDb();
  open = true;
  initialized = true;
  console.log(`[turso-smoke] initialization: ${Math.round(performance.now() - startup)} ms`);

  const password = crypto.randomBytes(24).toString('hex');
  const email = `trial-${suffix}@example.com`;
  const user = createUser(email, password, 'admin');
  userId = user.userId;
  const session = createSession(user.userId);
  const key = mintUserApiKey(user.userId, 'Disposable smoke key');
  const invite = createInviteCode(user.userId, { note: 'Disposable smoke invite' });
  setSetting(setting, 'persisted');
  const secret = encrypt('test-provider-secret');
  assert.equal(decrypt(secret.encrypted, secret.iv, secret.authTag), 'test-provider-secret');

  assert.throws(db.transaction(() => {
    setSetting(`${setting}_rollback`, 'must-not-persist');
    throw new Error('intentional rollback');
  }), /intentional rollback/);
  db.close?.();
  open = false;
  db = initDb();
  open = true;
  assert.equal(getSetting(setting), 'persisted');
  assert.equal(getSetting(`${setting}_rollback`), undefined);
  assert.equal(verifyCredentials(email, password)?.userId, user.userId);
  assert.equal(validateSession(session)?.userId, user.userId);
  assert.equal(validateUserApiKey(key.key)?.userId, user.userId);
  assert.equal(validateInviteCode(invite.code).valid, true);
  assert.deepEqual(db.pragma('foreign_key_check'), []);

  const durations: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    db.prepare('SELECT 1 AS ok').get();
    durations.push(Math.round(performance.now() - start));
  }
  console.log(`[turso-smoke] query round trips: ${durations.join(', ')} ms`);
  console.log('[turso-smoke] PASS: migrations, rollback, encrypted secret roundtrip, account/session/invite/API-key persistence after reconnect');
} finally {
  if (open) {
    try {
      if (userId !== undefined) db.prepare('DELETE FROM users WHERE id = ?').run(userId);
      if (initialized) db.prepare('DELETE FROM settings WHERE key IN (?, ?)').run(setting, `${setting}_rollback`);
    } finally { db.close?.(); }
  }
}
