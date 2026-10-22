import type { ProviderRuntimeWriter, ProviderRunFunction } from '@/shared/types.js';
import { appendFilesInputTag } from '@/shared/image-attachments.js';
import { AppError } from '@/shared/utils.js';
import { proofreadTasksDb as ProofreadTasksDb } from '@/modules/database/index.js';
import { debug } from '@/shared/debug.js';

type UserInfo = {
  userId: number;
  username: string;
};

type CreateProofreadSessionInput = {
  user: UserInfo;
  filePath: string;
  fileName: string;
  fileSize: number;
  additionalInstructions?: string;
  sessionId: string;
  workspacePath: string;
};

type CreateProofreadTaskInput = {
  user: UserInfo;
  filePath: string;
  fileName: string;
  fileSize: number;
  additionalInstructions?: string;
  sessionId: string;
  workspacePath: string;
};

type ProofreadSessionResult = {
  sessionId: string;
  sessionUrl: string;
};

type ProofreadTaskResult = {
  taskId: string;
  status: string;
};

type ProofreadServiceDependencies = {
  queryClaude: ProviderRunFunction;
  getSessionUrl: (sessionId: string) => string;
  proofreadTasksDb: typeof ProofreadTasksDb;
  /** Aborts a running Claude session by its session id (which equals the task id). */
  abortClaudeSession: (sessionId: string) => Promise<boolean>;
};

/**
 * Writer that discards all data and merely captures the provider-native session
 * id — used for the fire-and-forget /session endpoint.
 */
class SessionIdCollector implements ProviderRuntimeWriter {
  messages: unknown[] = [];
  sessionId: string | null = null;
  userId: number;

  constructor(userId: number) {
    this.userId = userId;
  }

  send(data: unknown) {
    this.messages.push(data);
    if (!this.sessionId && typeof data === 'object' && data !== null) {
      const record = data as Record<string, unknown>;
      if (typeof record.sessionId === 'string') {
        this.sessionId = record.sessionId;
      }
    }
  }

  setSessionId(sessionId: string) {
    this.sessionId = sessionId;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }
}

/**
 * Writer that collects all stream messages and, when queried post-run, extracts
 * the complete assistant response as Markdown text plus token-usage statistics.
 */
class ProofreadResultCollector implements ProviderRuntimeWriter {
  messages: unknown[] = [];
  sessionId: string | null = null;
  userId: number;

  constructor(userId: number) {
    this.userId = userId;
  }

  send(data: unknown) {
    this.messages.push(data);
    if (!this.sessionId && typeof data === 'object' && data !== null) {
      const record = data as Record<string, unknown>;
      if (typeof record.sessionId === 'string') {
        this.sessionId = record.sessionId;
      }
    }
  }

  setSessionId(sessionId: string) {
    this.sessionId = sessionId;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  /** Extracts the concatenated assistant text blocks. */
  getResultText(): string {
    const parts: string[] = [];
    for (const msg of this.messages) {
      if (!msg || typeof msg !== 'object') continue;
      const m = msg as Record<string, unknown>;
      // The SDK normalizes assistant messages; text blocks arrive flat.
      if (m.type === 'assistant' && m.message && typeof m.message === 'object') {
        const body = m.message as Record<string, unknown>;
        const content = body.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
              const text = (block as Record<string, unknown>).text;
              if (typeof text === 'string') parts.push(text);
            }
          }
        } else if (typeof content === 'string') {
          parts.push(content);
        }
      }
    }
    return parts.join('\n\n');
  }

  /** Computes total input / output token counts from stream usage data. */
  getTokenSummary(): Record<string, number> {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;

    for (const msg of this.messages) {
      if (!msg || typeof msg !== 'object') continue;
      const m = msg as Record<string, unknown>;
      const usage =
        (m.message as Record<string, unknown>)?.usage ||
        m.usage;
      if (usage && typeof usage === 'object') {
        const u = usage as Record<string, unknown>;
        inputTokens += Number(u.input_tokens ?? u.inputTokens ?? 0);
        outputTokens += Number(u.output_tokens ?? u.outputTokens ?? 0);
        cacheReadTokens += Number(u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? 0);
        cacheCreationTokens += Number(u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? 0);
      }
    }

    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalTokens: inputTokens + outputTokens,
    };
  }
}

