import type { Request, Response, NextFunction } from 'express';
import type { SessionUser } from '../services/auth.js';

/**
 * Gate sensitive admin surfaces (provider keys, proxy settings, system logs, invites management).
 * Rejects with 403 Forbidden if the authenticated user is not an admin.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as Request & { user?: SessionUser }).user;
  if (!user || user.role !== 'admin') {
    res.status(403).json({
      error: {
        message: 'Admin access required for this action.',
        type: 'forbidden',
      },
    });
    return;
  }
  next();
}
