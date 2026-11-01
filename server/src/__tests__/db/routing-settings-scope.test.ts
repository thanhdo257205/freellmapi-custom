import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../db/types.js';
import { wrapTursoDatabase } from '../../db/turso.js';
import { readRoutingSetting, withRoutingSettingsScope } from '../../db/routing-settings-scope.js';
import { getDb, initDb } from '../../db/index.js';
import { getRoutingScores } from '../../services/router.js';

const connections: Db[] = [];
afterEach(() => { for (const db of connections.splice(0)) db.close?.(); });

function fixture(remote = true) {
  const raw = new Database(':memory:');
  raw.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); INSERT INTO settings VALUES ('routing_strategy', 'speed'), ('routing_explore_enabled', '1'), ('unified_api_key', 'secret')");
  const db = wrapTursoDatabase(raw as unknown as Db, remote);
  connections.push(db);
  const prepare = vi.spyOn(db, 'prepare');
  const read = (key: string) => readRoutingSetting(db, key, () => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  });
  return { db, prepare, read };
}

describe('Turso routing configuration round trips', () => {
  it('reduces real routing-scorer settings reads without changing dashboard scores', () => {
    vi.stubEnv('ENCRYPTION_KEY', 'a'.repeat(64));
    try {
      initDb(':memory:', { factory: () => wrapTursoDatabase(new Database(':memory:') as unknown as Db) });
      const db = getDb();
      connections.push(db);
      getRoutingScores(); // Warm the existing stats and quota caches equally.
      const prepare = vi.spyOn(db, 'prepare');
      const baseline = getRoutingScores();
      const settingsReads = () => prepare.mock.calls.filter(([sql]) => /FROM settings/i.test(sql)).length;
      const before = settingsReads();
      prepare.mockClear();
      const optimized = withRoutingSettingsScope(() => getRoutingScores());
      expect(optimized).toEqual(baseline);
      expect(before).toBeGreaterThanOrEqual(10);
      expect(settingsReads()).toBeLessThanOrEqual(2); // active profile is intentionally separate.
    } finally { vi.unstubAllEnvs(); }
  });

  it('reuses bounded SELECT handles while reading fresh rows and bindings', () => {
    const raw = new Database(':memory:');
    raw.exec('CREATE TABLE items (id INTEGER, value TEXT); INSERT INTO items VALUES (1, \'one\'), (2, \'two\')');
    const nativePrepare = vi.spyOn(raw, 'prepare');
    const db = wrapTursoDatabase(raw as unknown as Db);
    connections.push(db);
    const sql = 'SELECT value FROM items WHERE id = ?';
    expect(db.prepare(sql).get(1)).toEqual({ value: 'one' });
    expect(db.prepare(sql).get(2)).toEqual({ value: 'two' });
    expect(nativePrepare).toHaveBeenCalledTimes(1);
    db.prepare('UPDATE items SET value = ? WHERE id = ?').run('updated', 1);
    expect(db.prepare(sql).get(1)).toEqual({ value: 'updated' });
    for (let i = 0; i < 129; i++) db.prepare(`SELECT ${i} AS n`).get();
    const before = nativePrepare.mock.calls.length;
    db.prepare(sql).get(1);
    expect(nativePrepare).toHaveBeenCalledTimes(before + 1);
    db.exec('ALTER TABLE items ADD COLUMN extra TEXT');
    db.prepare(sql).get(1);
    expect(nativePrepare).toHaveBeenCalledTimes(before + 2);
  });

  it('batches distinct and missing settings without fetching credential values', () => {
    const { prepare, read } = fixture();
    withRoutingSettingsScope(() => {
      expect(read('routing_strategy')).toBe('speed');
      expect(read('routing_explore_enabled')).toBe('1');
      expect(read('routing_peak_timezone')).toBeUndefined();
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(read('unified_api_key')).toBe('secret');
      expect(prepare).toHaveBeenCalledTimes(2);
    });
  });

  it('observes direct writes and transaction rollbacks in the same request', () => {
    const { db, read } = fixture();
    withRoutingSettingsScope(() => {
      expect(read('routing_strategy')).toBe('speed');
      expect(() => db.transaction(() => {
        db.prepare("UPDATE settings SET value='manual' WHERE key='routing_strategy'").run();
        expect(read('routing_strategy')).toBe('manual');
        throw new Error('rollback');
      })()).toThrow('rollback');
      expect(read('routing_strategy')).toBe('speed');
      db.exec("UPDATE settings SET value='balanced' WHERE key='routing_strategy'");
      expect(read('routing_strategy')).toBe('balanced');
      db.prepare("UPDATE settings SET value='manual' WHERE key='routing_strategy' RETURNING value").get();
      expect(read('routing_strategy')).toBe('manual');
    });
  });

  it('does not share a snapshot across requests or asynchronous continuations', async () => {
    const { prepare, read } = fixture();
    await withRoutingSettingsScope(async () => {
      read('routing_strategy');
      read('routing_explore_enabled');
      expect(prepare).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      read('routing_strategy');
      read('routing_explore_enabled');
      expect(prepare).toHaveBeenCalledTimes(3);
    });
    withRoutingSettingsScope(() => read('routing_strategy'));
    expect(prepare).toHaveBeenCalledTimes(4);
  });

  it('preserves local SQLite and background callers without a request scope', () => {
    const local = fixture(false);
    withRoutingSettingsScope(() => {
      local.read('routing_strategy');
      local.read('routing_explore_enabled');
    });
    expect(local.prepare).toHaveBeenCalledTimes(2);
    const remote = fixture();
    remote.read('routing_strategy');
    remote.read('routing_explore_enabled');
    expect(remote.prepare).toHaveBeenCalledTimes(2);
  });
});
