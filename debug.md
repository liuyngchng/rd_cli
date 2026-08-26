# rdCLI Windows 桌面端启动失败 — 排查与修复手册

> 问题：打包版 rdCLI 在干净 Windows 机器上启动时，本地后端 30 秒超时，无报错信息。

---

## 一、修复内容

### 1.1 数据库连接改为懒加载

**问题**：`auth.module.ts` 和 `vapid-keys.service.ts` 在模块顶层（import 阶段）立即调用 `getConnection()`，数据库加载失败时错误发生在 `startServer()` 的 try/catch 之外，导致进程静默挂起。

**修改**：

| 文件 | 改动 |
|------|------|
| `server/modules/auth/auth.module.ts` | 顶层 `const databaseConnection = getConnection()` 改为懒加载函数 `getDatabaseConnection()` |
| `server/modules/notifications/vapid-keys.service.ts` | 顶层 `const db = getConnection()` 改为懒加载函数 `getDb()` |

**效果**：数据库连接延迟到 `startServer()` → `initializeDatabase()` / `configureWebPush()` 链路上首次使用时才触发，被 try/catch 包裹，失败时能打印明确的错误信息并 `exit(1)`。

### 1.2 调试日志系统

**新增文件**：`server/shared/debug.ts`

**用法**：在 `resources/app/.env`（或打包前项目根目录 `.env`）中添加：

```ini
RDCLI_LOG_LEVEL=debug
```

重启后启动日志会输出 `[DEBUG]` 开头的详细诊断信息，覆盖以下关键步骤：

| 打点位置 | 内容 |
|----------|------|
| `server/load-env.ts` | `DATABASE_PATH` 最终值 |
| `server/modules/database/connection.ts` | 路径解析 → 目录创建 → 原生模块加载 → schema 初始化 |
| `server/modules/database/init-db.ts` | `getConnection()` 调用 → schema 写入 → migrations 执行 |
| `server/modules/auth/auth.module.ts` | 首次延迟初始化数据库连接 |
| `server/modules/notifications/vapid-keys.service.ts` | 首次延迟初始化数据库连接 |
| `server/index.ts` | 所有模块 import 完成 → `initializeDatabase()` → `configureWebPush()` |

**排查完成后删除或注释该行**（行首加 `#`）即可恢复正常日志。

---

## 二、常见失败场景与对应日志特征

### 场景 A：VC++ 运行库缺失（最可能）

```
[DEBUG] getConnection: creating Database instance (loading better-sqlite3 native binding)
                        ← 卡在这里，没有后续 [DEBUG] 输出
```

**原因**：`better-sqlite3.node` 依赖 `vcruntime140.dll` / `msvcp140.dll`，干净 Windows 机器没有这些 DLL，Node 加载原生模块时静默挂起。

