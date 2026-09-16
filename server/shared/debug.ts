/**
 * Minimal leveled logging helper.
 *
 * Backend output is otherwise written directly to `console` without a level
 * concept. This adds a single debug channel gated by `RDCLI_LOG_LEVEL` so that
 * startup-time diagnostics (database open, native-module lazy init, module-load
 * timing) can be traced without changing normal `info` output.
 *
 *   RDCLI_LOG_LEVEL=debug   -> write [DEBUG] lines to logs/rd_cli_desktop_yyyy_MM_dd.log
 *   unset / anything else   -> no debug output (unchanged behavior)
 *
 * Debug lines are written to a daily-rotated file under `process.cwd()/logs/`
 * rather than stdout so that enabling diagnostics does not pollute the process
 * stdout that container runtimes (`docker logs -f`) and the desktop Electron
 * shell capture.
 */

import fs from 'fs';
import path from 'path';

const LOG_LEVEL = process.env.RDCLI_LOG_LEVEL || 'info';

/** Log directory relative to the process working directory. */
const LOG_DIR = path.join(process.cwd(), 'logs');

/** Daily log file name, e.g. `rc_cli_desktop_2026_09_16.log`. */
function getLogFile(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const MM = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return path.join(LOG_DIR, `rc_cli_desktop_${yyyy}_${MM}_${dd}.log`);
}

/** True when debug-level diagnostics are enabled. */
export function isDebugEnabled(): boolean {
  return LOG_LEVEL === 'debug';
}

function writeLine(line: string): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(getLogFile(), `${line}\n`, 'utf8');
  } catch {
    // Debug logging is best-effort: never let a write failure take down the
    // server (e.g. read-only cwd, missing permissions).
  }
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Appends a `[DEBUG]`-prefixed line to `logs/rc_cli_desktop_yyyy_MM_dd.log`
 * only when `RDCLI_LOG_LEVEL=debug`. Values are spread so callers can pass
 * objects exactly as they would to `console.log`.
 */
export function debug(...args: unknown[]): void {
  if (!isDebugEnabled()) return;

  const timestamp = new Date().toISOString();
  const message = args.map(formatValue).join(' ');
  writeLine(`[DEBUG] ${timestamp} ${message}`);
}
