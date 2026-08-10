# CloudCLI 单用户 → 多用户 改造方案

## 一、背景与目的

### 现状

CloudCLI 当前是严格的**单用户系统**：首次启动时注册一个账号（且只能注册一个），之后所有项目、会话、WebSocket 连接、LLM 运行时状态均为全局共享。

代码层面，在以下位置硬编码了单用户假设：

- `server/modules/auth/auth.service.ts:71` — 注册时抛错 `"User already exists. This is a single-user system."`
- `server/modules/database/schema.ts:89-123` — `projects` 和 `sessions` 表**无 `user_id` 字段**
- `server/modules/websocket/services/websocket-state.service.ts:16` — `connectedClients` 是全局 `Set`，无用户分组
- `server/modules/websocket/services/chat-run-registry.service.ts:63` — `runs` Map 是全局的，所有用户的 AI 运行共池
- `server/modules/providers/list/claude/claude-runtime.provider.js:37-38` — `activeSessions` 和 `pendingToolApprovals` 是模块级全局 Map
- `server/modules/auth/auth.middleware.ts:24-40` — 存在 `IS_PLATFORM` 模式分支，永远绑定第一个用户，多用户模式下会完全破坏隔离
- `users` 表无 `role` 字段；但 `api_keys`、`user_credentials` 等辅助表已有 `user_id` 字段（说明系统部分模块已具备多用户意识，核心表未跟上）
- 所有 provider 运行时（Claude/Codex/Cursor/OpenCode）均为相同模式

### 风险

任何能访问 `localhost:3001` 的人都可以：
- 看到所有项目、所有会话
- 往任意会话发送消息
- 接管正在运行的 AI 对话

### 目标

将系统改造为**支持多用户注册和登录**，实现：
1. 每个用户可以注册独立账号
2. 项目、会话、配置按用户隔离（A 看不到 B 的项目/会话）
3. WebSocket 消息只推送给相关用户
4. LLM 运行时状态按用户隔离
5. 保留一个"管理员"账户，可以管理其他用户

### 约束

- **不能脱离 Claude Code 智能体**：必须继续使用 `@anthropic-ai/claude-agent-sdk`（Node.js only），确保 AI 出活能力和直接用 Claude Code CLI 完全一致
- 前端 API 契约尽量不变
- 已有的数据库迁移模式要延续

---

## 二、改造路径

### 阶段 1：认证层改造（改动量：小）

#### 1.1 允许注册多个用户

**文件** `server/modules/auth/auth.service.ts`

- 删除第 70-74 行的 `hasUsers()` 检查和相关错误抛出
- `register()` 改为接受一个可选的 `isAdmin` 标记（只有管理员能创建新用户）
- 初始化（`needsSetup`）逻辑保留：当 `users` 表为空时，第一个注册的用户自动成为管理员
- 新增 `user_role` 字段到 `users` 表：`admin` / `user`

**users 表新增字段**：

```sql
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
```

#### 1.2 注册路由

**文件** `server/modules/auth/auth.routes.ts`

- `POST /api/auth/register` — 保持现有路由，`needsSetup=true` 时可注册管理员
- 新增 `POST /api/auth/users` — 管理员专用，创建新用户

#### 1.3 状态端点修改

**文件** `server/modules/auth/auth.routes.ts`

- `GET /api/auth/status` 改为：`needsSetup` 仅在 users 表为空时返回 true；新增 `hasUsers: true` 指示登录页应显示登录而非创建表单

#### 1.4 前端 Auth 界面

**文件** `src/components/auth/view/SetupForm.tsx`
- 删除第 88 行 "single-user system" 提示文字
- 新增管理员"创建用户"表单（当 `needsSetup=false` 且当前用户是 admin 时可见）

**文件** `src/components/auth/view/LoginForm.tsx`
- `status` 端点返回 `needsSetup: false, hasUsers: true` 时显示登录界面

**文件** `src/components/auth/context/AuthContext.tsx`
- `AuthUser` 类型增加 `role?: 'admin' | 'user'`

#### 1.5 ⚠️ `IS_PLATFORM` 模式处理

**文件** `server/modules/auth/auth.middleware.ts:24-40`

当前存在一个 `IS_PLATFORM` 模式分支（由 `VITE_IS_PLATFORM` 环境变量控制）：

```javascript
if (IS_PLATFORM) {
  const user = userDb.getFirstUser();  // 永远绑定第一个用户
  req.user = user;
  return next();
}
```

这个分支在 REST 中间件 (`authenticateToken`) 和 WebSocket 认证 (`authenticateWebSocket`) 中**都存在**。如果多用户模式下 `IS_PLATFORM=true`，所有请求和 WebSocket 连接都会绑定到第一个用户，用户隔离全部失效。

