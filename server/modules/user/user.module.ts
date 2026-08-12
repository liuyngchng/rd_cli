import { promises as fsPromises } from 'node:fs';

import spawn from 'cross-spawn';

import { projectsDb, userDb } from '@/modules/database/index.js';

import { createUserRouter } from './user.routes.js';
import { createUserService } from './user.service.js';
import { createUserWorkspaceService, RDCLI_USER_ROOT } from './user-workspace.service.js';

type GitCommandResult = { stdout: string };

function runGit(args: string[]): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { shell: false });
    let stdout = '';
    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout });
        return;
      }
      reject(new Error(`Git command failed with code ${code}`));
    });
  });
}

async function readSystemGitConfig() {
  const [nameResult, emailResult] = await Promise.all([
    runGit(['config', '--global', 'user.name']).catch(() => ({ stdout: '' })),
    runGit(['config', '--global', 'user.email']).catch(() => ({ stdout: '' })),
  ]);
  return {
    git_name: nameResult.stdout.trim() || null,
    git_email: emailResult.stdout.trim() || null,
  };
}

/**
 * Production per-user workspace service: filesystem access, the project-path
 * upsert boundary, and the configured user root are all explicit.
 */
export const userWorkspaceService = createUserWorkspaceService({
  userRootPath: RDCLI_USER_ROOT,
  fileSystem: {
    access: (candidatePath) => fsPromises.access(candidatePath),
    mkdir: (directoryPath, options) => fsPromises.mkdir(directoryPath, options),
    realpath: (candidatePath) => fsPromises.realpath(candidatePath),
    lstat: (candidatePath) => fsPromises.lstat(candidatePath),
    readlink: (candidatePath) => fsPromises.readlink(candidatePath),
  },
  projects: {
    createProjectPath: (projectPath, customProjectName, userId) => projectsDb.createProjectPath(
      projectPath,
      customProjectName,
      userId,
    ),
  },
  logWarn: (message, error) => console.warn(message, error),
});

const userService = createUserService({
  users: {
    getGitConfig: (userId) => userDb.getGitConfig(userId),
    updateGitConfig: (userId, gitName, gitEmail) => userDb.updateGitConfig(
      userId,
      gitName ?? '',
      gitEmail ?? '',
    ),
    completeOnboarding: (userId) => userDb.completeOnboarding(userId),
    hasCompletedOnboarding: (userId) => userDb.hasCompletedOnboarding(userId),
  },
  userWorkspace: {
    ensureUserWorkspaceProject: (userId) => {
      const username = userDb.getUserById(userId)?.username;
      return userWorkspaceService.ensureUserWorkspaceProject(
        userId,
        username ? `${username} 的工作区` : null,
      );
    },
  },
  readSystemGitConfig,
  applyGlobalGitConfig: async (gitName, gitEmail) => {
    await runGit(['config', '--global', 'user.name', gitName]);
    await runGit(['config', '--global', 'user.email', gitEmail]);
  },
  logInfo: (message) => console.log(message),
  logError: (message, error) => console.error(message, error),
});

/** User router assembled for the authenticated server mount. */
export const userRoutes = createUserRouter(userService);
