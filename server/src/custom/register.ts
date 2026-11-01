import type { Express, NextFunction, Request, Response } from 'express';
import type { Permission } from '@freellmapi/shared/user-access.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { adminUsersRouter } from '../routes/admin-users.js';
import { adminRegistrationRequestsRouter } from '../routes/admin-registration-requests.js';
import { invitesRouter } from '../routes/invites.js';
import { userKeysRouter } from '../routes/user-keys.js';
import { externalAuthRouter } from '../routes/external-auth.js';
import { customAuthRouter } from './auth.js';
import { userInferenceGate } from '../middleware/user-rate-limit.js';
import { withRoutingSettingsScope } from '../db/routing-settings-scope.js';

// Everything this fork adds to the HTTP surface is wired here, so upstream's
// app.ts keeps a handful of added lines instead of edited mount statements.
//
// The gates below are registered BEFORE upstream's own mounts in app.ts so that
// granular RBAC permissions (manage_keys, manage_settings, etc.) are strictly
// enforced before upstream route handlers run.

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** Methods that change server state. `GET` is never one of them. */
export const WRITE_METHODS: readonly HttpMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

export interface PermissionGate {
  /** Mount prefix, matched the way `app.use` matches it. */
  path: string | string[];
  permission: Permission;
  /** Restricted to these methods; omitted means every method, reads included. */
  methods?: readonly HttpMethod[];
}

/**
 * Gates on the upstream-mounted `/api/*` surfaces. A list that nothing consumes
 * is not a control, so `registerCustomRoutes` installs exactly these entries and
 * `__tests__/custom/surface.test.ts` keeps a frozen copy of them, demanding the
 * 403 independently — the failure mode being a merge that shrinks this file while
 * the app still boots and serves traffic.
 *
 * Reads stay open to any signed-in account where the member-facing dashboard needs
 * them: `PlaygroundPage` fetches `/api/profiles` for the chain picker and the
 * command palette fetches `/api/fallback`, so enforcement there is on the methods
 * that rewrite server-wide routing, catalog, or cache state. Reads whose payload
 * *is* provider-key material or install-wide quota are gated in full.
 */
export const PERMISSION_GATES: readonly PermissionGate[] = [
  { path: '/api/keys', permission: 'manage_keys' },
  { path: '/api/client-profiles', permission: 'manage_settings' },
  { path: '/api/settings', permission: 'manage_settings' },
  { path: '/api/update', permission: 'manage_settings' },
  { path: '/api/backups', permission: 'manage_backups' },
  { path: ['/api/logs', '/api/analytics'], permission: 'view_logs' },

  // The key roster, its health errors, and endpoints that decrypt and spend a
  // stored provider key on demand.
  { path: '/api/health', permission: 'manage_keys' },
  { path: '/api/free-tier', permission: 'manage_keys' },
  { path: '/api/fallback/rate-limit-usage', permission: 'manage_keys' },
  { path: ['/api/fallback/token-usage', '/api/fallback/quota-forecast'], permission: 'view_logs' },

  // Server-wide configuration: writable methods only.
  { path: '/api/profiles', permission: 'manage_settings', methods: WRITE_METHODS },
  { path: '/api/models', permission: 'manage_settings', methods: WRITE_METHODS },
  { path: '/api/fallback', permission: 'manage_settings', methods: WRITE_METHODS },
  { path: '/api/cache', permission: 'manage_settings', methods: WRITE_METHODS },
  { path: '/api/compression', permission: 'manage_settings', methods: WRITE_METHODS },
  { path: '/api/premium', permission: 'manage_settings', methods: WRITE_METHODS },

  // Modality catalogs reach the same credential store as the Keys page — they can
  // create, delete, or probe a stored key — so their writes need manage_keys.
  { path: ['/api/embeddings', '/api/media', '/api/search', '/api/decisions'], permission: 'manage_keys', methods: WRITE_METHODS },
];

function installGate(app: Express, gate: PermissionGate): void {
  const enforced = requirePermission(gate.permission);
  const methods = gate.methods;
  const scoped = (req: Request, res: Response, next: NextFunction): void => {
    if (methods && !methods.includes(req.method as HttpMethod)) {
      next();
      return;
    }
    enforced(req, res, next);
  };
  app.use(gate.path, requireAuth, scoped);
}

export function registerCustomRoutes(app: Express): void {
  app.use('/api', (_req, _res, next) => withRoutingSettingsScope(next));
  // Rate-limiting and usage tracking gate for member personal API keys (/v1 inference)
  app.use('/v1', userInferenceGate);

  // Granular route-level permission gates for upstream-mounted endpoints
  for (const gate of PERMISSION_GATES) installGate(app, gate);

  // Custom fork routes with their dedicated permission gates
  app.use('/api/auth', externalAuthRouter, customAuthRouter);
  app.use('/api/invites', requireAuth, requirePermission('manage_invites'), invitesRouter);
  app.use('/api/admin/users', requireAuth, requirePermission('manage_users'), adminUsersRouter);
  app.use('/api/admin/registration-requests', requireAuth, requirePermission('manage_requests'), adminRegistrationRequestsRouter);
  app.use('/api/user', requireAuth, userKeysRouter);
}
