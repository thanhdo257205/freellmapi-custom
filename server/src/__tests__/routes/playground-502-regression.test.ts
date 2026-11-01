import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
// Type-only imports are erased, so they stay safe alongside the provider mock.
import type { FallbackHooks } from '../../lib/fallback-loop.js';
import type { RouteResult } from '../../services/router.js';

// One fake provider for the whole file: test 6 parks a real /v1 inference call
// mid-upstream, which is only possible if the upstream call itself is ours.
// `hasProvider` stays real so routing still walks the seeded catalog.
const chatCompletion = vi.fn();
const streamChatCompletion = vi.fn();
const fakeProvider = { name: 'fake', chatCompletion, streamChatCompletion } as any;

vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    getProvider: () => fakeProvider,
    resolveProvider: () => fakeProvider,
  };
});

const { createApp } = await import('../../app.js');
const { getDb, initDb, getUnifiedApiKey } = await import('../../db/index.js');
const { runFallbackLoop, newFallbackState } = await import('../../lib/fallback-loop.js');
const { newClientAbortError } = await import('../../lib/error-classify.js');
const { logRequest, persistRequestAttempts } = await import('../../lib/request-log.js');
const { routeRequest, setRoutingStrategy } = await import('../../services/router.js');
const { encrypt, initEncryptionKey } = await import('../../lib/crypto.js');
const { acquireLease, releaseLease, resetLeases } = await import('../../services/ratelimit.js');
const { wrapTursoDatabase } = await import('../../db/turso.js');
const { readRoutingSetting, withRoutingSettingsScope } = await import('../../db/routing-settings-scope.js');

async function withServer<T>(app: Express, run: (base: string) => Promise<T>): Promise<T> {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  try {
    return await run(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(err => (err ? reject(err) : resolve())));
  }
}

