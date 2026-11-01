import type { Request, Response, NextFunction } from 'express';
import { validateUserApiKey, USER_KEY_PREFIX } from '../services/user-keys.js';
import { checkUserRateLimit, recordUserUsage } from '../services/user-quotas.js';

function extractBearer(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return undefined;
  const match = auth.match(/^Bearer\s+(sk-flm-[A-Za-z0-9_-]+)$/i);
  return match ? match[1] : undefined;
}

/**
 * Intercepts /v1 inference calls using user API keys (`sk-flm-...`).
 * Enforces per-user sliding window RPM limit and records monthly usage.
 * Non-user keys (Unified key, client profiles) pass through seamlessly to upstream.
 */
export function userInferenceGate(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearer(req);
  if (!token) {
    return next();
  }

  const userKey = validateUserApiKey(token);
  if (!userKey) {
    // If a user key was provided but is revoked or invalid, reject with 401
    res.status(401).json({
      error: {
        message: 'Incorrect or revoked API key provided.',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    });
    return;
  }

  // Check RPM limit
  const limit = checkUserRateLimit(userKey.userId, userKey.rpmLimit);
  res.setHeader('X-RateLimit-Limit-User-RPM', limit.limit.toString());
  res.setHeader('X-RateLimit-Remaining-User-RPM', limit.remaining.toString());
  res.setHeader('X-RateLimit-Reset-User-RPM', limit.resetSeconds.toString());

  if (!limit.allowed) {
    res.status(429).json({
      error: {
        message: `Rate limit exceeded. Your plan limit is ${limit.limit} requests per minute. Please retry in ${limit.resetSeconds} seconds.`,
        type: 'rate_limit_exceeded',
        code: 'user_rate_limit_exceeded',
      },
    });
    return;
  }

  // Record usage when response completes
  res.on('finish', () => {
    if (res.statusCode < 400) {
      recordUserUsage(userKey.userId, 0);
    }
  });

  next();
}
