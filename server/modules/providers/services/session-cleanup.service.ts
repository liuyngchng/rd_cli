import { promises as fs } from 'node:fs';

import { sessionsDb } from '@/modules/database/index.js';
import { SESSION_RETENTION_DAYS } from '@/constants/config.js';

/**
 * How often the cleanup scheduler wakes up to prune expired sessions.
 *
 * The value is intentionally low-frequency: session cleanup is not latency-
 * sensitive, and most deployments have a modest number of sessions. A one-hour
 * interval keeps the event loop quiet while still guaranteeing that a session
 * never lives beyond `retentionDays + 1 hour`.
 */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1_000; // 1 hour

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Removes one file if it exists, silently ignoring `ENOENT`.
 */
async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return;
    }
    console.warn(
      `[session-cleanup] Failed to remove ${filePath}:`,
      (error as Error).message,
    );
  }
}

/**
 * Runs one pass of expired-session cleanup.
 *
 * Steps are ordered so transcript files are removed **before** the database
 * rows that reference them: if the server crashes between steps, the next
 * cleanup pass re-attempts the files (and the DB rows are re-removed).
 *
 * Returns the number of database rows deleted so callers can log the result.
 */
export async function runSessionCleanup(): Promise<number> {
  if (SESSION_RETENTION_DAYS <= 0) {
    return 0;
  }

  // 1. Remove on-disk transcript files for expired sessions.
  const expiredFiles = sessionsDb.listExpiredSessionFiles(SESSION_RETENTION_DAYS);
  for (const row of expiredFiles) {
    await unlinkIfExists(row.jsonl_path);
  }

  // 2. Remove the expired database rows.
  const deleted = sessionsDb.deleteSessionsOlderThan(SESSION_RETENTION_DAYS);

  if (deleted > 0) {
    console.log(
      `[session-cleanup] Removed ${deleted} expired session(s) older than ${SESSION_RETENTION_DAYS} days.`,
    );
  }

  return deleted;
}

/**
 * Starts the periodic session-cleanup scheduler.
 *
 * The first pass runs immediately so a session that expired while the server was
 * offline is cleaned up without waiting for the interval.
 */
export function startSessionCleanupScheduler(): void {
  if (SESSION_RETENTION_DAYS <= 0) {
    console.log('[session-cleanup] Retention is disabled (SESSION_RETENTION_DAYS=0).');
    return;
  }

  // Run once at startup, then every hour.
  void runSessionCleanup();

  cleanupTimer = setInterval(() => {
    void runSessionCleanup();
  }, CLEANUP_INTERVAL_MS);

  if (cleanupTimer && typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
    cleanupTimer.unref();
  }
}

/**
 * Stops the periodic session-cleanup scheduler.
 */
export function stopSessionCleanupScheduler(): void {
  if (cleanupTimer !== null) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}