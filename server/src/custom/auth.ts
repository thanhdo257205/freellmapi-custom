import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { createUser, createSession } from '../services/auth.js';
import { validateInviteCode, claimInviteCode } from '../services/invites.js';
import { mintUserApiKey } from '../services/user-keys.js';
import {
  createRegistrationRequest,
  isRegistrationPending,
} from '../services/registration-requests.js';

// Invite-only registration and approval requests. Kept out of routes/auth.ts
// so upstream's auth router stays byte-identical and can be merged without conflicts.
export const customAuthRouter = Router();

const registerSchema = z.object({
  email: z.string().email('A valid email is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  inviteCode: z.string().min(1, 'Invite code is required'),
});

const requestAccessSchema = z.object({
  email: z.string().email('A valid email is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  note: z.string().max(500, 'Note cannot exceed 500 characters').optional(),
});

// Check if credentials belong to a pending registration request before standard login
customAuthRouter.post('/login', (req: Request, res: Response, next: NextFunction) => {
  const email = typeof req.body?.email === 'string' ? req.body.email : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (email && password && isRegistrationPending(email, password)) {
    res.status(403).json({
      error: {
        message: 'Tài khoản của bạn đang chờ Admin phê duyệt. Vui lòng quay lại sau!',
        type: 'registration_pending',
      },
    });
    return;
  }
  next();
});

customAuthRouter.get('/validate-invite', (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  res.json(validateInviteCode(code));
});

customAuthRouter.post('/request-access', (req: Request, res: Response) => {
  const parsed = requestAccessSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const { email, password, note } = parsed.data;

  try {
    const request = createRegistrationRequest(email, password, note);
    res.status(201).json({
      success: true,
      message: 'Yêu cầu đăng ký đã được gửi tới Admin. Bạn có thể đăng nhập sau khi được phê duyệt.',
      email: request.email,
    });
  } catch (err: any) {
    if (err.code === 'email_taken') {
      res.status(409).json({ error: { message: 'An account with that email already exists.', type: 'email_taken' } });
      return;
    }
    if (err.code === 'request_already_pending') {
      res.status(409).json({
        error: {
          message: 'Yêu cầu đăng ký cho email này đang chờ Admin phê duyệt.',
          type: 'request_already_pending',
        },
      });
      return;
    }
    res.status(500).json({ error: { message: 'Failed to submit registration request.' } });
  }
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
