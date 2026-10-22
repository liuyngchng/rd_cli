import crypto from 'node:crypto';

import type { ProviderRunFunction } from '@/shared/types.js';
import { proofreadTasksDb as ProofreadTasksDb } from '@/modules/database/index.js';

import { createProofreadRouter } from './proofread.routes.js';
import { createProofreadService } from './proofread.service.js';

/**
 * Assembled proofread router for the server entrypoint.
 *
 * The provider runtime runner and tasks repository are injected at composition
 * time so the proofread module never imports the provider registry or database
 * directly.
 */
export function createProofreadModule(
  queryClaude: ProviderRunFunction,
  proofreadTasksDb: typeof ProofreadTasksDb,
  abortClaudeSession: (sessionId: string) => Promise<boolean>,
) {
  const baseUrl = process.env.PUBLIC_URL
    || `http://${process.env.HOST || 'localhost'}:${process.env.SERVER_PORT || '3001'}`;

  function getSessionUrl(sessionId: string): string {
    return `${baseUrl}/chat?session=${sessionId}`;
  }

  function getSessionId(): string {
    return `proofread-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  }

  function getTaskId(): string {
    return `pt-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  }

  const proofreadService = createProofreadService({
    queryClaude,
    getSessionUrl,
    proofreadTasksDb,
    abortClaudeSession,
  });

  return createProofreadRouter({
    proofreadService,
    getSessionId,
    getTaskId,
  });
}