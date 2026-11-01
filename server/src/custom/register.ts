import type { Express } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { adminUsersRouter } from '../routes/admin-users.js';
import { adminRegistrationRequestsRouter } from '../routes/admin-registration-requests.js';
import { invitesRouter } from '../routes/invites.js';
import { userKeysRouter } from '../routes/user-keys.js';
import { externalAuthRouter } from '../routes/external-auth.js';
import { customAuthRouter } from './auth.js';

// Everything this fork adds to the HTTP surface is wired here, so upstream's
// app.ts keeps a handful of added lines instead of edited mount statements.
//
// The gate below is deliberately a separate app-level mount registered BEFORE
// upstream's own `app.use('/api/keys', requireAuth, keysRouter)` lines. Gating
// the router objects themselves would not work: `router.use()` appends to the
// end of a stack that is already populated at import time, so the routes would
// answer first and the gate would never run. Mounting the prefixes here means an
// upstream commit that rewrites or reorders its own mounts cannot silently drop
// admin access control.

/** `/api/*` prefixes an admin session is required for. */
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
  // Guard mount: it ends the request with 401/403 for a non-admin, and simply
  // calls next() otherwise. Upstream's own mount then re-runs requireAuth for
  // the admin case — one extra session lookup per admin request, which is the
  // price of not editing upstream's mount lines.
  app.use(ADMIN_ONLY_PREFIXES, requireAuth, requireAdmin);

  // Above the upstream authRouter mount, so a future upstream /register cannot
  // shadow invite registration.
  app.use('/api/auth', externalAuthRouter, customAuthRouter);
  app.use('/api/invites', requireAuth, invitesRouter);
  app.use('/api/admin/users', requireAuth, adminUsersRouter);
  app.use('/api/admin/registration-requests', requireAuth, adminRegistrationRequestsRouter);
  app.use('/api/user', requireAuth, userKeysRouter);
}
