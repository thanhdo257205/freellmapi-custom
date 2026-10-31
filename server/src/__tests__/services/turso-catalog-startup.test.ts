import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb, setSetting } from '../../db/index.js';
import { startCatalogSync, stopCatalogSync } from '../../services/catalog-sync.js';
import type { Scheduler } from '../../lib/scheduler.js';

describe('catalog startup on persistent remote storage', () => {
  beforeEach(() => {
    vi.stubEnv('CATALOG_SYNC_DISABLED', '');
    vi.stubEnv('ENCRYPTION_KEY', 'a'.repeat(64));
    initDb(':memory:');
    setSetting('catalog_applied_json', JSON.stringify({
      version: '2099.01.01', generatedAt: new Date().toISOString(), tier: 'live', quirks: [],
      models: [{
        platform: 'groq', modelId: 'cached-startup-model', displayName: 'Cached startup model',
        intelligenceRank: 10, speedRank: 5, sizeLabel: 'Medium',
        limits: { rpm: 30, rpd: 1000, tpm: 6000, tpd: null },
        monthlyTokenBudget: '~1M', contextWindow: 8192,
        enabled: true, supportsVision: false, supportsTools: true,
      }],
    }));
  });

  afterEach(() => {
    stopCatalogSync();
    getDb().close?.();
    vi.unstubAllEnvs();
  });

  function scheduler(): Scheduler {
    return { after: vi.fn(() => vi.fn()), every: vi.fn(() => vi.fn()) };
  }

  it('keeps local startup replay enabled by default', () => {
    startCatalogSync(scheduler());
    expect(getDb().prepare("SELECT display_name FROM models WHERE model_id='cached-startup-model'").get())
      .toEqual({ display_name: 'Cached startup model' });
  });

  it('preserves durable rows without replay and still schedules future syncs', () => {
    const timer = scheduler();
    const before = getDb().prepare('SELECT count(*) AS n FROM models').get();
    startCatalogSync(timer, { reapplyCached: false });
    expect(getDb().prepare('SELECT count(*) AS n FROM models').get()).toEqual(before);
    expect(getDb().prepare("SELECT id FROM models WHERE model_id='cached-startup-model'").get()).toBeUndefined();
    expect(timer.after).toHaveBeenCalledOnce();
    expect(timer.every).toHaveBeenCalledOnce();
  });
});
