import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createAuthService } from '../auth.service.js';

type AuthDependencies = Parameters<typeof createAuthService>[0];

function createDependencies(overrides: Partial<AuthDependencies> = {}): AuthDependencies {
  return {
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash, _role?) => ({ id: 1, username, role: 'user' }),
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
      listUsers: () => [],
      setUserActive: () => undefined,
    },
    transaction: {
      begin: () => undefined,
      commit: () => undefined,
      rollback: () => undefined,
    },
    hashPassword: async () => 'hashed-password',
    comparePassword: async () => false,
    generateToken: () => 'signed-token',
    revokeToken: () => undefined,
    userWorkspace: {
      ensureUserWorkspace: async () => undefined,
    },
    logWarn: () => undefined,
    ...overrides,
  };
}

test('register hashes credentials and commits through injected dependencies', async () => {
  const operations: string[] = [];
  const service = createAuthService(createDependencies({
    transaction: {
      begin: () => operations.push('begin'),
      commit: () => operations.push('commit'),
      rollback: () => operations.push('rollback'),
    },
    hashPassword: async (password) => {
      operations.push(`hash:${password}`);
      return 'hash';
    },
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash, _role?) => {
        operations.push(`create:${username}:${passwordHash}`);
        return { id: 1, username, role: 'admin' };
      },
      getUserByUsername: () => undefined,
      updateLastLogin: (userId) => operations.push(`login:${userId}`),
      listUsers: () => [],
      setUserActive: () => undefined,
    },
  }));

  // Password must be >= 10 chars with uppercase, lowercase, and digit.
  const result = await service.register('alice', 'Secret12abc');

  assert.equal(result.token, 'signed-token');
  assert.deepEqual(result.user, { id: 1, username: 'alice', role: 'admin' });
  assert.deepEqual(operations, ['begin', 'hash:Secret12abc', 'create:alice:hash', 'commit', 'login:1']);
});

test('register rejects a password shorter than 10 characters', async () => {
  const service = createAuthService(createDependencies());

  await assert.rejects(
    service.register('alice', 'Short1!'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_PASSWORD_TOO_SHORT',
  );
});

test('register rejects a password without an uppercase letter', async () => {
  const service = createAuthService(createDependencies());

  await assert.rejects(
    service.register('alice', 'alllowercase1'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_PASSWORD_WEAK',
  );
});

test('register rejects a password without a lowercase letter', async () => {
  const service = createAuthService(createDependencies());

  await assert.rejects(
    service.register('alice', 'ALLUPPERCASE1'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_PASSWORD_WEAK',
  );
});

test('register rejects a password without a digit', async () => {
  const service = createAuthService(createDependencies());

  await assert.rejects(
    service.register('alice', 'NoDigitsHere'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_PASSWORD_WEAK',
  );
});

test('login rejects an invalid password without issuing a token', async () => {
  let tokenIssued = false;
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => ({ id: 1, username: 'alice', password_hash: 'hash', role: 'user', is_active: 1 }),
      updateLastLogin: () => undefined,
      listUsers: () => [],
      setUserActive: () => undefined,
    },
    comparePassword: async () => false,
    generateToken: () => {
      tokenIssued = true;
      return 'token';
    },
  }));

  await assert.rejects(
    service.login('alice', 'wrong-password'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVALID_CREDENTIALS',
  );
  assert.equal(tokenIssued, false);
});

test('refreshSession issues a replacement token for the authenticated user', () => {
  let tokenUser: { id: number | bigint; username: string; role: string } | undefined;
  const service = createAuthService(createDependencies({
    generateToken: (user) => {
      tokenUser = user;
      return 'replacement-token';
    },
  }));

  const result = service.refreshSession({ id: 7, username: 'alice', role: 'user' });

  assert.deepEqual(result, { token: 'replacement-token' });
  assert.deepEqual(tokenUser, { id: 7, username: 'alice', role: 'user' });
});

test('logout calls revokeToken with the request object', () => {
  let revokedRequest: unknown = null;
  const service = createAuthService(createDependencies({
    revokeToken: (req) => {
      revokedRequest = req;
    },
  }));

  const mockRequest = { headers: { authorization: 'Bearer some-token' } };
  const result = service.logout(mockRequest);

  assert.deepEqual(result, { success: true, message: 'Logged out successfully' });
  assert.equal(revokedRequest, mockRequest);
});

test('adminSetUserActive prevents self-disable', () => {
  const service = createAuthService(createDependencies());

  assert.throws(
    () => service.adminSetUserActive({ id: 1, username: 'admin', role: 'admin' }, 1, false),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_CANNOT_SELF_DISABLE',
  );
});