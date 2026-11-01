import Database from 'better-sqlite3';
import { setImmediate as yieldToIo } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { wrapTursoDatabase } from '../../db/turso.js';
import type { Db } from '../../db/types.js';
import { checkAllKeys } from '../../services/health.js';
import { encrypt } from '../../lib/crypto.js';

afterEach(() => { getDb().close?.(); vi.unstubAllEnvs(); });

it('lets I/O run between remote key probes and limits the default pool to two', async () => {
  vi.stubEnv('ENCRYPTION_KEY', 'a'.repeat(64));
  vi.stubEnv('HEALTH_CHECK_CONCURRENCY', '');
  initDb(':memory:', { factory: () => wrapTursoDatabase(new Database(':memory:') as unknown as Db) });
  const db = getDb();
  db.prepare('DELETE FROM api_keys').run();
  const key = encrypt('unused-test-key');
  for (let i = 0; i < 6; i++) {
    db.prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, enabled, status)
      VALUES ('groq', ?, ?, ?, ?, 1, 'healthy')`).run(`test-${i}`, key.encrypted, key.iv, key.authTag);
  }
  let ioRan = false;
  const marker = yieldToIo().then(() => { ioRan = true; });
  let active = 0;
  let peak = 0;
  const result = await checkAllKeys({ force: true, check: async () => {
    expect(ioRan).toBe(true);
    peak = Math.max(peak, ++active);
    await yieldToIo();
    active--;
  } });
  await marker;
  expect(result.checkedKeyIds).toHaveLength(6);
  expect(peak).toBe(2);
});
