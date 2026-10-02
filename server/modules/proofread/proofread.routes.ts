import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import express from 'express';
import multer from 'multer';

import { getGlobalImageAssetsDir as getGlobalAssetsDir, toPosixPath } from '@/shared/image-attachments.js';
import { userDb, apiKeysDb } from '@/modules/database/index.js';
import type { ProofreadService } from './proofread.service.js';
import { debug } from '@/shared/debug.js';

const IS_PLATFORM = process.env.VITE_IS_PLATFORM === 'true';

const ALLOWED_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

// Also accept browsers that don't know the docx MIME type.
const ALLOWED_EXTENSIONS = new Set(['.docx']);

function isAllowedDocx(mimetype: string, filename: string): boolean {
  if (ALLOWED_MIME_TYPES.has(mimetype)) {
    return true;
  }

  const ext = path.extname(filename).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

type ProofreadRouterDependencies = {
  proofreadService: ProofreadService;
  getSessionId: () => string;   // generates a fresh session id
};

type AuthenticatedUser = {
  id?: number | string;
  username?: string;
};

function getUserId(req: express.Request): number | undefined {
  const user = (req as typeof req & { user?: AuthenticatedUser }).user;
  if (user?.id != null) {
    const id = typeof user.id === 'string' ? Number(user.id) : user.id;
    return Number.isFinite(id) ? id : undefined;
  }
  return undefined;
}

function resolveUser(req: express.Request): AuthenticatedUser {
  const user = (req as typeof req & { user?: AuthenticatedUser }).user;
  return user ?? {};
}

/**
 * Middleware: validates external API access. Mirrors the agent.routes.ts
 * `validateExternalApiKey` pattern.
 */
function validateExternalApiKey(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (!user) {
        res.status(500).json({ error: 'Platform mode: No user found in database' });
        return;
      }
      (req as unknown as Record<string, unknown>).user = user;
      return next();
    } catch (error) {
      console.error('Platform mode error:', error);
      res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
      return;
    }
  }

  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  if (!apiKey) {
    res.status(401).json({ error: 'API key required' });
    return;
  }

  const user = apiKeysDb.validateApiKey(apiKey as string);
  if (!user) {
    res.status(401).json({ error: 'Invalid or inactive API key' });
    return;
  }

  (req as unknown as Record<string, unknown>).user = user;
  next();
}

/** Returns the per-user proofread upload folder. */
function getUserProofreadDir(userId: number): string {
  return path.join(getGlobalAssetsDir(), String(userId));
}

/** Creates the per-user proofread upload folder if needed. */
async function ensureUserProofreadDir(userId: number): Promise<string> {
  const dir = getUserProofreadDir(userId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Creates the proofread router with a single endpoint.
 */
export function createProofreadRouter(deps: ProofreadRouterDependencies): express.Router {
  const { proofreadService, getSessionId } = deps;
  const router = express.Router();

  // Multer: store uploaded docx in the user's assets folder.
  const storage = multer.diskStorage({
    destination: (req, _file, cb) => {
      const userId = getUserId(req);
      if (userId == null) {
        cb(new Error('Authentication required'), '');
        return;
      }
      ensureUserProofreadDir(userId)
        .then((dir) => cb(null, dir))
        .catch((error) => cb(error as Error, ''));
    },
    filename: (_req, file, cb) => {
      const uniqueSuffix = Date.now().toString(36);
      const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.一-鿿_-]/g, '_');
      cb(null, `${uniqueSuffix}-${sanitizedName}`);
    },
  });

  const upload = multer({
    storage,
    limits: {
      fileSize: 20 * 1024 * 1024, // 20MB
      files: 1,
    },
    fileFilter: (_req, file, cb) => {
      if (isAllowedDocx(file.mimetype, file.originalname)) {
        cb(null, true);
      } else {
        cb(new Error('仅支持 .docx 格式的 Word 文档'));
      }
    },
  });

  /**
   * POST /api/proofread/session
   *
   * Creates a pre-filled proofreading chat session. Uploads the Word document,
   * stores it in the user's assets folder, starts a background Claude session
   * with the proofreading system prompt, and returns a session URL for the
   * caller to open.
   */
  router.post('/session', validateExternalApiKey, (req, res, next) => {
    upload.single('file')(req, res, (uploadError?: unknown) => {
      if (uploadError) {
        const message = uploadError instanceof Error ? uploadError.message : 'Upload failed';
        res.status(400).json({ success: false, error: { code: 'UPLOAD_FAILED', message } });
        return;
      }

      void (async () => {
        try {
          if (!req.file) {
            res.status(400).json({
              success: false,
              error: { code: 'MISSING_FILE', message: '请上传 .docx 格式的 Word 文档' },
            });
            return;
          }

          const user = resolveUser(req);
          const userId = getUserId(req);
          if (userId == null) {
            res.status(401).json({
              success: false,
              error: { code: 'AUTH_REQUIRED', message: 'Authentication required' },
            });
            return;
          }

          // Resolve stored file path.
          const assetsDir = getUserProofreadDir(userId);
          const filePath = path.join(assetsDir, req.file.filename);
          const posixPath = toPosixPath(filePath);

          const additionalInstructions = typeof req.body.additional_instructions === 'string'
            ? req.body.additional_instructions.trim() || undefined
            : undefined;

          // User workspace for the Claude session.
          const workspacePath = path.join(os.homedir(), '.rdcli', 'users', String(userId));

          const sessionId = getSessionId();

          debug('[Proofread] Creating session',
            `sessionId=${sessionId}`,
            `file=${posixPath}`,
          );

          const result = await proofreadService.createProofreadSession({
            user: { userId, username: (user as Record<string, unknown>).username as string || '' },
            filePath: posixPath,
            fileName: req.file.originalname,
            fileSize: req.file.size,
            additionalInstructions,
            sessionId,
            workspacePath,
          });

          res.json({
            success: true,
            data: {
              session_id: result.sessionId,
              session_url: result.sessionUrl,
            },
          });
        } catch (error) {
          next(error);
        }
      })();
    });
  });

  return router;
}