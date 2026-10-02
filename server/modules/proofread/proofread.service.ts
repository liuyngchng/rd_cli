import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import type { ProviderRuntimeWriter, ProviderRunFunction } from '@/shared/types.js';
import { appendFilesInputTag } from '@/shared/image-attachments.js';

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

type ProofreadSessionResult = {
  sessionId: string;
  sessionUrl: string;
};

type ProofreadServiceDependencies = {
  queryClaude: ProviderRunFunction;
  getSessionUrl: (sessionId: string) => string;
};

/**
 * Proofread session service.
 *
 * The proofreading behaviour is driven entirely by the docker/CLAUDE.md global
 * instructions (which includes a "文稿校对审读" section). The user message
 * tells Claude which mode (通用文稿 / 党政机关公文) to follow and carries any
 * additional instructions. No custom system prompt is injected — the global
 * CLAUDE.md plus the user message is self-contained.
 */
export function createProofreadService(deps: ProofreadServiceDependencies) {
  const { queryClaude, getSessionUrl } = deps;

  /** Writer that captures the session ID and discards all output (fire-and-forget). */
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

  /** Builds the user message. Claude selects the proofreading standard from CLAUDE.md. */
  function buildUserMessage(
    filePath: string,
    fileName: string,
    additionalInstructions?: string,
  ): string {
    let message = '请校对审读这篇文档。';

    message = appendFilesInputTag(message, [
      { path: filePath, name: fileName },
    ]);

    if (additionalInstructions && additionalInstructions.trim()) {
      message += `\n\n${additionalInstructions.trim()}`;
    }

    return message;
  }

  return {
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

      // Fire-and-forget: the session transcript is written to disk by the SDK
      // and picked up by the session synchronizer for the chat UI.
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
  };
}

export type ProofreadService = ReturnType<typeof createProofreadService>;