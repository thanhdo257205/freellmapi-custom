import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  listRegistrationRequests,
  approveRegistrationRequest,
  rejectRegistrationRequest,
} from '../services/registration-requests.js';
import type { SessionUser } from '../services/auth.js';

export const adminRegistrationRequestsRouter = Router();

function actor(req: Request): SessionUser {
  return (req as Request & { user?: SessionUser }).user!;
}

function parseId(raw: string | string[], res: Response): number | null {
  const id = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid request ID', type: 'invalid_request_id' } });
    return null;
  }
  return id;
}

// GET /api/admin/registration-requests
adminRegistrationRequestsRouter.get('/', (_req: Request, res: Response) => {
  const requests = listRegistrationRequests('pending');
  res.json({ requests });
});

// POST /api/admin/registration-requests/:id/approve
adminRegistrationRequestsRouter.post('/:id/approve', (req: Request, res: Response) => {
  const id = parseId(req.params.id, res);
  if (id === null) return;

  try {
    const user = approveRegistrationRequest(id, actor(req).userId);
    res.json({ success: true, user });
  } catch (err: any) {
    if (err.code === 'not_found') {
      res.status(404).json({ error: { message: 'Registration request not found', type: 'not_found' } });
      return;
    }
    if (err.code === 'email_taken' || err.code === 'user_exists') {
      res.status(409).json({ error: { message: 'An account with that email already exists', type: 'email_taken' } });
      return;
    }
    if (err.code === 'invalid_status') {
      res.status(400).json({ error: { message: 'Request is not pending approval', type: 'invalid_status' } });
      return;
    }
    res.status(500).json({ error: { message: 'Failed to approve registration request' } });
  }
});

// POST /api/admin/registration-requests/:id/reject
adminRegistrationRequestsRouter.post('/:id/reject', (req: Request, res: Response) => {
  const id = parseId(req.params.id, res);
  if (id === null) return;

  try {
    const result = rejectRegistrationRequest(id, actor(req).userId);
    res.json(result);
  } catch (err: any) {
    if (err.code === 'not_found') {
      res.status(404).json({ error: { message: 'Registration request not found', type: 'not_found' } });
      return;
    }
    res.status(500).json({ error: { message: 'Failed to reject registration request' } });
  }
});
