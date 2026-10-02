import crypto from 'node:crypto';

import { createProofreadRouter } from './proofread.routes.js';
import { createProofreadService } from './proofread.service.js';
import type { ProviderRunFunction } from '@/shared/types.js';

/**
 * Assembled proofread router for the server entrypoint.
 *
 * The provider runtime runner is injected at composition time so the proofread
 * module never imports the provider registry directly.
 */
export function createProofreadModule(queryClaude: ProviderRunFunction) {
  const baseUrl = process.env.PUBLIC_URL
    || `http://${process.env.HOST || 'localhost'}:${process.env.SERVER_PORT || '3001'}`;

  function getSessionUrl(sessionId: string): string {
    return `${baseUrl}/chat?session=${sessionId}`;
  }

  function getSessionId(): string {
    return `proofread-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  }

  const proofreadService = createProofreadService({
    queryClaude,
    getSessionUrl,
  });

  return createProofreadRouter({
    proofreadService,
    getSessionId,
  });
}