// @ts-nocheck -- JWT request augmentation is narrowed by Auth route contracts.
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

import { userDb, appConfigDb } from '../database/index.js';
import { isTokenBlacklisted, blacklistToken } from '../security/token-blacklist.js';

const IS_PLATFORM = process.env.VITE_IS_PLATFORM === 'true';

// Use env var if set, otherwise auto-generate a unique secret per installation
const JWT_SECRET = process.env.JWT_SECRET || appConfigDb.getOrCreateJwtSecret();

// ── API Key ──────────────────────────────────────────────────────────────

/**
 * Validates the optional API key header using constant-time comparison to
 * prevent timing side-channel attacks.
 */
const validateApiKey = (req, res, next) => {
  // Skip API key validation if not configured
  if (!process.env.API_KEY) {
    return next();
  }

  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  const expected = process.env.API_KEY;
  const keyBuffer = Buffer.from(apiKey);
  const expectedBuffer = Buffer.from(expected);

  // Constant-time comparison: both buffers must be same length, otherwise
  // timingSafeEqual throws. We pad the shorter buffer to match the longer one
  // so the comparison is always safe and the length difference is not leaked
  // through error timing.
  if (keyBuffer.length !== expectedBuffer.length) {
    // Pad both to the same length to avoid leaking length through timing
    const maxLength = Math.max(keyBuffer.length, expectedBuffer.length);
    const paddedKey = Buffer.alloc(maxLength, 0);
    const paddedExpected = Buffer.alloc(maxLength, 0);
    keyBuffer.copy(paddedKey);
    expectedBuffer.copy(paddedExpected);
    // Intentionally still compare — the result will be false, but timing is uniform
    if (!crypto.timingSafeEqual(paddedKey, paddedExpected)) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
  } else if (!crypto.timingSafeEqual(keyBuffer, expectedBuffer)) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  next();
};

// ── JWT Authentication ───────────────────────────────────────────────────

const authenticateToken = async (req, res, next) => {
  // Platform mode: use single database user.
  // NOTE: In multi-user deployments, PLATFORM mode bypasses JWT auth and
  // binds all traffic to the first user. Platform deployments should set
  // VITE_IS_PLATFORM=false and use normal JWT-based auth for multi-user.
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (!user) {
        return res.status(500).json({ error: 'Platform mode: No user found in database' });
      }
      req.user = user;
      return next();
    } catch (error) {
      console.error('Platform mode error:', error);
      return res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
    }
  }

  // Normal OSS JWT validation
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  // Also check query param for SSE endpoints (EventSource can't set headers).
  // NOTE: Tokens in URLs appear in server logs, proxy logs, and browser
  // history. This is accepted as a necessary trade-off for SSE compatibility
  // but should be replaced with a short-lived one-time token scheme in a
  // future iteration.
  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    res.setHeader('X-Auth-Error', 'invalid-token');
    return res.status(401).json({
      error: 'Access denied. No token provided.',
      code: 'AUTH_TOKEN_INVALID',
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Check if this token has been revoked (logout / admin action).
    if (decoded.jti && isTokenBlacklisted(decoded.jti)) {
      res.setHeader('X-Auth-Error', 'session-expired');
      return res.status(401).json({
        error: 'Session has been revoked. Please log in again.',
        code: 'AUTH_TOKEN_REVOKED',
      });
    }

    // Verify user still exists and is active
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      res.setHeader('X-Auth-Error', 'invalid-token');
      return res.status(401).json({
        error: 'Invalid token. User not found.',
        code: 'AUTH_TOKEN_INVALID',
      });
    }

    // Auto-refresh: if token is past halfway through its lifetime, issue a new one
    if (decoded.exp && decoded.iat) {
      const now = Math.floor(Date.now() / 1000);
      const halfLife = (decoded.exp - decoded.iat) / 2;
      if (now > decoded.iat + halfLife) {
        const newToken = generateToken(user);
        res.setHeader('X-Refreshed-Token', newToken);
      }
    }

    req.user = user;
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.setHeader('X-Auth-Error', 'session-expired');
      return res.status(401).json({
        error: 'Session expired. Please log in again.',
        code: 'AUTH_TOKEN_EXPIRED',
      });
    }

    console.warn(
      'Token verification failed:',
      error instanceof Error ? error.message : String(error),
    );
    res.setHeader('X-Auth-Error', 'invalid-token');
    return res.status(401).json({
      error: 'Invalid token',
      code: 'AUTH_TOKEN_INVALID',
    });
  }
};

// ── Token Generation ─────────────────────────────────────────────────────

/**
 * Generates a JWT with a 24-hour expiry and a unique jti claim.
 * The jti enables server-side revocation (logout / admin disable).
 */
const generateToken = (user) => {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username,
      role: user.role,
    },
    JWT_SECRET,
    {
      expiresIn: '24h',
      jwtid: crypto.randomUUID(),
    },
  );
};

/**
 * Revokes a token by extracting its jti from the Authorization header
 * or query string and adding it to the blacklist.
 */
const revokeToken = (req) => {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return;
  }

  try {
    // Verify the token without checking blacklist (to extract jti).
    const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
    if (decoded.jti && decoded.exp) {
      blacklistToken(decoded.jti, decoded.exp);
    }
  } catch {
    // Token is malformed or already expired — nothing to revoke.
  }
};

// ── WebSocket ────────────────────────────────────────────────────────────

const authenticateWebSocket = (token) => {
  // Platform mode: bypass token validation, return first user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (user) {
        return { id: user.id, userId: user.id, username: user.username };
      }
      return null;
    } catch (error) {
      console.error('Platform mode WebSocket error:', error);
      return null;
    }
  }

  // Normal OSS JWT validation
  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Check blacklist for WebSocket tokens too
    if (decoded.jti && isTokenBlacklisted(decoded.jti)) {
      return null;
    }
    // Verify user actually exists in database (matches REST authenticateToken behavior)
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return null;
    }
    return { userId: user.id, username: user.username };
  } catch (error) {
    if (!(error instanceof jwt.TokenExpiredError)) {
      console.warn(
        'WebSocket token verification failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
    return null;
  }
};

export {
  validateApiKey,
  authenticateToken,
  generateToken,
  revokeToken,
  authenticateWebSocket,
  JWT_SECRET
};