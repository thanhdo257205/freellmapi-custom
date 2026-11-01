import type { Db } from '../db/index.js';
import { getDb } from '../db/index.js';

export interface KeyRow {
  id: number;
  platform: string;
  label: string | null;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  proxy_encrypted: string | null;
  proxy_iv: string | null;
  proxy_auth_tag: string | null;
  status: string;
  enabled: number;
  model_scope_json: string | null;
  base_url: string | null;
  monthly_request_cap?: number;
  monthly_token_cap?: number;
}

let keyRegistry: Map<string, KeyRow[]> | null = null;
let testOverrideEnabled: boolean | null = null;

function cachesEnabled(): boolean {
  if (testOverrideEnabled !== null) return testOverrideEnabled;
  return process.env.NODE_ENV !== 'test';
}

/** Explicitly enable or disable key cache under test environments. */
export function setKeyCacheTestOverride(enabled: boolean | null): void {
  testOverrideEnabled = enabled;
  if (enabled === false) {
    keyRegistry = null;
  }
}

/**
 * Invalidate the in-memory key cache so the next request reloads from DB.
 * Called on any key creation, modification, deletion, or health status update.
 */
export function invalidateKeyCache(): void {
  keyRegistry = null;
}

/**
 * Return all enabled + healthy/unknown keys grouped by platform.
 * Reads from memory cache if populated, otherwise fetches from DB in a single query.
 */
export function getUsableKeysByPlatform(db: Db = getDb()): Map<string, KeyRow[]> {
  if (cachesEnabled() && keyRegistry !== null) {
    return keyRegistry;
  }

  const rows = db.prepare(
    "SELECT * FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown')"
  ).all() as KeyRow[];

  const map = new Map<string, KeyRow[]>();
  for (const row of rows) {
    const list = map.get(row.platform);
    if (list) {
      list.push(row);
    } else {
      map.set(row.platform, [row]);
    }
  }

  if (cachesEnabled()) {
    keyRegistry = map;
  }
  return map;
}

/**
 * Return usable keys for a specific platform.
 */
export function getUsableKeysForPlatform(platform: string, db: Db = getDb()): KeyRow[] {
  const map = getUsableKeysByPlatform(db);
  return (map.get(platform) ?? []).slice();
}

/**
 * Return count of usable keys per platform (replaces per-request GROUP BY).
 */
export function countUsableKeysByPlatform(db: Db = getDb()): Map<string, number> {
  const map = getUsableKeysByPlatform(db);
  const counts = new Map<string, number>();
  for (const [platform, keys] of map.entries()) {
    counts.set(platform, keys.length);
  }
  return counts;
}

/**
 * Return a flattened list of all usable keys.
 */
export function getAllUsableKeys(db: Db = getDb()): KeyRow[] {
  const map = getUsableKeysByPlatform(db);
  const all: KeyRow[] = [];
  for (const list of map.values()) {
    all.push(...list);
  }
  return all;
}