**解决**（二选一）：
1. 用户安装 [Microsoft Visual C++ 2015-2022 Redistributable (x64)](https://aka.ms/vs/17/release/vc_redist.x64.exe)
2. 打包时把所需 DLL 随应用一起分发（见第四节）

### 场景 B：数据库文件权限问题

```
[DEBUG] getConnection: opening database at C:\Users\xxx\.rdcli\auth.db
[DEBUG] getConnection: creating Database instance (loading better-sqlite3 native binding)
                        ← 卡住
```

如果 `C:\Users\xxx\.rdcli\` 目录被杀软实时扫描、OneDrive 重定向、或企业策略限制写入，`new Database()` 可能长时间阻塞。

### 场景 C：正常启动

```
[DEBUG] load-env: DATABASE_PATH = C:\Users\xxx\.rdcli\auth.db
[DEBUG] getConnection: opening database at C:\Users\xxx\.rdcli\auth.db
[DEBUG] getConnection: creating Database instance (loading better-sqlite3 native binding)
[DEBUG] getConnection: Database instance created
[DEBUG] getConnection: app_config table ensured
[DEBUG] startServer: entering try block, all modules imported
[DEBUG] startServer: calling initializeDatabase()
[DEBUG] init-db: calling getConnection()
[DEBUG] init-db: applying schema
Database schema applied
[DEBUG] init-db: running migrations
Database migrations completed successfully
[DEBUG] init-db: complete
[DEBUG] startServer: calling configureWebPush()
[DEBUG] vapid-keys.service: lazy-initializing database connection
Web Push notifications configured
...
rdCLI Server - Ready
```

---

## 三、诊断流程

### 用户侧

1. 如果启动失败，在 `resources/app/.env` 末尾加一行 `RDCLI_LOG_LEVEL=debug`
2. 重启 `rdCLI.exe`，观察启动日志中的 `[DEBUG]` 行
3. 把日志通过菜单栏「帮助 → 复制诊断信息」复制，发给技术支持
4. 排查完成后删除或注释 `RDCLI_LOG_LEVEL=debug`

### 开发者侧

1. 如果 debug 日志卡在 `creating Database instance`，大概率是 VC++ 运行库缺失
2. 也可以让用户直接在 cmd 里直跑后端，绕过 30 秒超时看真实 stderr：

   ```cmd
   cd /d <解压目录>\resources\app
   set ELECTRON_RUN_AS_NODE=1
   ..\..\rdCLI.exe dist-server\server\index.js
   ```

3. 这条命令会直接打印完整错误（`ERR_DLOPEN_FAILED`、缺 DLL 名称等），无需 debug 日志

---

## 四、打包时随带 VC++ 运行库（待实现）

### 思路

`better-sqlite3.node` 和 `node-pty` 的 .node 文件依赖 MSVC 运行时 DLL。打包时把这些 DLL 放到 `resources/app/` 目录下，Node 加载原生模块时会在同目录搜索，无需目标机器预装 VC++ Redistributable。

### 需要确认的信息（在 Windows 构建机上）

1. **DLL 大小和位置**：

   ```powershell
   Get-ChildItem -Path C:\Windows\System32 -Filter "vcruntime*.dll" | Select Name, @{N="KB";E={[math]::Round($_.Length/1KB,1)}}
   Get-ChildItem -Path C:\Windows\System32 -Filter "msvcp*.dll" | Select Name, @{N="KB";E={[math]::Round($_.Length/1KB,1)}}
   ```

2. **`.node` 文件依赖了哪些 DLL**（用 VS 的 dumpbin 或 DependenciesGui.exe）：

   ```powershell
   dumpbin /dependents node_modules\better-sqlite3\build\Release\better_sqlite3.node
   dumpbin /dependents node_modules\node-pty\build\Release\*.node
   ```

3. **预估**：`vcruntime140.dll` ~100KB，`vcruntime140_1.dll` ~50KB，`msvcp140.dll` ~600KB，总共不到 1MB。

### 打包脚本改动方向

在 `scripts/release/prepare-desktop-app.js` 的 `copyDependencyClosure` 之后，增加一步：从系统目录复制所需的 VC++ DLL 到 `resources/app/` 禁区。

---

## 五、相关文件索引

| 文件 | 作用 |
|------|------|
| `server/shared/debug.ts` | 调试日志工具（新增） |
| `server/modules/database/connection.ts` | 数据库连接管理 + debug 打点 |
| `server/modules/database/init-db.ts` | 数据库初始化 + debug 打点 |
| `server/modules/auth/auth.module.ts` | 认证模块，懒加载数据库连接 |
| `server/modules/notifications/vapid-keys.service.ts` | Web Push，懒加载数据库连接 |
| `server/index.ts` | 服务入口 + debug 打点 |
| `server/load-env.ts` | 环境变量加载 + DATABASE_PATH 打点 |
| `electron/localServer.js` | 桌面壳→后端启动管理，超时提示含 debug 引导 |
| `resources/app/.env.template` | 配置模板，含 RDCLI_LOG_LEVEL 注释 |
| `scripts/release/prepare-desktop-app.js` | 桌面端打包 stage 脚本 |
| `scripts/release/build-server-bundle.js` | 服务端打包 + electron-rebuild |

---

## 六、已知不相关的问题

以下曾被提出但经验证**不是**本次启动失败的原因：

- **bcrypt ESM 加载**：`bcrypt@6.0.0` 是标准 CommonJS 模块，当前代码 `createRequire()('bcrypt')` 在 ESM 中加载 CJS 完全正确，不会报 `ERR_REQUIRE_ESM`。
- **better-sqlite3 ABI 不匹配**：同一 zip 包在开发机正常、客户机失败，说明打包产物本身的 ABI 是正确的，问题在环境差异。