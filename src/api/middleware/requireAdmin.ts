/**
 * RBAC middleware: restricts routes to ADMIN users only.
 * Apply after requireAuth.
 */

import { Request, Response, NextFunction } from 'express';

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    return;
  }

  if (req.auth.role !== 'ADMIN') {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin role required' } });
    return;
  }

  next();
}
