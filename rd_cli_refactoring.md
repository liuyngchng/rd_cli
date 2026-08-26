# rdCLI Windows 桌面端启动失败 — 重构修复方案

> 目标问题：Windows 打包版（`rdcli-desktop-1.37.0-win-x64`）在用户机器上启动时，
> 本地后端（`dist-server/server/index.js`）无法在 30 秒内就绪，最终被 SIGTERM 终止。

---

## 一、问题现象（来自用户提供的启动日志）

```
[11:20:33] $ D:\Software\claude_app\rdcli-desktop-1.37.0-win-x64\rdCLI.exe ...\dist-server\server\index.js
[11:20:33] runtime: Electron 38.8.6 Node 22.22.0
[11:20:33] cwd: D:\Software\claude_app\rdcli-desktop-1.37.0-win-x64\resources\app
[11:20:33] HOST=127.0.0.1 SERVER_PORT=3001
[11:20:34] Created database directory: C:\Users\DavidSun\.rdcli
[11:21:22] process exited with code null and signal SIGTERM
```

关键点：

- `Created database directory` 之后**没有任何后续输出**，也没有报错信息。
- 进程在 30 秒超时（`SERVER_START_TIMEOUT_MS = 30000`）后被 SIGTERM 终止。
- 正常情况应继续输出 `Database schema applied`、`Web Push notifications configured`、
  `rdCLI Server - Ready` 等日志。

---

## 二、根因定位

### 2.1 主因：`better-sqlite3` 原生模块 ABI 不匹配 / 加载失败

`Created database directory` 是 `dist-server/server/modules/database/connection.js` 第 49 行输出，
紧接着的下一行代码是 `new Database(dbPath)`（第 101 行），即加载 `better-sqlite3` 的
`.node` 原生二进制。日志停在这里，说明加载原生模块时进程静默挂起。

`better-sqlite3` 是原生模块，其 `.node` 二进制与 Node.js 的 ABI（`NODE_MODULE_VERSION`）
强绑定。本项目同时存在两个 Node 运行时：

| 运行时 | Node 版本 | 用途 |
|--------|-----------|------|
| 构建机本机 Node.js | 构建机版本 | `npm install` 时编译原生模块 |
| Electron 38.8.6 内嵌 Node | 22.22.0 | 桌面端实际运行 `dist-server` |

如果 `electron-builder` 的原生模块重建（`electron-rebuild`）没有成功执行，
打包进去的 `better-sqlite3.node` 就是按「构建机 Node ABI」编译的，在 Electron 内嵌
Node 下加载失败/挂起。

### 2.2 加重因素：模块加载阶段即触发数据库连接

项目在**模块顶层（import 时）**就调用 `getConnection()`，导致数据库连接在
`startServer()` 之前、在 import 阶段就执行，错误发生时机早、且难以被 try/catch 捕获：

- `server/modules/auth/auth.module.ts`：
  `const databaseConnection = getConnection();`（编译后 `auth.module.js:11`）
- `server/modules/notifications/vapid-keys.service.ts`：
  `const db = getConnection();`（编译后 `vapid-keys.service.js:5`）

`getConnection()` 内部立即执行 `new Database(dbPath)`，一旦原生模块加载失败，
整个 import 链挂起，后端 HTTP 服务还没监听就死了，桌面端只能等到 30 秒超时。

### 2.3 次因：`bcrypt` v6 是 ESM-only，不能用 `require()`

`server/modules/auth/auth.module.ts` 中：

```js
const require = createRequire(import.meta.url);
const bcrypt = require('bcrypt');  // ❌ bcrypt 6.0.0 是 ESM-only
```

`bcrypt@6.0.0` 只提供 ESM 导出，用 `require()` 加载会抛 `ERR_REQUIRE_ESM`。
（该错误是即时抛错而非挂起，但仍是启动失败的潜在来源之一。）

---

## 三、修复方案

### 3.1 把数据库连接从「模块顶层」改为「懒加载」

目标：不在 import 阶段触发 `better-sqlite3` 加载，让错误延后到真正需要时，
并能被启动流程的 try/catch 捕获、给出明确报错。

