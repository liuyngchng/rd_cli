import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import express from 'express';
import multer from 'multer';

import { getGlobalImageAssetsDir as getGlobalAssetsDir, toPosixPath } from '@/shared/image-attachments.js';
import { userDb, apiKeysDb } from '@/modules/database/index.js';
import { debug } from '@/shared/debug.js';

import type { ProofreadService } from './proofread.service.js';

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
  getTaskId: () => string;      // generates a fresh async task id
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
  const { proofreadService, getSessionId, getTaskId } = deps;
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
        cb(Object.assign(new Error('仅支持 .docx 格式的 Word 文档'), { code: 'UNSUPPORTED_FORMAT' }));
      }
    },
  });

  /**
   * GET /api/proofread
   *
   * Returns the authenticated user's active (pending + processing) tasks,
   * most recent first.
   */
  router.get('/', validateExternalApiKey, (req, res) => {
    const userId = getUserId(req);
    if (userId == null) {
      res.status(401).json({
        success: false,
        error: { code: 'AUTH_REQUIRED', message: 'Authentication required' },
      });
      return;
    }

    const tasks = proofreadService.listActiveTasks(userId);

    res.json({
      success: true,
      data: tasks.map((t) => ({
        task_id: t.task_id,
        status: t.status,
        file_name: t.file_name,
        file_size: t.file_size,
        additional_instructions: t.additional_instructions,
        created_at: t.created_at,
        updated_at: t.updated_at,
      })),
    });
  });

  /**
   * POST /api/proofread
   *
   * Creates an asynchronous proofreading task. Returns immediately with a taskId
   * so the caller can poll GET /api/proofread/:taskId for the completed result.
   */
  router.post('/', validateExternalApiKey, (req, res, next) => {
    upload.single('file')(req, res, (uploadError?: unknown) => {
      if (uploadError) {
        if (uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({
            success: false,
            error: { code: 'UPLOAD_FAILED', message: '文件超过 20MB 上限，请压缩或拆分后重试' },
          });
        } else if (uploadError instanceof Error && (uploadError as Error & { code?: string }).code === 'UNSUPPORTED_FORMAT') {
          res.status(400).json({
            success: false,
            error: { code: 'UNSUPPORTED_FORMAT', message: uploadError.message },
          });
        } else {
          const message = uploadError instanceof Error ? uploadError.message : 'Upload failed';
          res.status(400).json({ success: false, error: { code: 'UPLOAD_FAILED', message } });
        }
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

          const assetsDir = getUserProofreadDir(userId);
          const filePath = path.join(assetsDir, req.file.filename);
          const posixPath = toPosixPath(filePath);

          const additionalInstructions = typeof req.body.additional_instructions === 'string'
            ? req.body.additional_instructions.trim() || undefined
            : undefined;

          const workspacePath = path.join(os.homedir(), '.rdcli', 'users', String(userId));
          const taskId = getTaskId();

          debug('[Proofread] Creating async task',
            `taskId=${taskId}`,
            `file=${posixPath}`,
          );

          const result = await proofreadService.createProofreadTask({
            user: { userId, username: (user as Record<string, unknown>).username as string || '' },
            filePath: posixPath,
            fileName: req.file.originalname,
            fileSize: req.file.size,
            additionalInstructions,
            sessionId: taskId,
            workspacePath,
          });

          res.json({
            success: true,
            data: {
              task_id: result.taskId,
              status: result.status,
            },
          });
        } catch (error) {
          next(error);
        }
      })();
    });
  });

  /**
   * GET /api/proofread/:taskId
   *
   * Returns the current status and result of an async proofreading task.
   * Rate-limited: at most one query per 10 seconds per task.
   */
  router.get('/:taskId', validateExternalApiKey, (req, res) => {
    const taskId = String(req.params.taskId);
    const { task, allowed } = proofreadService.queryTaskWithRateLimit(taskId);

    if (!task) {
      res.status(404).json({
        success: false,
        error: { code: 'TASK_NOT_FOUND', message: '任务不存在' },
      });
      return;
    }

    if (!allowed) {
      res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: '请至少间隔 10 秒再查询' },
      });
      return;
    }

    // Parse stored JSON fields
    let tokens: Record<string, unknown> | undefined;
    if (task.tokens_json) {
      try {
        tokens = JSON.parse(task.tokens_json);
      } catch { /* keep undefined */ }
    }

    const data: Record<string, unknown> = {
      task_id: task.task_id,
      status: task.status,
      file_name: task.file_name,
      file_size: task.file_size,
      created_at: task.created_at,
      updated_at: task.updated_at,
    };

    if (task.additional_instructions) {
      data.additional_instructions = task.additional_instructions;
    }

    if (task.status === 'completed') {
      data.result_text = task.result_text;
      if (tokens) data.tokens = tokens;
      if (task.session_id) {
        data.session_id = task.session_id;
        data.session_url = proofreadService.getSessionUrl(task.session_id);
      }
    } else if (task.status === 'failed' || task.status === 'cancelled') {
      data.error_message = task.error_message;
    }

    res.json({ success: true, data });
  });

  /**
   * DELETE /api/proofread/:taskId
   *
   * Cancels a pending or processing proofread task. If the task is currently
   * processing, the underlying Claude session is aborted. Only tasks in
   * pending or processing state can be cancelled.
   */
  router.delete('/:taskId', validateExternalApiKey, async (req, res) => {
    const taskId = String(req.params.taskId);

    try {
      const task = await proofreadService.cancelTask(taskId);

      if (!task) {
        // Either already terminal, or never existed.
        res.status(404).json({
          success: false,
          error: {
            code: 'TASK_NOT_FOUND',
            message: '任务不存在或已完成，无法撤销',
          },
        });
        return;
      }

      res.json({
        success: true,
        data: {
          task_id: task.task_id,
          status: task.status,
          updated_at: task.updated_at,
        },
      });
    } catch (error) {
      console.error(
        `[Proofread] Cancel task error for ${taskId}:`,
        error instanceof Error ? error.message : String(error),
      );
      res.status(500).json({
        success: false,
        error: { code: 'CANCEL_FAILED', message: '撤销失败，请稍后重试' },
      });
    }
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