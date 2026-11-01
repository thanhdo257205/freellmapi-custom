import type { Request, Response, NextFunction } from 'express';
import type { SessionUser } from '../services/auth.js';
import type { Permission } from '@freellmapi/shared/user-access.js';

/**
 * Checks whether a session user holds a specific permission.
 * Primary admins and full admins implicitly hold all permissions.
 */
export function hasPermission(user: SessionUser | undefined, permission: Permission): boolean {
  if (!user) return false;
  if (user.isPrimary) return true;
  if (user.role === 'admin') return true;
  if (user.permissions?.includes('*')) return true;
  return Boolean(user.permissions?.includes(permission));
}

/**
 * Middleware factory that enforces a specific permission on a route prefix.
 * Rejects with 403 Forbidden if the user lacks the permission.
 */
export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as Request & { user?: SessionUser }).user;
    if (!hasPermission(user, permission)) {
      res.status(403).json({
        error: {
          message: `Permission denied: '${permission}' access required.`,
          type: 'forbidden',
        },
      });
      return;
    }
    next();
  };
}

