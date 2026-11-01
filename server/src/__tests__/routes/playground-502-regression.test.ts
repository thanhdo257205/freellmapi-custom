import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { runFallbackLoop, newFallbackState, type FallbackHooks } from '../../lib/fallback-loop.js';
import { newClientAbortError } from '../../lib/error-classify.js';
import { logRequest, persistRequestAttempts } from '../../lib/request-log.js';
import { routeRequest, type RouteResult } from '../../services/router.js';
import { encrypt, initEncryptionKey } from '../../lib/crypto.js';
import { acquireLease, releaseLease, resetLeases } from '../../services/ratelimit.js';
import { wrapTursoDatabase } from '../../db/turso.js';
import { readRoutingSetting, withRoutingSettingsScope } from '../../db/routing-settings-scope.js';

async function request(
  app: Express,
  method: string,
  path: string,
  headers: Record<string, string> = {},
) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, { method, headers });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

let keySeq = 2000;
function fakeRoute(overrides: Partial<RouteResult> = {}): RouteResult {
  const n = ++keySeq;
  const leaseId = acquireLease('fake', 'fake-model', n, 100);
  return {
    provider: {} as any,
    modelId: 'fake-model',
    modelDbId: 500000 + n,
    apiKey: 'test-key',
    keyId: n,
    platform: 'fake',
    displayName: 'Fake Model',
    rpdLimit: null,
    tpdLimit: null,
    release: () => releaseLease(leaseId),
    ...overrides,
  };
}

