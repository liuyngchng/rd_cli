/**
 * Re-exported helpers that delegate to the centralized pino logger.
 *
 * These exist so existing callers of debug() and log() don't need to
 * change their import path — they automatically route through pino.
 *
 * @deprecated Prefer importing logger directly:
 *   import logger from '@/shared/logger.js';
 */

import logger from '@/shared/logger.js';

/** True when debug-level diagnostics are enabled. */
export function isDebugEnabled(): boolean {
  return logger.level === 'debug';
}

export function debug(...args: unknown[]): void {
  logger.debug(...args);
}

export function log(...args: unknown[]): void {
  logger.info(...args);
}