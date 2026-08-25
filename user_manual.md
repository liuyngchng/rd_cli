# rdCLI 桌面端用户手册

## 1. 快速开始

1. 解压 `rdcli-desktop-<版本号>-win-x64.zip`
2. 双击 `rdCLI.exe` 启动
3. 如果已配置好 Claude 连接（中转地址 + 密钥），应用会自动启动本地 rdCLI 并进入登录页面

## 2. 配置 Claude 连接

### 2.1 配置方式

rdCLI 桌面端需要连接到 Claude Code 才能使用 AI 功能。国内环境需要通过中转网关访问。

配置方式有三种，优先级从高到低：

| 优先级 | 方式 | 说明 |
|--------|------|------|
| ① | 系统/用户环境变量 | 在 Windows「我的电脑 → 属性 → 高级 → 环境变量」中设置 |
| ② | 启动时传入 | 如 `set ANTHROPIC_API_KEY=xxx && rdCLI.exe` |
| ③ | `resources\app\.env` 文件 | 解压后在 `resources\app\` 目录下创建 `.env` 文件 |

> **推荐方式③**：最简单，解压后复制模板改一下即可。

### 2.2 使用 .env 文件配置（推荐）

解压后在 `resources\app\` 目录下已有一份 `.env.template` 模板文件：

```
1. 复制 resources\app\.env.template → resources\app\.env
2. 用记事本打开 .env，修改以下内容
3. 保存后重启 rdCLI.exe
```

#### 必填项

```ini
# 中转网关地址（必须替换为实际地址）
ANTHROPIC_BASE_URL=https://your-gateway.example.com

# 密钥（API Key 与 Auth Token 二选一）
ANTHROPIC_API_KEY=<YOUR_API_KEY>
```

#### 模型配置（按需修改）

```ini
# 默认模型
ANTHROPIC_MODEL=deepseek-v4-pro

# 各档位模型
ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro
ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-pro
ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash

# 子任务模型（轻量模型可节省 token）
CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash
```

#### 行为配置（按需修改）

```ini
# 推理强度：low | medium | high | xhigh | max
CLAUDE_CODE_EFFORT_LEVEL=max

# API 超时（毫秒），默认 600000（10 分钟）
API_TIMEOUT_MS=600000

# 禁用非必要网络流量（遥测、更新检查等），国内环境建议开启
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# 禁用归因头
CLAUDE_CODE_ATTRIBUTION_HEADER=0
```

### 2.3 完整配置示例

下面是一个国内环境使用中转网关的完整 `.env` 示例：

```ini
ANTHROPIC_BASE_URL=http://127.0.0.1:16001
ANTHROPIC_API_KEY=sk-xxxxxxxxxxxxxxxx

ANTHROPIC_MODEL=deepseek-v4-pro
ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro
ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-pro
ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash
CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash

CLAUDE_CODE_EFFORT_LEVEL=max
API_TIMEOUT_MS=600000
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
CLAUDE_CODE_ATTRIBUTION_HEADER=0
```

> **注意**：`.env` 文件是明文存储，拿到文件的人都能看到密钥。请使用共享/有限额密钥，不要放个人生产密钥。

## 3. 常见问题

### 3.1 启动后提示"无法连接大模型"

检查以下各项：

1. `resources\app\.env` 文件是否存在且配置正确
2. `ANTHROPIC_BASE_URL` 地址是否可访问（可在浏览器中尝试访问）
3. `ANTHROPIC_API_KEY` 是否有效
4. 如果系统环境变量里也设置了同名变量，系统环境变量优先级更高，会覆盖 `.env` 中的值

### 3.2 SmartScreen 提示"未知发布者"

这是未做代码签名的正常现象，点击「更多信息 → 仍要运行」即可。

### 3.3 升级后配置丢失

解压新版 zip 会覆盖 `resources\app\.env`，升级前请自行备份该文件。

### 3.4 查看诊断信息

在 rdCLI 桌面端菜单栏中选择「帮助 → 复制诊断信息」，可将诊断信息复制到剪贴板，方便排查问题。

## 4. 目录结构

解压后的目录结构：

```
rdcli-desktop-<版本号>-win-x64/
├── rdCLI.exe                  # 主程序入口
├── resources/
│   └── app/
│       ├── .env.template      # 配置模板（可参考）
│       ├── .env               # 你的配置文件（自行创建）
│       ├── electron/          # Electron 壳
│       ├── dist-server/       # 后端服务
│       └── node_modules/      # 运行依赖
│   └── ...                    # Electron 框架文件
└── 用户手册.md                 # 本文件
```

## 5. 获取帮助

- 配置问题：参考 `resources\app\.env.template` 文件内的注释说明
- 诊断信息：菜单栏「帮助 → 复制诊断信息」，粘贴给技术支持人员排查问题