import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import express from 'express';
import multer from 'multer';

import { getGlobalImageAssetsDir as getGlobalAssetsDir, toPosixPath } from '@/shared/image-attachments.js';
import { userDb, apiKeysDb } from '@/modules/database/index.js';
import { debug, log } from '@/shared/debug.js';

import type { ProofreadService } from './proofread.service.js';

const IS_PLATFORM = process.env.VITE_IS_PLATFORM === 'true';

const ALLOWED_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

// Also accept browsers that don't know the docx MIME type.
const ALLOWED_EXTENSIONS = new Set(['.docx']);

const CALLBACK_URL_RE = /^https?:\/\/.+/i;

function isAllowedDocx(mimetype: string, filename: string): boolean {
  if (ALLOWED_MIME_TYPES.has(mimetype)) {
    return true;
  }

  const ext = path.extname(filename).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

/** Returns the normalized callback URL string, or undefined if invalid. */
function normalizeCallbackUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!CALLBACK_URL_RE.test(trimmed)) return undefined;
  try {
    const url = new URL(trimmed);
    return url.toString();
  } catch {
    return undefined;
  }
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

  // ── GET /api/proofread — usage help ───────────────────────────────────

  router.get('/', (_req, res) => {
    res.json({
      message: '请使用 POST 方法提交核稿任务',
      example: {
        curl: [
          'curl -X POST <rdcli-host>/api/proofread \\',
          '  -H "x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \\',
          '  -F "file=@文档.docx" \\',
          '  -F "callback_url=https://oa.example.com/api/callback" \\',
          '  -F "additional_instructions=重点检查数据引用"',
        ].join('\n'),
        fields: {
          file: '(必填) Word 文档 .docx，最大 20MB',
          callback_url: '(必填) 核稿完成后回调地址，http:// 或 https://',
          additional_instructions: '(可选) 追加核稿要求',
        },
      },
      links: {
        task_list: 'GET /api/proofread/task — 查看进行中的任务',
        query_task: 'GET /api/proofread/task?id=<taskId> — 查询单个任务状态',
        cancel_task: 'DELETE /api/proofread/task?id=<taskId> — 撤销任务',
        session_mode: 'POST /api/proofread/session — 创建会话跳转',
      },
    });
  });

  // ── GET /api/proofread/task[?id=xxx] ──────────────────────────────────

  router.get('/task', validateExternalApiKey, (req, res) => {
    const taskId = typeof req.query.id === 'string' ? req.query.id.trim() : undefined;

    if (taskId) {
      // ── single task query ──────────────────────────────────────────
      log('[Proofread API] GET /api/proofread/task — request', JSON.stringify({ taskId }));

      const task = proofreadService.getTask(taskId);

      if (!task) {
        log('[Proofread API] GET /api/proofread/task — response',
          JSON.stringify({ taskId, found: false }));
        res.status(404).json({
          success: false,
          error: { code: 'TASK_NOT_FOUND', message: '任务不存在' },
        });
        return;
      }

      let tokens: Record<string, unknown> | undefined;
      if (task.tokens_json) {
        try { tokens = JSON.parse(task.tokens_json); } catch { /* keep undefined */ }
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

      log('[Proofread API] GET /api/proofread/task — response',
        JSON.stringify({ taskId, status: task.status, resultTextLen: task.result_text?.length ?? 0 }));
      res.json({ success: true, data });
      return;
    }

    // ── task list ────────────────────────────────────────────────────
    const userId = getUserId(req);
    if (userId == null) {
      log('[Proofread API] GET /api/proofread/task — request (no userId)');
      res.status(401).json({
        success: false,
        error: { code: 'AUTH_REQUIRED', message: 'Authentication required' },
      });
      return;
    }

    log('[Proofread API] GET /api/proofread/task — request', JSON.stringify({ userId }));

    const tasks = proofreadService.listActiveTasks(userId);

    log('[Proofread API] GET /api/proofread/task — response', JSON.stringify({ count: tasks.length }));
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

  // ── POST /api/proofread — submit async task ───────────────────────────

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
            log('[Proofread API] POST /api/proofread — request (no file)');
            res.status(400).json({
              success: false,
              error: { code: 'MISSING_FILE', message: '请上传 .docx 格式的 Word 文档' },
            });
            return;
          }

          const user = resolveUser(req);
          const userId = getUserId(req);
          if (userId == null) {
            log('[Proofread API] POST /api/proofread — request (no userId)');
            res.status(401).json({
              success: false,
              error: { code: 'AUTH_REQUIRED', message: 'Authentication required' },
            });
            return;
          }

          const assetsDir = getUserProofreadDir(userId);
          const filePath = path.join(assetsDir, req.file.filename);
          const posixPath = toPosixPath(filePath);

          // callback_url is required.
          const callbackUrl = normalizeCallbackUrl(req.body.callback_url);
          if (!callbackUrl) {
            const raw = typeof req.body.callback_url === 'string' ? req.body.callback_url : '';
            const errorCode = raw ? 'INVALID_CALLBACK_URL' : 'MISSING_CALLBACK_URL';
            const errorMessage = raw
              ? 'callback_url 格式不合法，必须以 http:// 或 https:// 开头'
              : '请提供 callback_url 回调地址';
            log('[Proofread API] POST /api/proofread — request error',
              JSON.stringify({ userId, code: errorCode, message: errorMessage }));
            res.status(400).json({ success: false, error: { code: errorCode, message: errorMessage } });
            return;
          }

          const additionalInstructions = typeof req.body.additional_instructions === 'string'
            ? req.body.additional_instructions.trim() || undefined
            : undefined;

          const workspacePath = path.join(os.homedir(), '.rdcli', 'users', String(userId));
          const taskId = getTaskId();

          log('[Proofread API] POST /api/proofread — request',
            JSON.stringify({
              taskId,
              userId,
              fileName: req.file.originalname,
              fileSize: req.file.size,
              callbackUrl,
              additionalInstructions: additionalInstructions ?? null,
            }));

          debug('[Proofread] Creating async task',
            `taskId=${taskId}`,
            `file=${posixPath}`,
            `callbackUrl=${callbackUrl}`,
          );

          const result = await proofreadService.createProofreadTask({
            user: { userId, username: (user as Record<string, unknown>).username as string || '' },
            filePath: posixPath,
            fileName: req.file.originalname,
            fileSize: req.file.size,
            additionalInstructions,
            callbackUrl,
            sessionId: taskId,
            workspacePath,
          });

          log('[Proofread API] POST /api/proofread — response',
            JSON.stringify(result));
          res.json({
            success: true,
            data: { task_id: result.taskId, status: result.status },
          });
        } catch (error) {
          log('[Proofread API] POST /api/proofread — error',
            error instanceof Error ? error.message : String(error));
          next(error);
        }
      })();
    });
  });

  // ── DELETE /api/proofread/task?id=<taskId> ────────────────────────────

  router.delete('/task', validateExternalApiKey, async (req, res) => {
    const taskId = typeof req.query.id === 'string' ? req.query.id.trim() : undefined;
    if (!taskId) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_TASK_ID', message: '请提供 ?id=<taskId> 参数' },
      });
      return;
    }

    log('[Proofread API] DELETE /api/proofread/task — request', JSON.stringify({ taskId }));

    try {
      const task = await proofreadService.cancelTask(taskId);

      if (!task) {
        log('[Proofread API] DELETE /api/proofread/task — response',
          JSON.stringify({ taskId, cancelled: false }));
        res.status(404).json({
          success: false,
          error: { code: 'TASK_NOT_FOUND', message: '任务不存在或已完成，无法撤销' },
        });
        return;
      }

      log('[Proofread API] DELETE /api/proofread/task — response',
        JSON.stringify({ taskId, cancelled: true, status: task.status }));
      res.json({
        success: true,
        data: { task_id: task.task_id, status: task.status, updated_at: task.updated_at },
      });
    } catch (error) {
      log('[Proofread API] DELETE /api/proofread/task — error',
        JSON.stringify({ taskId, error: error instanceof Error ? error.message : String(error) }));
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

  // ── POST /api/proofread/session — chat session ────────────────────────

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
            log('[Proofread API] POST /api/proofread/session — request (no file)');
            res.status(400).json({
              success: false,
              error: { code: 'MISSING_FILE', message: '请上传 .docx 格式的 Word 文档' },
            });
            return;
          }

          const user = resolveUser(req);
          const userId = getUserId(req);
          if (userId == null) {
            log('[Proofread API] POST /api/proofread/session — request (no userId)');
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
          const sessionId = getSessionId();

          log('[Proofread API] POST /api/proofread/session — request',
            JSON.stringify({
              sessionId,
              userId,
              fileName: req.file.originalname,
              fileSize: req.file.size,
              additionalInstructions: additionalInstructions ?? null,
            }));

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

          log('[Proofread API] POST /api/proofread/session — response',
            JSON.stringify(result));
          res.json({
            success: true,
            data: { session_id: result.sessionId, session_url: result.sessionUrl },
          });
        } catch (error) {
          log('[Proofread API] POST /api/proofread/session — error',
            error instanceof Error ? error.message : String(error));
          next(error);
        }
      })();
    });
  });

  return router;
}