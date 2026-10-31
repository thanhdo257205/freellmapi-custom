import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  listUserApiKeys,
  mintUserApiKey,
  revokeUserApiKey,
} from '../services/user-keys.js';
import type { SessionUser } from '../services/auth.js';

export const userKeysRouter = Router();

const createKeySchema = z.object({
  name: z.string().trim().max(100).optional(),
});

// GET /api/user/keys — list all API keys belonging to the current session user
userKeysRouter.get('/keys', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const keys = listUserApiKeys(user.userId);
  res.json({ keys });
});

// POST /api/user/keys — mint a new key for the current user
userKeysRouter.post('/keys', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const parsed = createKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const created = mintUserApiKey(user.userId, parsed.data.name || 'Default Key');
  res.status(201).json({ key: created });
});

// DELETE /api/user/keys/:id — revoke an API key belonging to the current user
userKeysRouter.delete('/keys/:id', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const success = revokeUserApiKey(user.userId, id);
  if (!success) {
    res.status(404).json({ error: { message: 'Key not found or already revoked.' } });
    return;
  }

  res.json({ success: true });
});