async function httpGet(base: string, path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

async function httpPost(base: string, path: string, body: unknown, key: string) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

/** Poll until `pred` holds, so a test can act at a specific point of an
 *  in-flight request without betting on a wall-clock threshold. */
async function waitUntil(pred: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/**
 * Count one-key settings reads (`SELECT … FROM settings WHERE key = ?`) issued
 * through `db.prepare` while the patch is installed. `restore()` must run when
 * the test is done: it puts the real `prepare` back, and the wrapper only
 * replaces `get` on the statement it hands out, so `.all`/`.run` still work.
 */
function instrumentSettingsQueries(db: any): { total: () => number; floor: () => number; restore: () => void } {
  const original = db.prepare.bind(db);
  let total = 0;
  let floor = 0;
  db.prepare = (sql: string) => {
    const stmt = original(sql);
    if (!/FROM\s+settings\s+WHERE\s+key\s*=/i.test(sql)) return stmt;
    total++;
    const originalGet = stmt.get.bind(stmt);
    stmt.get = (...args: unknown[]) => {
      if (args[0] === 'min_context_window') floor++;
      return originalGet(...args);
    };
    return stmt;
  };
  return {
    total: () => total,
    floor: () => floor,
    restore: () => { db.prepare = original; },
  };
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
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
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
    const probe = instrumentSettingsQueries(db);

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

    const settingsQueries = probe.total();
    const floorQueries = probe.floor();
    probe.restore();

    // Verify fallback succeeded on next candidate
    expect(attempts).toBe(2);
    expect(finalOutcome).toBeTruthy();

    // The min_context_window floor is hoisted to once per routing pass (2 passes
    // here). Without the hoist every candidate model re-reads it: 76 SELECTs for
    // floor alone on this 25-model catalog.
    expect(floorQueries).toBeLessThanOrEqual(2);
    // And the two-hop request stays within per-pass settings reads (~14 per
    // pass) instead of the ~100 single-key SELECTs the storm produced.
    expect(settingsQueries).toBeLessThanOrEqual(40);
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

  it('6. health probes answer while an inference request is parked on upstream', async () => {
    const db = getDb();
    setRoutingStrategy('priority');
    const enc = encrypt('health-probe-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'health-probe', ?, ?, ?, 'healthy', 1)
    `).run(enc.encrypted, enc.iv, enc.authTag);
    const unifiedKey = getUnifiedApiKey();

    // The upstream call is held open until the test lets it go, so every health
    // probe below lands while the inference is demonstrably still in flight.
    let releaseUpstream!: () => void;
    const upstreamGate = new Promise<void>(resolve => { releaseUpstream = resolve; });
    let upstreamStarted = false;
    let upstreamSettled = false;
    chatCompletion.mockImplementation(async () => {
      upstreamStarted = true;
      await upstreamGate;
      upstreamSettled = true;
      return {
        choices: [{ message: { role: 'assistant', content: 'late but fine' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      };
    });

    await withServer(app, async (base) => {
      const inference = httpPost(base, '/v1/chat/completions', {
        messages: [{ role: 'user', content: 'park me on upstream' }],
      }, unifiedKey);

      await waitUntil(() => upstreamStarted, 'the inference call to reach the provider');

      const livez = await httpGet(base, '/livez');
      const readyz = await httpGet(base, '/readyz');
      const ping = await httpGet(base, '/api/ping');

      // The proof: all three answers were produced while the inference was
      // still parked, i.e. Render's checker is not queued behind a routing pass.
      expect(upstreamSettled).toBe(false);
      expect(livez.status).toBe(200);
      expect(livez.body.status).toBe('ok');
      expect(readyz.status).toBe(200);
      expect(readyz.body.ready_upstreams).toBeGreaterThan(0);
      expect(ping.status).toBe(200);
      expect(ping.body.status).toBe('ok');

      releaseUpstream();
      const inferenceRes = await inference;
      expect(inferenceRes.status).toBe(200);
      expect(inferenceRes.body.choices[0].message.content).toBe('late but fine');
    });
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

  it('8. an undecryptable key is evicted from the pass cache, not retried per model', () => {
    const db = getDb();
    setRoutingStrategy('priority');

    const groqModels = db.prepare(
      "SELECT id FROM models WHERE enabled = 1 AND platform = 'groq'",
    ).all() as { id: number }[];
    // The bug only shows up when one pass visits several models of the platform
    // whose key pool is cached — assert the fixture still provides that.
    expect(groqModels.length).toBeGreaterThanOrEqual(2);

    // A key that looks healthy until the AES-GCM tag fails, and nothing else to
    // route to: the pass has to walk every groq model before it gives up.
    const broken = encrypt('eviction-broken');
    const badInsert = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'eviction-broken', ?, ?, ?, 'healthy', 1)
    `).run(broken.encrypted, broken.iv, `x${broken.authTag.slice(1)}`);
    const badKeyId = Number(badInsert.lastInsertRowid);

    let badKeyUpdates = 0;
    const spyDb = db as any;
    const originalPrepare = spyDb.prepare.bind(spyDb);
    spyDb.prepare = (sql: string) => {
      const stmt = originalPrepare(sql);
      if (/UPDATE\s+api_keys\s+SET\s+status\s*=\s*'error'/i.test(sql)) {
        const run = stmt.run.bind(stmt);
        stmt.run = (...args: unknown[]) => {
          badKeyUpdates++;
          return run(...args);
        };
      }
      return stmt;
    };

    let exhausted = false;
    try {
      routeRequest(1000);
    } catch {
      exhausted = true;
    } finally {
      spyDb.prepare = originalPrepare;
    }

    // One model hit the broken key, so one UPDATE. Without the cache eviction
    // every later groq model re-decrypted it and re-marked the same row.
    expect(exhausted).toBe(true);
    expect(badKeyUpdates).toBe(1);
    expect((db.prepare('SELECT status FROM api_keys WHERE id = ?').get(badKeyId) as { status: string }).status)
      .toBe('error');
  });
});