/** Builds the user message for proofreading. Claude selects the standard from CLAUDE.md. */
function buildUserMessage(
  filePath: string,
  fileName: string,
  additionalInstructions?: string,
  includeMarkdownHint?: boolean,
): string {
  let message = '请校对审读这篇文档。';

  message = appendFilesInputTag(message, [
    { path: filePath, name: fileName },
  ]);

  if (includeMarkdownHint) {
    message += '\n\n请以 Markdown 格式输出审核意见。';
  }

  if (additionalInstructions && additionalInstructions.trim()) {
    message += `\n\n${additionalInstructions.trim()}`;
  }

  return message;
}

/** Maximum number of processing tasks allowed per user. */
const MAX_PROCESSING_TASKS = 5;

export function createProofreadService(deps: ProofreadServiceDependencies) {
  const { queryClaude, getSessionUrl, proofreadTasksDb, abortClaudeSession } = deps;

  return {
    // ── Session mode (existing, fire-and-forget) ──────────────────────────

    async createProofreadSession(
      input: CreateProofreadSessionInput,
    ): Promise<ProofreadSessionResult> {
      const {
        user,
        filePath,
        fileName,
        fileSize: _fileSize,
        additionalInstructions,
        sessionId,
        workspacePath,
      } = input;

      const userMessage = buildUserMessage(filePath, fileName, additionalInstructions);

      const writer = new SessionIdCollector(user.userId);
      writer.setSessionId(sessionId);

      queryClaude(
        userMessage,
        {
          sessionId,
          cwd: workspacePath,
          projectPath: workspacePath,
          permissionMode: 'bypassPermissions',
          sessionSummary: `核稿: ${fileName}`,
        },
        writer,
      ).catch((error: unknown) => {
        console.error(
          `[Proofread] Background Claude run failed for session ${sessionId}:`,
          error instanceof Error ? error.message : String(error),
        );
      });

      return {
        sessionId,
        sessionUrl: getSessionUrl(sessionId),
      };
    },

    // ── Async task mode (new) ─────────────────────────────────────────────

    /** Creates an async proofread task. Returns immediately with taskId. */
    async createProofreadTask(
      input: CreateProofreadTaskInput,
    ): Promise<ProofreadTaskResult> {
      const {
        user,
        filePath,
        fileName,
        fileSize,
        additionalInstructions,
        sessionId,
        workspacePath,
      } = input;

      // Enforce per-user concurrency limit.
      const processingCount = proofreadTasksDb.countProcessingByUser(user.userId);
      if (processingCount >= MAX_PROCESSING_TASKS) {
        throw new AppError(
          `同时处理的核稿任务已达上限（${MAX_PROCESSING_TASKS} 个），请等待已有任务完成后重试。`,
          { code: 'TOO_MANY_TASKS', statusCode: 429 },
        );
      }

      const task = proofreadTasksDb.createTask({
        taskId: sessionId,
        userId: user.userId,
        fileName,
        fileSize,
        additionalInstructions,
      });

      debug('[Proofread] Task created', `taskId=${task.task_id}`);

      // Kick off background processing — intentionally not awaited.
      this.executeProofreadTask(sessionId, {
        user,
        filePath,
        fileName,
        additionalInstructions,
        sessionId,
        workspacePath,
      }).catch((error: unknown) => {
        console.error(
          `[Proofread] Task execution failed for ${sessionId}:`,
          error instanceof Error ? error.message : String(error),
        );
        // If setFailed wasn't called inside executeProofreadTask, set it now.
        const current = proofreadTasksDb.getTask(sessionId);
        if (current && current.status === 'processing') {
          proofreadTasksDb.setFailed(
            sessionId,
            error instanceof Error ? error.message : String(error),
          );
        }
      });

      return {
        taskId: task.task_id,
        status: task.status,
      };
    },

    /** Background execution: marks task processing, runs Claude, stores result. */
    async executeProofreadTask(
      taskId: string,
      input: {
        user: UserInfo;
        filePath: string;
        fileName: string;
        additionalInstructions?: string;
        sessionId: string;
        workspacePath: string;
      },
    ): Promise<void> {
      const { user, filePath, fileName, additionalInstructions, sessionId, workspacePath } = input;

      // Atomically transition pending → processing. If the task was cancelled
      // while still pending, this returns false and we skip the Claude run.
      const started = proofreadTasksDb.startProcessing(taskId);
      if (!started) {
        debug('[Proofread] Task no longer pending, skipping execution', `taskId=${taskId}`);
        return;
      }
      debug('[Proofread] Task processing started', `taskId=${taskId}`);

      // Include Markdown hint so Claude outputs structured, parseable results.
      const userMessage = buildUserMessage(filePath, fileName, additionalInstructions, true);

      const writer = new ProofreadResultCollector(user.userId);
      writer.setSessionId(sessionId);

      try {
        await queryClaude(
          userMessage,
          {
            sessionId,
            cwd: workspacePath,
            projectPath: workspacePath,
            permissionMode: 'bypassPermissions',
            sessionSummary: `核稿: ${fileName}`,
          },
          writer,
        );

        // Guard: if the task was cancelled while Claude was running, the abort
        // handler already set the status to cancelled — don't overwrite it.
        const current = proofreadTasksDb.getTask(taskId);
        if (current && current.status === 'cancelled') {
          debug('[Proofread] Task was cancelled, discarding completed result', `taskId=${taskId}`);
          return;
        }

        const resultText = writer.getResultText();
        const tokens = writer.getTokenSummary();
        const capturedSessionId = writer.getSessionId() || sessionId;

        proofreadTasksDb.setCompleted(taskId, resultText, tokens, capturedSessionId);
        debug('[Proofread] Task completed', `taskId=${taskId}`, `tokens=${tokens.totalTokens}`);
      } catch (error: unknown) {
        // Guard: also check here in case abort interrupted during error handling.
        const current = proofreadTasksDb.getTask(taskId);
        if (current && current.status === 'cancelled') {
          debug('[Proofread] Task was cancelled, discarding error result', `taskId=${taskId}`);
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        const capturedSessionId = writer.getSessionId() || sessionId;
        proofreadTasksDb.setFailed(taskId, message, capturedSessionId);
        debug('[Proofread] Task failed', `taskId=${taskId}`, `error=${message}`);
      }
    },

    /** Queries a task by id. */
    getTask(taskId: string) {
      return proofreadTasksDb.getTask(taskId);
    },

    /**
     * Rate-limited task query. Returns the task only if the last query was
     * ≥10s ago; otherwise returns the current status with a retry-after hint
     * so the route can send a 429 response.
     */
    queryTaskWithRateLimit(taskId: string) {
      const task = proofreadTasksDb.getTask(taskId);
      if (!task) return { task: null, allowed: false };

      const allowed = proofreadTasksDb.tryRecordQuery(taskId);
      return { task, allowed };
    },

    /**
     * Cancels a proofread task. If the task is processing, the underlying
     * Claude session is aborted. Only pending and processing tasks can be
     * cancelled.
     *
     * Returns the task row on success, or undefined if the task does not exist
     * or is already in a terminal state.
     */
    async cancelTask(taskId: string) {
      const task = proofreadTasksDb.getTask(taskId);
      if (!task) return undefined;

      // Abort the Claude session if it's currently running.
      // The task id IS the session id passed to queryClaude, so the SDK's
      // activeSessions map will have it under that key once processing starts.
      if (task.status === 'processing') {
        await abortClaudeSession(taskId);
      }

      const cancelled = proofreadTasksDb.cancelTask(taskId);
      if (!cancelled) return undefined; // already terminal

      return proofreadTasksDb.getTask(taskId);
    },

    /**
     * Lists active (pending/processing) tasks for a user, most recent first.
     */
    listActiveTasks(userId: number) {
      return proofreadTasksDb.listByUser(userId, {
        statuses: ['pending', 'processing'],
        limit: 50,
      });
    },

    getSessionUrl,
  };
}

export type ProofreadService = ReturnType<typeof createProofreadService>;