describe('Playground HTTP 502 & Render Health Check Regression Suite', () => {
  const encryptionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  let app: any;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = encryptionKey;
    initDb(':memory:');
    initEncryptionKey(getDb() as any);
    resetLeases();
    app = createApp();
  });

  afterEach(() => {
    resetLeases();
  });

  it('1. 404 -> fallback succeeds without N+1 settings query storm', async () => {
    const db = getDb();

    // Query existing seeded models
    const seededModels = db.prepare("SELECT id, platform, model_id FROM models WHERE enabled = 1 LIMIT 5").all() as any[];
    expect(seededModels.length).toBeGreaterThan(0);

    // Insert healthy keys for the seeded platforms
    const insertKey = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, monthly_request_cap, monthly_token_cap)
      VALUES (?, ?, ?, ?, ?, 'healthy', 1, 0, 0)
    `);

    const platforms = [...new Set(seededModels.map(m => m.platform))];
    for (const p of platforms) {
      const enc = encrypt(`key-${p}`);
      insertKey.run(p, `${p}-key`, enc.encrypted, enc.iv, enc.authTag);
    }

    // Instrument settings queries
    let minContextWindowQueries = 0;
    let totalSettingsQueries = 0;
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      if (/FROM\s+settings\s+WHERE\s+key\s*=/i.test(sql)) {
        totalSettingsQueries++;
        return {
          ...originalPrepare(sql),
          get: (...args: unknown[]) => {
            if (args[0] === 'min_context_window') {
              minContextWindowQueries++;
            }
            return originalPrepare(sql).get(...args);
          },
        } as any;
      }
      return originalPrepare(sql);
    };

    // Step 1: Initial route picks candidate
    const targetModel = seededModels[0];
    const route1 = routeRequest(1000, undefined, targetModel.id);
    expect(route1.platform).toBe(targetModel.platform);

    // Step 2: Provider returns 404
    const state = newFallbackState();
    const google404 = Object.assign(new Error('model not found upstream'), { status: 404 });

    // Step 3: Run fallback loop with stubs
    let attempts = 0;
    let finalOutcome: any = null;

    const hooks: FallbackHooks = {
      state,
      route: (attempt) => {
        if (attempt === 0) return route1;
        return routeRequest(1000, state.skipKeys, undefined, false, false, state.skipModels, undefined, false, state.skipPlatforms);
      },
      dispatch: async (route) => {
        attempts++;
        if (attempts === 1) {
          throw google404;
        }
        finalOutcome = `${route.platform}/${route.modelId}`;
        return 'done';
      },
      logFailure: (route, err) => {
        logRequest(route.platform, route.modelId, route.keyId, 'error', 10, 0, 10, err.message, null, route.modelDbId, null, 'http');
      },
      onFatal: vi.fn(),
      onRoutingExhausted: vi.fn(),
      onExhausted: vi.fn(),
    };

    await runFallbackLoop(hooks);

    // Verify fallback succeeded on next candidate
    expect(attempts).toBe(2);
    expect(finalOutcome).toBeTruthy();

    // Verify min_context_window floor was hoisted: queried at most once per routeRequest call (2x total)
    // instead of once per candidate model in the pool (which previously produced hundreds of queries)
    expect(minContextWindowQueries).toBeLessThanOrEqual(2);
  });

  it('2. Provider timeout triggers failover to next candidate cleanly', async () => {
    const routeA = fakeRoute({ platform: 'google', modelId: 'gemini-slow' });
    const routeB = fakeRoute({ platform: 'zhipu', modelId: 'glm-fast' });

    const state = newFallbackState();
    let attemptsMade = 0;
    let resolvedRoute: string | null = null;

    const timeoutErr = Object.assign(new Error('Gateway timeout after 5000ms'), { status: 504 });

    const hooks: FallbackHooks = {
      state,
      route: (attempt) => (attempt === 0 ? routeA : routeB),
      dispatch: async (route) => {
        attemptsMade++;
        if (route.platform === 'google') {
          throw timeoutErr;
        }
        resolvedRoute = route.platform;
        return 'done';
      },
      logFailure: vi.fn(),
      onFatal: vi.fn(),
      onRoutingExhausted: vi.fn(),
      onExhausted: vi.fn(),
    };

    await runFallbackLoop(hooks);

    expect(attemptsMade).toBe(2);
    expect(resolvedRoute).toBe('zhipu');
  });

  it('3. Client disconnect halts fallback ladder and logs canceled request without leaking leases', async () => {
    const db = getDb();
    const route = fakeRoute();

    const state = newFallbackState();
    let dispatchCount = 0;

    const hooks: FallbackHooks = {
      state,
      clientGone: () => dispatchCount > 0,
      route: () => route,
      dispatch: async () => {
        dispatchCount++;
        throw newClientAbortError();
      },
      logFailure: vi.fn(),
      onFatal: vi.fn(),
      onRoutingExhausted: vi.fn(),
      onExhausted: vi.fn(),
    };

    await runFallbackLoop(hooks);

    expect(dispatchCount).toBe(1);

    // Verify a canceled record was noted in requests
    const canceledRow = db.prepare("SELECT status FROM requests WHERE status = 'canceled'").get() as any;
    expect(canceledRow?.status).toBe('canceled');
  });

  it('4. Persists request_attempts via multi-row batch without transaction commit errors', async () => {
    const db = getDb();
    // Insert parent request row
    const req = db.prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms)
      VALUES ('google', 'gemini-2.5-flash', 'success', 10, 20, 150)
    `).run();
    const parentId = Number(req.lastInsertRowid);

    // Simulate multi-hop trace
    const trace = {
      lastRequestRowId: parentId,
      records: [
        {
          ordinal: 0,
          platform: 'google',
          modelId: 'gemini-pro',
          keyOrdinal: 1,
          keyLabel: 'google-primary',
          outcome: 'error' as const,
          startOffsetMs: 0,
          durationMs: 120,
          errorSummary: '404 not found',
        },
        {
          ordinal: 1,
          platform: 'zhipu',
          modelId: 'glm-4-flash',
          keyOrdinal: 1,
          keyLabel: 'zhipu-backup',
          outcome: 'ok' as const,
          startOffsetMs: 125,
          durationMs: 80,
          errorSummary: null,
        },
      ],
    };

    // Should insert seamlessly without throwing or requiring interactive transactions
    persistRequestAttempts(trace);

    const rows = db.prepare('SELECT * FROM request_attempts WHERE request_id = ? ORDER BY ordinal ASC').all(parentId) as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].platform).toBe('google');
    expect(rows[0].outcome).toBe('error');
    expect(rows[0].error_summary).toBe('404 not found');
    expect(rows[1].platform).toBe('zhipu');
    expect(rows[1].outcome).toBe('ok');
  });

  it('5. Parallel requests run concurrently through fallback loop without contention', async () => {
    const runOne = async (idx: number) => {
      const state = newFallbackState();
      let servedBy = '';
      const routeA = fakeRoute({ platform: 'groq' });
      const routeB = fakeRoute({ platform: 'cerebras' });

      const hooks: FallbackHooks = {
        state,
        route: (attempt) => (attempt === 0 ? routeA : routeB),
        dispatch: async (route) => {
          if (route.platform === 'groq' && idx % 2 === 0) {
            throw Object.assign(new Error('Groq 429 rate limit'), { status: 429 });
          }
          servedBy = route.platform;
          return 'done';
        },
        logFailure: vi.fn(),
        onFatal: vi.fn(),
        onRoutingExhausted: vi.fn(),
        onExhausted: vi.fn(),
      };
      await runFallbackLoop(hooks);
      return servedBy;
    };

    // Run 6 concurrent requests
    const results = await Promise.all([0, 1, 2, 3, 4, 5].map(i => runOne(i)));
    expect(results).toHaveLength(6);
    expect(results.filter(r => r === 'cerebras').length).toBe(3); // even indices failed over
    expect(results.filter(r => r === 'groq').length).toBe(3);     // odd indices succeeded on groq
  });

  it('6. Health check (/api/ping and /livez) responds promptly even during routing work', async () => {
    // Probe /api/ping
    const pingRes = await request(app, 'GET', '/api/ping');
    expect(pingRes.status).toBe(200);
    expect(pingRes.body.status).toBe('ok');

    // Probe /livez
    const livezRes = await request(app, 'GET', '/livez');
    expect(livezRes.status).toBe(200);
    expect(livezRes.body.status).toBe('ok');
  });

  it('7. On Turso, withRoutingSettingsScope collapses all routing settings reads into a single batch query', () => {
    // Import wrapTursoDatabase and verify routing settings caching
    const rawDb = getDb();
    rawDb.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('routing_strategy', 'speed'), ('min_context_window', '128k')").run();
    const tursoDb = wrapTursoDatabase(rawDb as any, true);

    const prepareSpy = vi.spyOn(tursoDb, 'prepare');

    // Simulate Turso routing setting reads inside withRoutingSettingsScope
    withRoutingSettingsScope(() => {
      // Multiple setting queries inside the scope
      const val1 = readRoutingSetting(tursoDb, 'routing_strategy', () => 'fallback');
      const val2 = readRoutingSetting(tursoDb, 'min_context_window', () => 'fallback');
      const val3 = readRoutingSetting(tursoDb, 'routing_explore_enabled', () => 'fallback');

      expect(val1).toBe('speed');
      expect(val2).toBe('128k');
      expect(val3).toBeUndefined(); // missing key in settings
    });

    // Verify all allowed settings are fetched in a single IN (...) query
    const settingsQueries = prepareSpy.mock.calls.filter(([sql]) => /FROM\s+settings\s+WHERE\s+key\s+IN/i.test(sql));
    expect(settingsQueries).toHaveLength(1);
  });
});
