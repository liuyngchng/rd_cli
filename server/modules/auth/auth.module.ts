import { createRequire } from 'node:module';

import { getConnection, userDb } from '@/modules/database/index.js';
import { debug } from '@/shared/debug.js';
import { userWorkspaceService } from '@/modules/user/user.module.js';

import { authenticateToken, generateToken, revokeToken } from './auth.middleware.js';
import { createAuthRouter } from './auth.routes.js';
import { createAuthService } from './auth.service.js';

type BcryptAdapter = {
  hash(password: string, saltRounds: number): Promise<string>;
  compare(password: string, passwordHash: string): Promise<boolean>;
};

// bcrypt does not ship TypeScript declarations in this project, so the
// composition root narrows its CommonJS runtime surface before injecting it.
const require = createRequire(import.meta.url);
const bcrypt = require('bcrypt') as BcryptAdapter;
let databaseConnection: ReturnType<typeof getConnection> | null = null;
function getDatabaseConnection() {
  if (!databaseConnection) {
    debug('auth.module: lazy-initializing database connection');
    databaseConnection = getConnection();
  }
  return databaseConnection;
}

const authService = createAuthService({
  users: {
    hasUsers: () => userDb.hasUsers(),
    createUser: (username, passwordHash, role?) => userDb.createUser(username, passwordHash, role),
    getUserByUsername: (username) => userDb.getUserByUsername(username),
    updateLastLogin: (userId) => userDb.updateLastLogin(userId),
    listUsers: () => userDb.listUsers(),
    setUserActive: (userId, isActive) => userDb.setUserActive(userId, isActive),
  },
  transaction: {
    begin: () => getDatabaseConnection().prepare('BEGIN').run(),
    commit: () => getDatabaseConnection().prepare('COMMIT').run(),
    rollback: () => getDatabaseConnection().prepare('ROLLBACK').run(),
  },
  hashPassword: (password) => bcrypt.hash(password, 12),
  comparePassword: (password, passwordHash) => bcrypt.compare(password, passwordHash),
  generateToken,
  revokeToken,
  userWorkspace: {
    ensureUserWorkspace: async (userId) => {
      await userWorkspaceService.ensureUserWorkspace(userId);
    },
  },
  logWarn: (message, error) => console.warn(message, error),
});

/** Simple admin role check middleware — must run after authenticateToken. */
const adminMiddleware: import('express').RequestHandler = (req, res, next) => {
  const user = (req as unknown as Record<string, unknown>).user as { role?: string } | undefined;
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required', code: 'AUTH_FORBIDDEN' });
  }
  next();
};

/** Auth router assembled for the server entrypoint. */
export const authRoutes = createAuthRouter(authService, authenticateToken, adminMiddleware);
