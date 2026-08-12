// userRoutes: used by the server entrypoint to mount protected user-profile endpoints.
export { userRoutes } from './user.module.js';

// userWorkspaceService: production per-user workspace workflows; consumed by the
// server entrypoint, session synchronizers, and other modules' composition roots.
export { userWorkspaceService } from './user.module.js';
export {
  RDCLI_USER_ROOT,
  buildUserWorkspacePath,
  createUserWorkspaceService,
  getUserRootDir,
  getUserWorkspacePath,
  resolveUserIdFromWorkspacePath,
} from './user-workspace.service.js';
export type { UserWorkspaceService } from './user-workspace.service.js';
