import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { initEncryptionKey } from '../../lib/crypto.js';
import {
  getUsableKeysForPlatform,
  countUsableKeysByPlatform,
  getAllUsableKeys,
  invalidateKeyCache,
  setKeyCacheTestOverride,
} from '../../services/key-cache.js';

describe('In-Memory Key Registry & Cache', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const db = initDb(':memory:');
    initEncryptionKey(db);
    invalidateKeyCache();
    setKeyCacheTestOverride(true); // Explicitly enable memory caching for this test suite
  });

  afterEach(() => {
    setKeyCacheTestOverride(null);
    invalidateKeyCache();
  });

  it('loads usable keys into memory on first call and serves subsequent calls with zero DB queries', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('google', 'key-1', 'enc1', 'iv1', 'tag1', 'healthy', 1),
             ('google', 'key-2', 'enc2', 'iv2', 'tag2', 'healthy', 1),
             ('zhipu',  'key-3', 'enc3', 'iv3', 'tag3', 'unknown', 1),
             ('disabled_p', 'key-4', 'enc4', 'iv4', 'tag4', 'healthy', 0),
             ('error_p', 'key-5', 'enc5', 'iv5', 'tag5', 'error', 1)
    `).run();

    // Track prepare calls on db
    let queryCount = 0;
    const origPrepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('FROM api_keys')) {
        queryCount++;
      }
      return origPrepare(sql);
    });

    // 1st call: Should hit DB once to populate RAM
    const googleKeys1 = getUsableKeysForPlatform('google', db);
    expect(googleKeys1).toHaveLength(2);
    expect(queryCount).toBe(1);

    // 2nd call: Different platform, should serve directly from RAM without DB query
    const zhipuKeys = getUsableKeysForPlatform('zhipu', db);
    expect(zhipuKeys).toHaveLength(1);
    expect(queryCount).toBe(1); // STILL 1! 0 DB queries!

    // 3rd call: Key counts, should serve directly from RAM
    const counts = countUsableKeysByPlatform(db);
    expect(counts.get('google')).toBe(2);
    expect(counts.get('zhipu')).toBe(1);
    expect(counts.get('disabled_p')).toBeUndefined();
    expect(queryCount).toBe(1); // STILL 1! 0 DB queries!

    // 4th call: All usable keys
    const all = getAllUsableKeys(db);
    expect(all).toHaveLength(3);
    expect(queryCount).toBe(1); // STILL 1! 0 DB queries!
  });

  it('invalidates cache when invalidateKeyCache is called and reloads on next read', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'key-1', 'enc1', 'iv1', 'tag1', 'healthy', 1)
    `).run();

    expect(getUsableKeysForPlatform('groq', db)).toHaveLength(1);

    // Insert a new key directly
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'key-2', 'enc2', 'iv2', 'tag2', 'healthy', 1)
    `).run();

    // Still returns cached value (1) before invalidation
    expect(getUsableKeysForPlatform('groq', db)).toHaveLength(1);

    // Invalidate
    invalidateKeyCache();

    // Now reloads from DB (2)
    expect(getUsableKeysForPlatform('groq', db)).toHaveLength(2);
  });
});
