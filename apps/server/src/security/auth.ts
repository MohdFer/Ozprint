import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { IDatabase } from '../db/database';

export type UserRole = 'ADMIN' | 'MEMBER' | 'KIOSK_GUEST';

export interface AuthUser {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  monthlyPageQuota: number;
  pagesUsedCurrentPeriod: number;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signAuthToken(
  user: { id: string; username: string; role: UserRole },
  jwtSecret: string,
  expiresIn: string | number = '24h'
): string {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role: user.role,
    },
    jwtSecret,
    { expiresIn: expiresIn as any }
  );
}

export function createAuthMiddleware(db: IDatabase, jwtSecret: string) {
  return function requireAuth(req: Request, res: Response, next: NextFunction) {
    let token: string | undefined;

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    } else if (req.cookies && req.cookies.ozprint_token) {
      token = req.cookies.ozprint_token;
    }

    if (!token) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Authentication token required',
      });
    }

    try {
      const decoded = jwt.verify(token, jwtSecret) as {
        sub: string;
        username: string;
        role: UserRole;
      };

      const row = db
        .prepare<any>(
          `SELECT id, username, email, role, monthly_page_quota, pages_used_current_period, is_active
           FROM users WHERE id = ?`
        )
        .get(decoded.sub);

      if (!row || !row.is_active) {
        return res.status(401).json({
          error: 'UNAUTHORIZED',
          message: 'Account disabled or not found',
        });
      }

      req.user = {
        id: row.id,
        username: row.username,
        email: row.email,
        role: row.role as UserRole,
        monthlyPageQuota: row.monthly_page_quota,
        pagesUsedCurrentPeriod: row.pages_used_current_period,
      };
      next();
    } catch {
      return res.status(401).json({
        error: 'INVALID_TOKEN',
        message: 'Invalid or expired authentication token',
      });
    }
  };
}

export function requireRole(allowedRoles: UserRole[]) {
  return function roleGuard(req: Request, res: Response, next: NextFunction) {
    if (!req.user) {
      return res.status(401).json({ error: 'UNAUTHORIZED' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: `Requires one of roles: ${allowedRoles.join(', ')}`,
      });
    }
    next();
  };
}