**改造方案**：
- **方案 A（推荐）**：多用户模式下，PLATFORM 模式走正常 JWT 认证流程，不再硬编码 `getFirstUser()`。平台部署时通过 API key 或 JWT 来区分用户。
- **方案 B**：如果 PLATFORM 模式仍需保留"免登录"特性，则将 `getFirstUser()` 改为从请求头（如 `X-User-Id`）获取目标用户，仅在管理员内部调用时使用。
- 无论选哪个方案，都需要在阶段 1 就确认并修改，**不能留到后期**。

---

### 阶段 2：数据库 Schema 改造（改动量：中）

#### 2.1 核心表增加 `user_id`

**文件** `server/modules/database/schema.ts`

```sql
-- projects 表加外键
ALTER TABLE projects ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1 
  REFERENCES users(id) ON DELETE CASCADE;

-- sessions 表加外键
ALTER TABLE sessions ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1 
  REFERENCES users(id) ON DELETE CASCADE;
```

- 利用 SQLite 的 `ALTER TABLE ADD COLUMN ... DEFAULT`，所有现有数据默认归属到第一个用户（管理员），无需额外数据迁移脚本
- 新建索引：`CREATE INDEX idx_projects_user_id ON projects(user_id);` 和 `CREATE INDEX idx_sessions_user_id ON sessions(user_id);`

#### 2.2 `ProjectRepositoryRow` 类型

**文件** `src/shared/types.ts`（服务端和前端共享的类型）

```typescript
type ProjectRepositoryRow = {
  // 现有字段...
  user_id: number;  // 新增
};
```

同理 `SessionRepositoryRow`。

---

### 阶段 3：数据仓库层改造（改动量：中）

**文件** `server/modules/database/repositories/projects.db.ts`

所有方法增加 `userId` 参数，并在 SQL 中加 `WHERE user_id = ?`：

| 方法 | 改动 |
|------|------|
| `createProjectPath(path, name)` | → `createProjectPath(userId, path, name)`, INSERT 时写入 `user_id` |
| `getProjectPaths()` | → `getProjectPaths(userId)`, SQL 加 `WHERE user_id = ? AND isArchived = 0` |
| `getProjectById(projectId)` | → `getProjectById(userId, projectId)`, SQL 加 `WHERE user_id = ?` |
| `getArchivedProjectPaths()` | → `getArchivedProjectPaths(userId)` |
| `deleteProjectById(projectId)` | → 加 `WHERE user_id = ?` 防跨用户删除 |
| 所有 update 方法 | → 加 `WHERE user_id = ?` |

同理 `sessions.db.ts` 的所有方法。

#### `users` 仓库新增

**新建** `server/modules/database/repositories/users.admin.ts` 或扩展 `users.ts`

```typescript
listUsers(): UserRow[]
createUser(username, passwordHash, role): UserRow
setUserActive(userId, isActive): void
getUserCount(): number
```

---

### 阶段 4：API 路由层改造（改动量：中）

改动的核心模式：所有路由 handler 从 `req.user.id` 取 `userId`，传给数据层方法。

#### 4.1 项目路由

**文件** `server/modules/projects/projects.routes.ts`

- 所有 handler 增加 `const userId = (req as AuthenticatedRequest).user.id`
- 传递给 `projectsDb.createProjectPath(userId, ...)` 等方法
- `DELETE /api/projects/:id` 加 ownership 校验

#### 4.2 用户管理路由

**新建** `server/modules/auth/user-admin.routes.ts`

```typescript
GET    /api/admin/users        — 列出所有用户（admin only）
POST   /api/admin/users        — 创建用户（admin only）
PUT    /api/admin/users/:id    — 修改用户（active/inactive）
```

用中间件校验 `req.user.role === 'admin'`。

#### 4.3 受影响的其它模块

- `server/modules/file-tree/` — 文件树路径校验需确认项目归属
- `server/modules/worktrees/` — git worktree 操作需确认项目归属
- `server/modules/git/` — 同上
- `server/modules/providers/search/` — 搜索需限定用户可见的 sessions

---

### 阶段 5：WebSocket 层改造（改动量：大 — 核心难点）

#### 5.1 WebSocket 客户端注册按用户分组

**文件** `server/modules/websocket/services/websocket-state.service.ts`

```typescript
// 改造前
export const connectedClients = new Set<RealtimeClientConnection>();

// 改造后
export const connectedClients = new Map<number, Set<RealtimeClientConnection>>();
export const addClient = (userId: number, client: RealtimeClientConnection) => { ... }
export const removeClient = (userId: number, client: RealtimeClientConnection) => { ... }
export const broadcastToUser = (userId: number, payload: string) => { ... }
export const broadcastToAll = (payload: string) => { ... }
```

