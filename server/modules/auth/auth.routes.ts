import express from 'express';
import type { RequestHandler } from 'express';

import type { createAuthService } from './auth.service.js';

type AuthenticatedRequest = express.Request & { user?: unknown };

/**
 * Creates the Auth transport adapter. Handlers only parse request data and
 * delegate authentication behavior to the injected application service.
 */
export function createAuthRouter(
  service: ReturnType<typeof createAuthService>,
  authenticateToken: RequestHandler,
  adminMiddleware: RequestHandler,
): express.Router {
  const router = express.Router();

  router.get('/status', (_req, res, next) => {
    try {
      const hasUsers = service.getStatus().needsSetup === false;
      res.json({
        needsSetup: !hasUsers,
        hasUsers,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/register', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      res.json(await service.register(body.username, body.password));
    } catch (error) {
      next(error);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      res.json(await service.login(body.username, body.password));
    } catch (error) {
      next(error);
    }
  });

  router.get('/user', authenticateToken, (req, res) => {
    res.json(service.getCurrentUser((req as AuthenticatedRequest).user));
  });

  router.post('/refresh', authenticateToken, (req, res) => {
    res.json(service.refreshSession((req as AuthenticatedRequest).user));
  });

  router.post('/logout', authenticateToken, (_req, res) => {
    res.json(service.logout());
  });

  // ── Admin ──────────────────────────────────────────────────────────

  router.get('/admin/users', authenticateToken, adminMiddleware, async (req, res, next) => {
    try {
      res.json(service.adminListUsers((req as AuthenticatedRequest).user));
    } catch (error) {
      next(error);
    }
  });

  router.post('/admin/users', authenticateToken, adminMiddleware, async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      res.json(await service.adminCreateUser(
        (req as AuthenticatedRequest).user,
        body.username,
        body.password,
      ));
    } catch (error) {
      next(error);
    }
  });

  router.put('/admin/users/:id', authenticateToken, adminMiddleware, async (req, res, next) => {
    try {
      const userId = Number(req.params.id);
      const body = req.body as { isActive?: unknown };
      res.json(service.adminSetUserActive(
        (req as AuthenticatedRequest).user,
        userId,
        body.isActive,
      ));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
