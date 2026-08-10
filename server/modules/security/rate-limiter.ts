/**
 * Rate limiter factory.
 *
 * Provides pre-configured rate limiters for different route tiers.
 * All limiters use the in-memory store (fine for a single-process local tool).
 */

import rateLimit from 'express-rate-limit';

/** Strict limiter for auth endpoints — blocks brute-force attempts. */
export const strictAuthLimiter = rateLimit({
  windowMs: 60_000,       // 1 minute
  max: 30,                // 30 attempts per window (generous for dev, still blocks brute-force)
  standardHeaders: true,  // Return RateLimit-* headers
  legacyHeaders: false,   // Disable X-RateLimit-* headers
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests. Please try again in a minute.',
    },
  },
  skipSuccessfulRequests: true, // Only count failed attempts against the limit
});

/** General API limiter — protects against DoS. */
export const generalApiLimiter = rateLimit({
  windowMs: 60_000,       // 1 minute
  max: 200,               // 200 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests. Please slow down.',
    },
  },
  skipSuccessfulRequests: false,
});

/**
 * Creates a custom limiter for specific use cases.
 * Use this when neither the strict auth nor general API limits fit.
 */
export function createRateLimiter(
  maxRequests: number,
  windowMinutes: number = 1
) {
  return rateLimit({
    windowMs: windowMinutes * 60_000,
    max: maxRequests,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please try again later.',
      },
    },
  });
}