#### 5.2 消息路由加 ownership 校验

**文件** `server/modules/websocket/services/chat-websocket.service.ts`

- `handleChatSend()` (line 146)：校验 `session.user_id === userId`
- `handleChatAbort()` (line 250)：校验 session 归属
- `handleChatSubscribe()` (line 283)：校验 session 归属
- `handlePermissionResponse()` (line 346)：校验 tool approval 的 session 归属

#### 5.3 Run Registry 按用户隔离

**文件** `server/modules/websocket/services/chat-run-registry.service.ts`

- `runs` Map 保持全局（不冲突 — sessionId 是全局唯一的），但在 `startRun()` 入口处加 ownership 校验
- `broadcastCanonicalSessionUpsert()` (line 65)：从 `broadcastToAll` 改为只发给 session owner

#### 5.4 Process Spawn 用户隔离

**文件** `server/modules/websocket/services/shell-websocket.service.ts`

- `ptySessionsMap` 的 key 从 `${projectPath}_${sessionId}` 改为 `${userId}_${projectPath}_${sessionId}` — 保证不同用户即使访问同一路径也互不干扰
- ⚠️ 需要检查所有使用该 key 的地方（PTY 创建、销毁、查找），全部同步改为新格式，否则会出现 key 不匹配导致"假成功"（创建了但找不到）

---

### 阶段 6：Provider 运行时隔离（改动量：中 — 核心难点）

#### 6.1 Claude 运行时

**文件** `server/modules/providers/list/claude/claude-runtime.provider.js`

`activeSessions` 和 `pendingToolApprovals` 虽然按 `sessionId` key（sessionId 全局唯一），但**不能假定隔离已足够**。必须在入口处加 ownership 校验：

- `queryClaudeSDK()` 入口：校验调用方用户是否拥有该 session，否则用户 A 可以 resume 用户 B 的 session
- `handleAbort()`：同样需要 ownership 校验，防止用户 A 终止用户 B 正在运行的 AI 对话
- `pendingToolApprovals`：不需要额外改动——approval 通过 sessionId 关联到特定 WebSocket 连接，但需要在处理时二次确认 session 归属
- ⚠️ 这是最容易出 bug 的环节——如果 ownership 校验漏掉任何一个入口，跨用户访问就成立了

同理改造文件：
- `server/modules/providers/list/codex/codex-runtime.provider.js`
- `server/modules/providers/list/cursor/cursor-runtime.provider.js`
- `server/modules/providers/list/opencode/opencode-runtime.provider.js`

#### 6.2 Session Watcher（文件系统监听）

**文件** `server/modules/providers/services/sessions-watcher.service.ts`

- `session_upserted` 事件广播前，查找 session 所属的 project → user，只发给对应用户

---

### 阶段 7：前端改造（改动量：中）

#### 7.1 用户管理 UI

**新建** `src/components/admin/view/UserManagement.tsx`

管理员可见的用户列表页，包含：
- 用户列表（用户名、角色、状态、创建时间）
- "创建用户"按钮 → 弹窗输入用户名、密码
- "启用/禁用"开关

#### 7.2 顶部导航加用户信息

- 在侧边栏或顶部栏显示当前用户名
- 添加"退出登录"按钮（调用 AuthContext 的 logout）

#### 7.3 localStorage 配置用户化

当前所有前端配置存储在 localStorage 的扁平 key 中，多用户共用一个浏览器会冲突。改造策略：

**方案 A（最小改动）**：所有 localStorage key 加 `userId` 前缀

```typescript
// 改造前
localStorage.setItem('claude-settings', JSON.stringify(settings));

// 改造后
localStorage.setItem(`${userId}_claude-settings`, JSON.stringify(settings));
```

需要修改的工具函数：
- `src/utils/api.js` → `getAUTH_TOKEN_STORAGE_KEY()` 按 userId 返回
- Settings hooks → 所有 `localStorage.getItem/setItem` 加 userId 命名空间

**方案 B（长期）**：迁移到服务端存储（本次不强制，后续迭代）

#### 7.4 路由

- 现有 `/` 和 `/session/:sessionId` 保持不变
- 管理员额外显示 `/admin/users` 路由

---

### 阶段 8：共享工程 & 验证

#### 8.1 类型补充

**文件** `src/shared/types.ts`

- `AuthUser` 加 `role: 'admin' | 'user'`
- `ProjectRepositoryRow` 加 `user_id: number`

#### 8.2 测试

