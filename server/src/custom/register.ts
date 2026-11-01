import type { Express } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { adminUsersRouter } from '../routes/admin-users.js';
import { adminRegistrationRequestsRouter } from '../routes/admin-registration-requests.js';
import { invitesRouter } from '../routes/invites.js';
import { userKeysRouter } from '../routes/user-keys.js';
import { externalAuthRouter } from '../routes/external-auth.js';
import { customAuthRouter } from './auth.js';
import { userInferenceGate } from '../middleware/user-rate-limit.js';

// Everything this fork adds to the HTTP surface is wired here, so upstream's
// app.ts keeps a handful of added lines instead of edited mount statements.
//
// The gates below are registered BEFORE upstream's own mounts in app.ts so that
// granular RBAC permissions (manage_keys, manage_settings, etc.) are strictly
// enforced before upstream route handlers run.

/** `/api/*` prefixes that require administrative permissions. */
export const ADMIN_ONLY_PREFIXES: string[] = [
  '/api/keys',
  '/api/client-profiles',
  '/api/logs',
  '/api/settings',
  '/api/backups',
  '/api/update',
  '/api/invites',
  '/api/admin/users',
  '/api/admin/registration-requests',
];

export function registerCustomRoutes(app: Express): void {
  // Rate-limiting and usage tracking gate for member personal API keys (/v1 inference)
  app.use('/v1', userInferenceGate);

  // Granular route-level permission gates for upstream-mounted endpoints
  app.use('/api/keys', requireAuth, requirePermission('manage_keys'));
  app.use(['/api/client-profiles', '/api/settings', '/api/update'], requireAuth, requirePermission('manage_settings'));
  app.use('/api/logs', requireAuth, requirePermission('view_logs'));
  app.use('/api/backups', requireAuth, requirePermission('manage_backups'));

  // Custom fork routes with their dedicated permission gates
  app.use('/api/auth', externalAuthRouter, customAuthRouter);
  app.use('/api/invites', requireAuth, requirePermission('manage_invites'), invitesRouter);
  app.use('/api/admin/users', requireAuth, requirePermission('manage_users'), adminUsersRouter);
  app.use('/api/admin/registration-requests', requireAuth, requirePermission('manage_requests'), adminRegistrationRequestsRouter);
  app.use('/api/user', requireAuth, userKeysRouter);
}
