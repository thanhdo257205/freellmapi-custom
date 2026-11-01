import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from './types.js';
import { isTursoDatabase, tursoWriteVersion } from './turso.js';

// Only small routing configuration belongs here. Never prefetch credentials,
// sessions, license material, or the potentially large cached catalog document.
const KEYS = [
  'routing_strategy', 'routing_custom_weights', 'routing_explore_enabled',
  'routing_peak_hours_adjust', 'routing_peak_start_hour', 'routing_peak_end_hour',
  'routing_peak_timezone', 'routing_community_prior_enabled',
  'routing_headroom_ramp_start', 'routing_headroom_floor', 'routing_min_reliability_floor',
  'routing_provider_moment_attribution', 'routing_task_weight_share',
  'key_selection_strategy', 'routing_decision_model', 'routing_decision_min_probability',
  'unify_models_enabled',
] as const;
const allowed = new Set<string>(KEYS);
const sql = `SELECT key, value FROM settings WHERE key IN (${KEYS.map(() => '?').join(',')})`;
interface Scope {
  active: boolean;
  db?: Db;
  version?: number;
  values?: Map<string, string>;
}
const storage = new AsyncLocalStorage<Scope>();

/** Share one read only during the synchronous portion of an HTTP request.
 * Expire before any await/timer so external updates cannot become stale across
 * asynchronous work, streaming responses, or subsequent requests. */
export function withRoutingSettingsScope<T>(run: () => T): T {
  const scope: Scope = { active: true };
  return storage.run(scope, () => {
    queueMicrotask(() => { scope.active = false; scope.values = undefined; });
    return run();
  });
}

export function readRoutingSetting(db: Db, key: string, fallback: () => string | undefined): string | undefined {
  const scope = storage.getStore();
  if (!scope?.active || !allowed.has(key) || !isTursoDatabase(db)) return fallback();
  const version = tursoWriteVersion(db);
  if (!scope.values || scope.db !== db || scope.version !== version) {
    const rows = db.prepare(sql).all(...KEYS) as { key: string; value: string }[];
    scope.values = new Map(rows.map(row => [row.key, row.value]));
    scope.db = db;
    scope.version = version;
  }
  return scope.values.get(key);
}
