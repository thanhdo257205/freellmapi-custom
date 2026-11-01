import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  listUsers,
  setUserRole,
  revokeSessionsForUser,
  revokeApiKeysForUser,
  userExists,
} from '../services/users.js';
import { listAllUsersUsage, setUserRpmLimit } from '../services/user-quotas.js';
import type { SessionUser } from '../services/auth.js';

// Admin user management. Mounted under /api/admin/users, which is in
// ADMIN_ONLY_PREFIXES, so a member session never reaches any handler here.

export const adminUsersRouter = Router();

function actor(req: Request): SessionUser {
  return (req as Request & { user?: SessionUser }).user!;
}

function parseId(raw: string | string[], res: Response): number | null {
  const id = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid user ID', type: 'invalid_user_id' } });
    return null;
  }
  return id;
}

// GET /api/admin/users
adminUsersRouter.get('/', (req: Request, res: Response) => {
  res.json({ users: listUsers(actor(req).userId) });
});

const roleSchema = z.object({ role: z.enum(['admin', 'member']) });

// PATCH /api/admin/users/:id/role
adminUsersRouter.patch('/:id/role', (req: Request, res: Response) => {
  const id = parseId(req.params.id, res);
  if (id === null) return;

  const parsed = roleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { message: parsed.error.errors.map(e => e.message).join(', '), type: 'invalid_role' },
    });
    return;
  }

  try {
    setUserRole(id, parsed.data.role, actor(req).userId);
    res.json({ success: true, id, role: parsed.data.role });
  } catch (err: any) {
    if (err.code === 'self_role_change') {
      res.status(409).json({
        error: { message: 'You cannot change your own role.', type: 'self_role_change' },
      });
      return;
    }
    if (err.code === 'user_not_found') {
      res.status(404).json({ error: { message: 'No such account.', type: 'user_not_found' } });
      return;
    }
    res.status(500).json({ error: { message: 'Failed to update role.' } });
  }
});

// POST /api/admin/users/:id/revoke-sessions
adminUsersRouter.post('/:id/revoke-sessions', (req: Request, res: Response) => {
  const id = parseId(req.params.id, res);
  if (id === null) return;
  if (!userExists(id)) {
    res.status(404).json({ error: { message: 'No such account.', type: 'user_not_found' } });
    return;
  }
  res.json({ revoked: revokeSessionsForUser(id) });
});

// POST /api/admin/users/:id/revoke-keys
adminUsersRouter.post('/:id/revoke-keys', (req: Request, res: Response) => {
  const id = parseId(req.params.id, res);
  if (id === null) return;
  if (!userExists(id)) {
    res.status(404).json({ error: { message: 'No such account.', type: 'user_not_found' } });
    return;
  }
  res.json({ revoked: revokeApiKeysForUser(id) });
});

// GET /api/admin/users/usage
adminUsersRouter.get('/usage', (req: Request, res: Response) => {
  const month = typeof req.query.month === 'string' ? req.query.month : undefined;
  res.json({ usage: listAllUsersUsage(month) });
});

const quotaSchema = z.object({
  rpmLimit: z.number().int().min(1).max(1000),
});

// PUT /api/admin/users/:id/quota
adminUsersRouter.put('/:id/quota', (req: Request, res: Response) => {
  const id = parseId(req.params.id, res);
  if (id === null) return;
  if (!userExists(id)) {
    res.status(404).json({ error: { message: 'No such account.', type: 'user_not_found' } });
    return;
  }

  const parsed = quotaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { message: 'rpmLimit must be an integer between 1 and 1000', type: 'invalid_quota' },
    });
    return;
  }

  const updated = setUserRpmLimit(id, parsed.data.rpmLimit);
  res.json({ success: true, id, rpmLimit: parsed.data.rpmLimit, updated });
});
