import { getDb } from '../db/index.js';

// In-memory sliding window for per-user rate limiting (requests per minute)
const userMinuteWindows = new Map<number, number[]>();

export interface RateLimitCheckResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

/**
 * Checks sliding window RPM rate limit for a user.
 */
export function checkUserRateLimit(userId: number, rpmLimit: number = 60): RateLimitCheckResult {
  const now = Date.now();
  const windowMs = 60_000;
  const cutoff = now - windowMs;

  let timestamps = userMinuteWindows.get(userId);
  if (!timestamps) {
    timestamps = [];
    userMinuteWindows.set(userId, timestamps);
  }

  // Prune expired entries
  while (timestamps.length > 0 && timestamps[0] <= cutoff) {
    timestamps.shift();
  }

  const effectiveLimit = Math.max(1, rpmLimit);
  if (timestamps.length >= effectiveLimit) {
    const oldest = timestamps[0];
    const resetSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    return {
      allowed: false,
      limit: effectiveLimit,
      remaining: 0,
      resetSeconds,
    };
  }

  timestamps.push(now);
  return {
    allowed: true,
    limit: effectiveLimit,
    remaining: effectiveLimit - timestamps.length,
    resetSeconds: 60,
  };
}

/**
 * Record a completed inference request and tokens for a user.
 */
export function recordUserUsage(userId: number, tokens: number = 0): void {
  const db = getDb();
  const month = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
  const tokenCount = Math.max(0, Math.floor(tokens));

  try {
    db.prepare(`
      INSERT INTO user_monthly_usage (user_id, month, requests, tokens)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(user_id, month) DO UPDATE SET
        requests = requests + 1,
        tokens = tokens + excluded.tokens
    `).run(userId, month, tokenCount);
  } catch (err) {
    // Non-blocking telemetry failure
  }
}

/**
 * Get monthly usage for a specific user.
 */
export function getUserUsage(userId: number, month?: string): { requests: number; tokens: number; month: string } {
  const db = getDb();
  const targetMonth = month || new Date().toISOString().slice(0, 7);

  const row = db.prepare(`
    SELECT requests, tokens
    FROM user_monthly_usage
    WHERE user_id = ? AND month = ?
  `).get(userId, targetMonth) as { requests: number; tokens: number } | undefined;

  return {
    requests: row?.requests || 0,
    tokens: row?.tokens || 0,
    month: targetMonth,
  };
}

export interface UserUsageItem {
  userId: number;
  email: string;
  role: 'admin' | 'member';
  requests: number;
  tokens: number;
  rpmLimit: number;
  keyPrefix: string | null;
  lastUsedAt: string | null;
}

/**
 * List monthly usage and quota settings for all users (Admin view).
 */
export function listAllUsersUsage(month?: string): UserUsageItem[] {
  const db = getDb();
  const targetMonth = month || new Date().toISOString().slice(0, 7);

  const rows = db.prepare(`
    SELECT 
      u.id AS userId,
      u.email,
      u.role,
      COALESCE(m.requests, 0) AS requests,
      COALESCE(m.tokens, 0) AS tokens,
      COALESCE(MAX(k.rpm_limit), 60) AS rpmLimit,
      MAX(k.key_prefix) AS keyPrefix,
      MAX(k.last_used_at) AS lastUsedAt
    FROM users u
    LEFT JOIN user_monthly_usage m ON m.user_id = u.id AND m.month = ?
    LEFT JOIN user_api_keys k ON k.user_id = u.id AND k.revoked = 0
    GROUP BY u.id, u.email, u.role
    ORDER BY requests DESC, u.id ASC
  `).all(targetMonth) as Array<{
    userId: number;
    email: string;
    role: string;
    requests: number;
    tokens: number;
    rpmLimit: number;
    keyPrefix: string | null;
    lastUsedAt: string | null;
  }>;

  return rows.map(r => ({
    userId: r.userId,
    email: r.email,
    role: r.role === 'admin' ? 'admin' : 'member',
    requests: r.requests,
    tokens: r.tokens,
    rpmLimit: r.rpmLimit,
    keyPrefix: r.keyPrefix,
    lastUsedAt: r.lastUsedAt,
  }));
}

/**
 * Set the RPM rate limit for a specific user's active API keys.
 */
export function setUserRpmLimit(userId: number, newRpmLimit: number): boolean {
  const db = getDb();
  const rpm = Math.max(1, Math.min(1000, Math.floor(newRpmLimit)));

  const result = db.prepare(`
    UPDATE user_api_keys
    SET rpm_limit = ?
    WHERE user_id = ? AND revoked = 0
  `).run(rpm, userId);

  return result.changes > 0;
}
