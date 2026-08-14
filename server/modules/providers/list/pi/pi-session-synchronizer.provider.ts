import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { sessionsDb } from '@/modules/database/index.js';
import { resolveUserIdFromWorkspacePath } from '@/modules/user/user-workspace.service.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import {
  normalizeProviderTimestamp,
  normalizeSessionName,
  readOptionalString,
  readJsonRecord,
} from '@/shared/utils.js';

type PiSessionHeader = {
  id: string;
  cwd: string;
  timestamp: string;
};

/**
 * Session indexer for Pi's JSONL session store (~/.pi/agent/sessions/).
 */
export class PiSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'pi' as const;

  async synchronize(since?: Date): Promise<number> {
    const sessionsDir = this.getSessionsDir();
    if (!fsSync.existsSync(sessionsDir)) return 0;

    let processed = 0;
    try {
      const entries = fsSync.readdirSync(sessionsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const sessionFile = path.join(sessionsDir, entry.name, 'session.jsonl');
        if (!fsSync.existsSync(sessionFile)) continue;

        const header = await this.readHeader(sessionFile);
        if (!header) continue;

        // Filter by `since` if provided
        if (since) {
          const sessionTime = normalizeProviderTimestamp(header.timestamp);
          if (sessionTime && new Date(sessionTime) < since) continue;
        }

        const sessionId = this.upsertSession(header);
        if (sessionId) processed += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[PiProvider] Failed to synchronize sessions:', message);
    }

    return processed;
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    if (path.basename(filePath) !== 'session.jsonl') return null;

    const header = await this.readHeader(filePath);
    if (!header) return null;

    return this.upsertSession(header);
  }

  private getSessionsDir(): string {
    return path.join(os.homedir(), '.pi', 'agent', 'sessions');
  }

  private async readHeader(filePath: string): Promise<PiSessionHeader | null> {
    try {
      const fileStream = createReadStream(filePath, 'utf8');
      const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = readJsonRecord(trimmed);
          if (parsed?.type === 'session') {
            return {
              id: readOptionalString(parsed.id) ?? '',
              cwd: readOptionalString(parsed.cwd) ?? '',
              timestamp: readOptionalString(parsed.timestamp) ?? '',
            };
          }
        } catch {
          return null;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private upsertSession(header: PiSessionHeader): string | null {
    const sessionId = header.id;
    const projectPath = header.cwd;
    if (!sessionId || !projectPath) return null;

    const userId = resolveUserIdFromWorkspacePath(projectPath);
    if (userId === null) return null;

    const fallbackTitle = 'Untitled Pi Session';
    const pendingAppSession = sessionsDb.getSessionByProviderSessionId(sessionId)
      ?? sessionsDb.getSessionById(sessionId)
      ?? sessionsDb.findLatestPendingAppSession(this.provider, projectPath);

    if (pendingAppSession && !pendingAppSession.provider_session_id) {
      sessionsDb.assignProviderSessionId(pendingAppSession.session_id, sessionId);
    }

    const existingSession = sessionsDb.getSessionByProviderSessionId(sessionId)
      ?? sessionsDb.getSessionById(sessionId);
    const existingName = existingSession?.custom_name;

    const isAppCreated =
      existingSession != null &&
      existingSession.provider_session_id != null &&
      existingSession.session_id !== existingSession.provider_session_id;

    let nextName: string | undefined;
    if (existingName && existingName !== fallbackTitle) {
      nextName = existingName;
    } else {
      nextName = undefined;
    }

    return sessionsDb.createSession(
      sessionId,
      this.provider,
      projectPath,
      normalizeSessionName(nextName, fallbackTitle),
      normalizeProviderTimestamp(header.timestamp),
      normalizeProviderTimestamp(header.timestamp),
      null,
      userId,
    );
  }
}