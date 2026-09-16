/**
 * Environment Flag: Is Platform
 * Indicates if the app is running in Platform mode (hosted) or OSS mode (self-hosted)
 */
export const IS_PLATFORM = process.env.VITE_IS_PLATFORM === 'true';

/**
 * Number of days after which inactive sessions are automatically deleted.
 *
 * Sessions whose `updated_at` timestamp is older than this many days are
 * permanently removed (DB row + on-disk JSONL transcript file) during periodic
 * cleanup. Set to `0` to disable automatic cleanup entirely.
 *
 * Configurable via `RDCLI_SESSION_RETENTION_DAYS`; defaults to 30.
 */
export const SESSION_RETENTION_DAYS = (() => {
  const raw = process.env.RDCLI_SESSION_RETENTION_DAYS;
  if (raw === undefined || raw === '') return 30;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30;
})();