import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import {
  buildUserWorkspacePath,
  createUserWorkspaceService,
  resolveUserIdFromWorkspacePath,
} from '../user-workspace.service.js';

const USER_ROOT = '/data/users';
const USER_ID = 7;

function createDependencies(overrides: Record<string, unknown> = {}) {
  return {
    userRootPath: USER_ROOT,
    fileSystem: {
      access: async () => undefined,
      mkdir: async () => undefined,
      realpath: async (candidatePath: string) => candidatePath,
      lstat: async () => ({ isSymbolicLink: () => false }),
      readlink: async () => {
        throw new Error('Unexpected readlink');
      },
    },
    projects: {
      createProjectPath: () => ({ outcome: 'created' }),
    },
    logWarn: () => undefined,
    ...overrides,
  } as Parameters<typeof createUserWorkspaceService>[0];
}

test('buildUserWorkspacePath joins the user root and validates the id segment', () => {
  assert.equal(buildUserWorkspacePath(USER_ROOT, USER_ID), path.join(USER_ROOT, String(USER_ID)));

  for (const invalidId of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => buildUserWorkspacePath(USER_ROOT, invalidId),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_USER_ID',
    );
  }
});

test('resolveUserIdFromWorkspacePath attributes paths under a numeric user directory', () => {
  assert.equal(resolveUserIdFromWorkspacePath('/data/users/7', USER_ROOT), 7);
  assert.equal(resolveUserIdFromWorkspacePath('/data/users/7/sub/deep', USER_ROOT), 7);
  assert.equal(resolveUserIdFromWorkspacePath('/data/users/12', USER_ROOT), 12);
  // Dot segments normalize before comparison, so a traversal that stays
  // inside the user root still attributes the user.
  assert.equal(resolveUserIdFromWorkspacePath('/data/users/../users/7', USER_ROOT), 7);
});

test('resolveUserIdFromWorkspacePath rejects out-of-root and malformed paths', () => {
  assert.equal(resolveUserIdFromWorkspacePath('', USER_ROOT), null);
  assert.equal(resolveUserIdFromWorkspacePath(USER_ROOT, USER_ROOT), null);
  assert.equal(resolveUserIdFromWorkspacePath('/data/users', USER_ROOT), null);
  assert.equal(resolveUserIdFromWorkspacePath('/data/users/7abc', USER_ROOT), null);
  assert.equal(resolveUserIdFromWorkspacePath('/data/users/0', USER_ROOT), null);
  assert.equal(resolveUserIdFromWorkspacePath('/data/users/-3', USER_ROOT), null);
  assert.equal(resolveUserIdFromWorkspacePath('/data/users/7/../../etc', USER_ROOT), null);
  assert.equal(resolveUserIdFromWorkspacePath('/etc/passwd', USER_ROOT), null);
  assert.equal(resolveUserIdFromWorkspacePath('/data/other/7', USER_ROOT), null);
});

test('ensureUserWorkspace creates the directory and returns its path', async () => {
  const created: string[] = [];
  const service = createUserWorkspaceService(createDependencies({
    fileSystem: {
      access: async () => undefined,
      mkdir: async (directoryPath: string) => {
        created.push(directoryPath);
      },
      realpath: async (candidatePath: string) => candidatePath,
      lstat: async () => ({ isSymbolicLink: () => false }),
      readlink: async () => {
        throw new Error('Unexpected readlink');
      },
    },
  }));

  const result = await service.ensureUserWorkspace(USER_ID);

  assert.equal(result, path.join(USER_ROOT, String(USER_ID)));
  assert.deepEqual(created, [path.join(USER_ROOT, String(USER_ID))]);
});

test('ensureUserWorkspaceProject persists the single project row with the user id', async () => {
  const persisted: Array<{ projectPath: string; customName: string | null; userId?: number }> = [];
  const service = createUserWorkspaceService(createDependencies({
    projects: {
      createProjectPath: (projectPath: string, customName: string | null, userId?: number) => {
        persisted.push({ projectPath, customName, userId });
        return { outcome: 'created' };
      },
    },
  }));

  const result = await service.ensureUserWorkspaceProject(USER_ID, 'alice 的工作区');

  assert.equal(result, path.join(USER_ROOT, String(USER_ID)));
  assert.deepEqual(persisted, [{
    projectPath: path.join(USER_ROOT, String(USER_ID)),
    customName: 'alice 的工作区',
    userId: USER_ID,
  }]);
});

test('validatePathWithinUserRoot accepts the user root and its children', async () => {
  const service = createUserWorkspaceService(createDependencies());

  const rootValidation = await service.validatePathWithinUserRoot(USER_ID, path.join(USER_ROOT, '7'));
  assert.equal(rootValidation.valid, true);

  const childValidation = await service.validatePathWithinUserRoot(USER_ID, path.join(USER_ROOT, '7', 'docs'));
  assert.equal(childValidation.valid, true);
});

test('validatePathWithinUserRoot rejects other users and outside paths', async () => {
  const service = createUserWorkspaceService(createDependencies());

  const otherUser = await service.validatePathWithinUserRoot(USER_ID, path.join(USER_ROOT, '8'));
  assert.equal(otherUser.valid, false);

  const outside = await service.validatePathWithinUserRoot(USER_ID, '/etc');
  assert.equal(outside.valid, false);

  const empty = await service.validatePathWithinUserRoot(USER_ID, '');
  assert.equal(empty.valid, false);
});

test('validatePathWithinUserRoot rejects symlink escapes', async () => {
  const service = createUserWorkspaceService(createDependencies({
    fileSystem: {
      access: async () => undefined,
      mkdir: async () => undefined,
      realpath: async (candidatePath: string) => candidatePath,
      lstat: async () => ({ isSymbolicLink: () => true }),
      readlink: async () => '/etc',
    },
  }));

  const validation = await service.validatePathWithinUserRoot(USER_ID, path.join(USER_ROOT, '7', 'link'));
  assert.equal(validation.valid, false);
  assert.match(validation.error ?? '', /Symlink target is outside/);
});
