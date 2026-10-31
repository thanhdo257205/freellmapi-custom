import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  listInviteCodes,
  createInviteCode,
  revokeInviteCode,
} from '../services/invites.js';
import type { SessionUser } from '../services/auth.js';

export const invitesRouter = Router();

const createInviteSchema = z.object({
  code: z.string().trim().optional(),
  maxUses: z.number().int().min(1).max(1000).optional(),
  expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
  note: z.string().trim().max(255).optional(),
});

// GET /api/invites — list all invite codes (Admin only)
invitesRouter.get('/', (_req: Request, res: Response) => {
  const list = listInviteCodes();
  res.json({ invites: list });
});

// POST /api/invites — create a new invite code (Admin only)
invitesRouter.post('/', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const parsed = createInviteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  try {
    const invite = createInviteCode(user.userId, parsed.data);
    res.status(201).json({ invite });
  } catch (err: any) {
    if (err.code === 'invite_code_exists') {
      res.status(409).json({ error: { message: 'An invite code with this name already exists.', type: 'code_exists' } });
      return;
    }
    res.status(500).json({ error: { message: 'Failed to create invite code.' } });
  }
});

// DELETE /api/invites/:id — revoke an invite code (Admin only)
invitesRouter.delete('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid invite ID' } });
    return;
  }

  const success = revokeInviteCode(id);
  if (!success) {
    res.status(404).json({ error: { message: 'Invite code not found or already revoked.' } });
    return;
  }

  res.json({ success: true });
});
