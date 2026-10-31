import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { createUser, createSession } from '../services/auth.js';
import { validateInviteCode, claimInviteCode } from '../services/invites.js';
import { mintUserApiKey } from '../services/user-keys.js';

// Invite-only registration. Kept out of routes/auth.ts so upstream's auth
// router stays byte-identical and can be merged without conflicts.
export const customAuthRouter = Router();

const registerSchema = z.object({
  email: z.string().email('A valid email is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  inviteCode: z.string().min(1, 'Invite code is required'),
});

customAuthRouter.get('/validate-invite', (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  res.json(validateInviteCode(code));
});

customAuthRouter.post('/register', (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const { email, password, inviteCode } = parsed.data;

  const validation = validateInviteCode(inviteCode);
  if (!validation.valid) {
    const messages: Record<string, string> = {
      expired: 'This invite code has expired.',
      exhausted: 'This invite code has reached its maximum uses.',
      revoked: 'This invite code has been revoked.',
    };
    res.status(400).json({
      error: { message: messages[validation.reason ?? ''] ?? 'Invalid invite code.', type: 'invalid_invite_code' },
    });
    return;
  }

  let user;
  try {
    user = createUser(email, password, 'member');
  } catch (err: any) {
    if (err.code === 'email_taken') {
      res.status(409).json({ error: { message: 'An account with that email already exists.', type: 'email_taken' } });
      return;
    }
    throw err;
  }

  // Claimed after creation so a rejected email never burns a slot; the guard in
  // the UPDATE keeps used_count itself correct under a race.
  claimInviteCode(inviteCode);

  const initialKey = mintUserApiKey(user.userId, 'Default Key');
  const token = createSession(user.userId);
  res.status(201).json({ token, email: user.email, role: user.role, apiKey: initialKey.key });
});