#### 改动点 1：`server/modules/notifications/vapid-keys.service.ts`

将顶层的 `const db = getConnection();` 移除，改为在函数内懒加载：

```ts
let db = null;
function getDb() {
  if (!db) db = getConnection();
  return db;
}

function ensureVapidKeys() {
  const db = getDb();
  // ... 其余逻辑不变
}
```

#### 改动点 2：`server/modules/auth/auth.module.ts`

将顶层的 `const databaseConnection = getConnection();` 移除，改为懒加载：

```ts
let databaseConnection = null;
function getDatabaseConnection() {
  if (!databaseConnection) databaseConnection = getConnection();
  return databaseConnection;
}
```

在注入 `transaction` 时改为调用 `getDatabaseConnection()`：

```ts
transaction: {
  begin: () => getDatabaseConnection().prepare('BEGIN').run(),
  commit: () => getDatabaseConnection().prepare('COMMIT').run(),
  rollback: () => getDatabaseConnection().prepare('ROLLBACK').run(),
},
```

> 说明：`initializeDatabase()` 仍在 `startServer()` 里显式调用 `getConnection()`，
> 该处已被 try/catch 包裹，能把失败转换成可读的启动错误，而不是无声挂死。

### 3.2 修复 `bcrypt` 的 ESM 加载方式

`bcrypt@6` 是 ESM-only，应改用顶层静态 import：

```ts
// 删除以下两行：
// const require = createRequire(import.meta.url);
// const bcrypt = require('bcrypt');

// 改为顶层静态 import（项目是 "type": "module"，完全支持）：
import bcrypt from 'bcrypt';
```

同时删除不再需要的 `createRequire` 导入。

### 3.3 确保 `electron-builder` 正确重建原生模块

`better-sqlite3`、`node-pty` 这类原生模块在打包时必须针对 Electron 38 的 ABI 重建。

构建机需要满足：

1. 安装 **Visual Studio Build Tools（含 C++ 工作负载）** 与 **Windows SDK**。
2. 确认 `electron-builder` 在打包时执行了原生模块 rebuild（`electron-rebuild`），
   产物里的 `better-sqlite3.node` 应匹配 Electron 38.8.6（Node 22.22.0）的 ABI。

验证方法（在打包产物目录里）：

```powershell
# 找到打包后的 better-sqlite3.node
Get-ChildItem -Recurse -Filter better_sqlite3.node resources\app\node_modules\better-sqlite3
```

如果 rebuild 一直不稳定，可考虑在 `build-win.ps1` 里显式调用 rebuild：

```powershell
npx electron-rebuild -f -w better-sqlite3,node-pty
```

> 注意：`node-pty` 在 Windows 上还有已知的 SpectreMitigation / MSB8040 编译问题，
> `scripts/release/prepare-desktop-app.js` 已处理（删除 binding.gyp 中的 SpectreMitigation），
> 不要移除这段逻辑。

---

## 四、验证清单

修复后重新打包，在干净 Windows 机器上验证：

- [ ] 启动日志应出现 `Database schema applied`、`Web Push notifications configured`、`rdCLI Server - Ready`
- [ ] 不应再出现「内置后端未在 http://localhost:3001 就绪」的 30 秒超时
- [ ] `better-sqlite3` 能被 Electron 内嵌 Node 正常加载
- [ ] `bcrypt` 不再报 `ERR_REQUIRE_ESM`

---

## 五、相关文件索引

| 文件 | 作用 | 需要改动 |
|------|------|----------|
| `server/modules/auth/auth.module.ts` | 认证模块，顶层连接数据库 + require bcrypt | ✅ 懒加载 + import bcrypt |
| `server/modules/notifications/vapid-keys.service.ts` | Web Push 模块，顶层连接数据库 | ✅ 懒加载 |
| `server/modules/database/connection.js`（编译产物） | `getConnection()` 实现 | 不改，仅观察 |
| `scripts/release/prepare-desktop-app.js` | 打包 stage + node-pty Spectre 处理 | 保留 |
| `scripts/release/build-win.ps1` | Windows 打包脚本 | 可选：加显式 rebuild |