- 服务端测试 (`server/**/*.test.ts`)：补充多用户场景测试
- 手动验证清单：
  - [ ] 首次启动时创建管理员用户
  - [ ] 管理员创建普通用户
  - [ ] 两个不同用户登录后看到的项目/会话互不可见
  - [ ] WebSocket 消息不跨用户泄漏
  - [ ] 用户 A 不能往用户 B 的会话发消息
  - [ ] 禁用的用户不能登录
  - [ ] 非管理员不能访问 `/api/admin/*` 路由

---

## 三、改动文件清单（按顺序）

```
# 阶段1：认证
server/modules/auth/auth.service.ts          — 删除单用户限制，支持多用户注册
server/modules/auth/auth.routes.ts           — 新增管理员创建用户路由
server/modules/auth/auth.middleware.ts       — 角色校验中间件；⚠️ 处理 IS_PLATFORM 模式
server/modules/database/repositories/users.ts — 新增 listUsers/createUser/setActive
server/modules/database/schema.ts            — users 表加 role 字段（migration）

# 阶段2-3：数据库
server/modules/database/schema.ts            — projects/sessions 表加 user_id
server/modules/database/repositories/projects.db.ts — 所有方法加 userId 参数
server/modules/database/repositories/sessions.db.ts — 所有方法加 userId 参数

# 阶段4：路由
server/modules/projects/projects.routes.ts   — handler 加 ownership
server/modules/file-tree/                    — 文件操作加 ownership（~3 文件）
server/modules/worktrees/                    — 同上
server/modules/websocket/services/chat-websocket.service.ts — ws 消息 ownership 校验

# 阶段5-6：WebSocket & Provider
server/modules/websocket/services/websocket-state.service.ts     — 用户分组
server/modules/websocket/services/chat-run-registry.service.ts   — 定向广播
server/modules/websocket/services/shell-websocket.service.ts     — PTY key 加 userId
server/modules/providers/services/sessions-watcher.service.ts    — 事件定向推送
server/modules/providers/list/claude/claude-runtime.provider.js — 入口 ownership 校验
server/modules/providers/list/*/                                 — 其他 provider 同理

# 阶段7：前端
src/components/auth/view/SetupForm.tsx       — 删除 "single-user" 文案
src/components/auth/view/LoginForm.tsx       — 支持多用户登录
src/components/auth/context/AuthContext.tsx  — AuthUser 加 role
src/components/admin/                        — 新建管理员面板
src/utils/api.js                             — localStorage 用户化
src/components/settings/hooks/               — localStorage 用户化
src/components/sidebar/                      — 显示当前用户 + 退出按钮
src/shared/types.ts                          — 类型补充

# 总计：约 27-33 个文件需要修改
```

## 四、预估工作量

| 阶段 | 内容 | 预计 |
|------|------|:----:|
| 1 | 认证层 | 1-2 天 |
| 2-3 | 数据库 + 仓库层 | 2-3 天 |
| 4 | API 路由层 | 2-3 天 |
| 5 | WebSocket 隔离 | 2-4 天 |
| 6 | Provider 运行时 | 1-2 天 |
| 7 | 前端改造 | 2-3 天 |
| 8 | 测试验证 | 1-2 天 |
| **合计** | | **11-19 天** |

## 五、风险点

1. **WebSocket 消息泄漏**：最危险的 bug 类型——用户 A 收到用户 B 的 AI 回答。`broadcastCanonicalSessionUpsert` 和 `session_upserted` 事件的处理需要特别仔细。
2. **Provider 运行时跨用户访问**：`activeSessions` 按 sessionId key，看似已隔离，但如果 `queryClaudeSDK()` 入口遗漏 ownership 校验，用户 A 可以直接 resume 用户 B 的 session，获取 B 的完整对话历史。这是仅次于 WebSocket 泄漏的第二大风险点。
3. **`IS_PLATFORM` 模式破坏隔离**：`auth.middleware.ts` 中 PLATFORM 模式下所有请求硬编码绑定第一个用户（`getFirstUser()`），REST 和 WebSocket 分支都存在。如果多用户部署时该环境变量未处理，所有隔离全部无效。必须在阶段 1 确认处理方案。
4. **Session Watcher 文件路径映射**：从文件系统路径（如 `~/.claude/projects/-/xxx.jsonl`）反查 project owner，需要确保路径→project→user 的映射可靠。
5. **PTY Key 不一致**：`shell-websocket.service.ts` 中 `ptySessionsMap` 的 key 改为含 `userId` 后，必须确保所有读写该 Map 的地方（创建、查找、销毁）都使用相同格式的新 key，否则出现"创建成功但找不到"的幽灵 bug。
6. **并发冲突**：同一项目被管理员创建后，普通用户想创建相同路径的项目，需要明确的错误提示而非静默失败。
