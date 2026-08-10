/**
 * JWT token blacklist for logout/revocation.
 *
 * Since this is a single-process local tool (no Redis), we use an
 * in-memory Map with periodic expired-entry cleanup.
 *
 * Tokens are identified by the `jti` (JWT ID) claim. On logout, the
 * token's jti is added here. The authenticate middleware checks this
 * set before accepting a token.
 */

type BlacklistEntry = {
  jti: string;
  expiresAt: number; // epoch seconds
};

const blacklist = new Map<string, BlacklistEntry>();

// Clean up expired entries every 60 seconds.
const CLEANUP_INTERVAL_MS = 60_000;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanupRunning(): void {
  if (cleanupTimer !== null) {
    return;
  }

  cleanupTimer = setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    for (const [jti, entry] of blacklist) {
      if (entry.expiresAt <= now) {
        blacklist.delete(jti);
      }
    }
  }, CLEANUP_INTERVAL_MS);

  // Allow the process to exit even if the timer is still running.
  if (cleanupTimer && 'unref' in cleanupTimer) {
    cleanupTimer.unref();
  }
}

/**
 * Adds a token's jti to the blacklist.
 * The entry auto-expires when the JWT itself would have expired,
 * so the blacklist never grows unboundedly.
 */
export function blacklistToken(jti: string, expiresAt: number): void {
  ensureCleanupRunning();
  blacklist.set(jti, { jti, expiresAt });
}

/**
 * Returns true if the token's jti has been revoked.
 */
export function isTokenBlacklisted(jti: string): boolean {
  return blacklist.has(jti);
}

/**
 * Returns the current size of the blacklist. Useful for diagnostics.
 */
export function getBlacklistSize(): number {
  return blacklist.size;
}
