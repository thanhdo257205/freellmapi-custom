import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken } from '../helpers/auth.js';

afterEach(() => { getDb().close?.(); vi.useRealTimers(); vi.unstubAllEnvs(); });

it('loads a large key roster with one monthly-usage join and preserves current-month totals', async () => {
  vi.stubEnv('ENCRYPTION_KEY', 'a'.repeat(64));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-01T00:00:01Z'));
  initDb(':memory:');
  const db = getDb();
  db.prepare('DELETE FROM api_keys').run();
  const token = mintDashboardToken();
  const key = encrypt('unused-test-provider-key');
  const ids: number[] = [];
  for (let i = 0; i < 60; i++) {
    const result = db.prepare(`INSERT INTO api_keys
      (platform, label, encrypted_key, iv, auth_tag, monthly_request_cap, monthly_token_cap)
      VALUES ('groq', ?, ?, ?, ?, ?, ?)`).run(`key-${i}`, key.encrypted, key.iv, key.authTag, i + 10, i + 1000);
    ids.push(Number(result.lastInsertRowid));
  }
  const usage = db.prepare('INSERT INTO key_monthly_usage (key_id, month, requests, tokens) VALUES (?, ?, ?, ?)');
  usage.run(ids[0], '2026-11', 3, 120);
  usage.run(ids[0], '2026-10', 99, 9999);
  usage.run(ids[1], '2026-10', 88, 8888);
  const prepare = vi.spyOn(db, 'prepare');
  const server = createApp().listen(0, '127.0.0.1');
  try {
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${address.port}/api/keys`, { headers: { Authorization: `Bearer ${token}` } });
    const rows = await res.json() as Array<{ id: number; monthlyRequestCap: number; monthlyTokenCap: number; monthlyUsage: { requests: number; tokens: number } }>;
    expect(res.status).toBe(200);
    expect(rows).toHaveLength(60);
    for (let i = 0; i < ids.length; i++) {
      const row = rows.find(row => row.id === ids[i])!;
      expect(row.monthlyRequestCap).toBe(i + 10);
      expect(row.monthlyTokenCap).toBe(i + 1000);
      expect(row.monthlyUsage).toMatchObject(i === 0 ? { requests: 3, tokens: 120 } : { requests: 0, tokens: 0 });
    }
    expect(prepare.mock.calls.filter(([sql]) => /key_monthly_usage/.test(sql))).toHaveLength(1);
    expect(prepare.mock.calls.some(([sql]) => /SELECT monthly_request_cap, monthly_token_cap/.test(sql))).toBe(false);
  } finally { server.close(); }
});
