/**
 * Minimal leveled logging helper.
 *
 * Backend output is otherwise written directly to `console` without a level
 * concept. This adds a single debug channel gated by `RDCLI_LOG_LEVEL` so that
 * startup-time diagnostics (database open, native-module lazy init, module-load
 * timing) can be traced without changing normal `info` output.
 *
 *   RDCLI_LOG_LEVEL=debug   -> emit [DEBUG] lines
 *   unset / anything else   -> only normal console output (unchanged behavior)
 */

const LOG_LEVEL = process.env.RDCLI_LOG_LEVEL || 'info';

/** True when debug-level diagnostics are enabled. */
export function isDebugEnabled(): boolean {
  return LOG_LEVEL === 'debug';
}

/**
 * Emits a [DEBUG]-prefixed line only when `RDCLI_LOG_LEVEL=debug`.
 * Values are spread so callers can pass objects exactly as they would to
 * `console.log`.
 */
export function debug(...args: unknown[]): void {
  if (isDebugEnabled()) {
    console.log('[DEBUG]', ...args);
  }
}
